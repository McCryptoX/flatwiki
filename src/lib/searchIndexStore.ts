import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { WikiPageSummary } from "../types.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fileStore.js";
import { getPage, listPages } from "./wikiStore.js";

export interface SearchIndexPageEntry extends WikiPageSummary {
  searchableText: string;
  updatedAtMs: number;
}

interface SearchIndexFile {
  version: number;
  generatedAt: string;
  totalPages: number;
  pages: SearchIndexPageEntry[];
}

type SearchIndexBuildPhase = "idle" | "scanning" | "building" | "writing" | "done" | "error";

export interface SearchIndexBuildStatus {
  running: boolean;
  phase: SearchIndexBuildPhase;
  message: string;
  startedAt?: string;
  finishedAt?: string;
  total: number;
  processed: number;
  percent: number;
  error?: string;
  indexFile: string;
}

export interface SearchIndexInfo {
  exists: boolean;
  indexFile: string;
  version: number;
  generatedAt?: string;
  totalPages: number;
  fileSizeBytes: number;
}

const INDEX_VERSION = 2;

const defaultStatus = (): SearchIndexBuildStatus => ({
  running: false,
  phase: "idle",
  message: "Bereit",
  total: 0,
  processed: 0,
  percent: 0,
  indexFile: path.relative(config.rootDir, config.searchIndexFile)
});

let buildStatus: SearchIndexBuildStatus = defaultStatus();
let buildPromise: Promise<void> | null = null;

const toSafeTimestamp = (value: string): number => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const toSearchableText = (summary: WikiPageSummary, content: string): string =>
  `${summary.title}\n${summary.tags.join(" ")}\n${summary.excerpt}\n${content}`.toLowerCase().replace(/\s+/g, " ").trim();

const createIndexDocument = async (): Promise<SearchIndexFile> => {
  const pages = await listPages({ forceFileScan: true });

  buildStatus = {
    ...buildStatus,
    phase: "building",
    message: pages.length > 0 ? "Artikel werden indiziert..." : "Keine Artikel gefunden.",
    total: pages.length,
    processed: 0,
    percent: pages.length > 0 ? 0 : 100
  };

  const indexedPages: SearchIndexPageEntry[] = [];

  for (const pageSummary of pages) {
    const fullPage = await getPage(pageSummary.slug);
    const content = fullPage && (!fullPage.encrypted || fullPage.encryptionState === "ok") ? fullPage.content : "";

    indexedPages.push({
      ...pageSummary,
      searchableText: toSearchableText(pageSummary, content),
      updatedAtMs: toSafeTimestamp(pageSummary.updatedAt)
    });

    const processed = indexedPages.length;
    const total = pages.length;
    const percent = total > 0 ? Math.round((processed / total) * 100) : 100;

    buildStatus = {
      ...buildStatus,
      processed,
      total,
      percent,
      message: total > 0 ? `${processed}/${total} Artikel indiziert` : "Keine Artikel gefunden."
    };
  }

  indexedPages.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    totalPages: indexedPages.length,
    pages: indexedPages
  };
};

const runSearchIndexRebuild = async (): Promise<void> => {
  buildStatus = {
    ...defaultStatus(),
    running: true,
    startedAt: new Date().toISOString(),
    phase: "scanning",
    message: "Artikel werden gelesen..."
  };

  try {
    const document = await createIndexDocument();

    buildStatus = {
      ...buildStatus,
      phase: "writing",
      message: "Index-Datei wird gespeichert...",
      percent: 100
    };

    await ensureDir(path.dirname(config.searchIndexFile));
    await writeJsonFile(config.searchIndexFile, document);

    buildStatus = {
      ...buildStatus,
      running: false,
      phase: "done",
      message: `Index erfolgreich erstellt (${document.totalPages} Artikel).`,
      processed: document.totalPages,
      total: document.totalPages,
      percent: 100,
      finishedAt: new Date().toISOString()
    };
  } catch (error) {
    buildStatus = {
      ...buildStatus,
      running: false,
      phase: "error",
      message: "Index-Erstellung fehlgeschlagen.",
      error: error instanceof Error ? error.message : "Unbekannter Fehler",
      finishedAt: new Date().toISOString()
    };
  }
};

export const getSearchIndexBuildStatus = (): SearchIndexBuildStatus => ({ ...buildStatus });

export const startSearchIndexRebuild = (): { started: boolean; status: SearchIndexBuildStatus; reason?: string } => {
  if (buildPromise) {
    return {
      started: false,
      reason: "Ein Rebuild läuft bereits.",
      status: getSearchIndexBuildStatus()
    };
  }

  buildPromise = runSearchIndexRebuild().finally(() => {
    buildPromise = null;
  });

  return {
    started: true,
    status: getSearchIndexBuildStatus()
  };
};

export const getSearchIndexInfo = async (): Promise<SearchIndexInfo> => {
  const indexFile = path.relative(config.rootDir, config.searchIndexFile);
  let fileSizeBytes = 0;

  try {
    const stats = await fs.stat(config.searchIndexFile);
    fileSizeBytes = stats.size;
  } catch {
    return {
      exists: false,
      indexFile,
      version: INDEX_VERSION,
      totalPages: 0,
      fileSizeBytes: 0
    };
  }

  const fallback: SearchIndexFile = {
    version: INDEX_VERSION,
    generatedAt: "",
    totalPages: 0,
    pages: []
  };
  const parsed = await readJsonFile<SearchIndexFile>(config.searchIndexFile, fallback);
  const generatedAt =
    typeof parsed.generatedAt === "string" && parsed.generatedAt.trim().length > 0 ? parsed.generatedAt : null;

  return {
    exists: true,
    indexFile,
    version: Number.isFinite(parsed.version) ? parsed.version : INDEX_VERSION,
    totalPages: Array.isArray(parsed.pages) ? parsed.pages.length : 0,
    fileSizeBytes,
    ...(generatedAt ? { generatedAt } : {})
  };
};
