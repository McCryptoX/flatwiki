import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { WikiPage, WikiPageSummary } from "../types.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fileStore.js";
import { getIndexBackend } from "./runtimeSettingsStore.js";
import {
  getSqliteIndexInfo,
  readSqliteIndexEntries,
  removeSqliteIndexEntry,
  replaceSqliteIndexEntries,
  upsertSqliteIndexEntry
} from "./sqliteIndexStore.js";
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

const isSqliteBackend = (): boolean => getIndexBackend() === "sqlite";

const getPrimaryIndexFile = (): string => (isSqliteBackend() ? config.sqliteIndexFile : config.searchIndexFile);

const defaultStatus = (): SearchIndexBuildStatus => ({
  running: false,
  phase: "idle",
  message: "Bereit",
  total: 0,
  processed: 0,
  percent: 0,
  indexFile: path.relative(config.rootDir, getPrimaryIndexFile())
});

let buildStatus: SearchIndexBuildStatus = defaultStatus();
let buildPromise: Promise<void> | null = null;

const cleanTextExcerpt = (markdown: string): string =>
  markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[#>*_[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const emptyIndexFile = (): SearchIndexFile => ({
  version: INDEX_VERSION,
  generatedAt: "",
  totalPages: 0,
  pages: []
});

const normalizeIndexEntry = (entry: SearchIndexPageEntry): SearchIndexPageEntry => ({
  ...entry,
  slug: String(entry.slug ?? "").trim().toLowerCase(),
  title: String(entry.title ?? "").trim(),
  categoryId: String(entry.categoryId ?? "").trim(),
  categoryName: String(entry.categoryName ?? "").trim(),
  visibility: entry.visibility === "restricted" ? "restricted" : "all",
  allowedUsers: Array.isArray(entry.allowedUsers)
    ? entry.allowedUsers.map((value) => String(value).trim().toLowerCase()).filter((value) => value.length > 0)
    : [],
  encrypted: entry.encrypted === true,
  tags: Array.isArray(entry.tags) ? entry.tags.map((value) => String(value).trim().toLowerCase()).filter(Boolean) : [],
  excerpt: String(entry.excerpt ?? "").trim(),
  updatedAt: String(entry.updatedAt ?? "").trim(),
  searchableText: String(entry.searchableText ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
  updatedAtMs: Number.isFinite(entry.updatedAtMs) ? entry.updatedAtMs : toSafeTimestamp(String(entry.updatedAt ?? ""))
});

const readSearchIndexFile = async (): Promise<SearchIndexFile> => {
  const parsed = await readJsonFile<SearchIndexFile>(config.searchIndexFile, emptyIndexFile());
  const pages = Array.isArray(parsed.pages) ? parsed.pages.map((entry) => normalizeIndexEntry(entry)) : [];
  return {
    version: Number.isFinite(parsed.version) ? parsed.version : INDEX_VERSION,
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    totalPages: pages.length,
    pages
  };
};

const buildEntrySignature = (
  entry: Pick<
    WikiPageSummary,
    "slug" | "title" | "categoryId" | "categoryName" | "visibility" | "allowedUsers" | "encrypted" | "tags" | "excerpt" | "updatedAt"
  >
): string => {
  const allowedUsers = [...entry.allowedUsers].map((value) => value.trim().toLowerCase()).sort().join(",");
  const tags = [...entry.tags].map((value) => value.trim().toLowerCase()).sort().join(",");
  return [
    entry.slug.trim().toLowerCase(),
    entry.title.trim(),
    entry.categoryId.trim(),
    entry.categoryName.trim(),
    entry.visibility,
    allowedUsers,
    entry.encrypted ? "1" : "0",
    tags,
    entry.excerpt.trim(),
    entry.updatedAt.trim()
  ].join("|");
};

const toSafeTimestamp = (value: string): number => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const toSearchableText = (summary: WikiPageSummary, content: string): string =>
  `${summary.title}\n${summary.tags.join(" ")}\n${summary.excerpt}\n${content}`.toLowerCase().replace(/\s+/g, " ").trim();

const buildIndexEntryFromPage = (page: WikiPage): SearchIndexPageEntry => {
  const excerpt = page.encrypted && page.encryptionState !== "ok" ? "Verschlüsselter Inhalt" : cleanTextExcerpt(page.content).slice(0, 220);
  const summary: WikiPageSummary = {
    slug: page.slug,
    title: page.title,
    categoryId: page.categoryId,
    categoryName: page.categoryName,
    visibility: page.visibility,
    allowedUsers: page.allowedUsers,
    encrypted: page.encrypted,
    tags: page.tags,
    excerpt,
    updatedAt: page.updatedAt
  };

  const content = page.encrypted && page.encryptionState !== "ok" ? "" : page.content;
  return {
    ...summary,
    searchableText: toSearchableText(summary, content),
    updatedAtMs: toSafeTimestamp(summary.updatedAt)
  };
};

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
    if (fullPage) {
      indexedPages.push(buildIndexEntryFromPage(fullPage));
    } else {
      indexedPages.push({
        ...pageSummary,
        searchableText: toSearchableText(pageSummary, ""),
        updatedAtMs: toSafeTimestamp(pageSummary.updatedAt)
      });
    }

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
      message: isSqliteBackend() ? "Suchindex wird gespeichert (SQLite + Fallback)..." : "Index-Datei wird gespeichert...",
      percent: 100
    };

    let sqliteStored = false;
    if (isSqliteBackend()) {
      sqliteStored = await replaceSqliteIndexEntries(document.pages, {
        version: INDEX_VERSION,
        generatedAt: document.generatedAt
      });
    }

    await ensureDir(path.dirname(config.searchIndexFile));
    await writeJsonFile(config.searchIndexFile, document);

    const backendLabel = isSqliteBackend()
      ? sqliteStored
        ? "SQLite + Flat-Fallback"
        : "Flat-Fallback (SQLite nicht verfügbar)"
      : "Flat-Datei";

    buildStatus = {
      ...buildStatus,
      running: false,
      phase: "done",
      message: `Index erfolgreich erstellt (${document.totalPages} Artikel, Backend: ${backendLabel}).`,
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

export const getSearchIndexBuildStatus = (): SearchIndexBuildStatus => ({
  ...buildStatus,
  indexFile: path.relative(config.rootDir, getPrimaryIndexFile())
});

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
  if (isSqliteBackend()) {
    const sqliteInfo = await getSqliteIndexInfo();
    if (sqliteInfo) {
      return {
        exists: sqliteInfo.exists,
        indexFile: sqliteInfo.indexFile,
        version: sqliteInfo.version || INDEX_VERSION,
        totalPages: sqliteInfo.totalPages,
        fileSizeBytes: sqliteInfo.fileSizeBytes,
        ...(sqliteInfo.generatedAt ? { generatedAt: sqliteInfo.generatedAt } : {})
      };
    }
  }

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

const writeSearchIndexDocument = async (pages: SearchIndexPageEntry[], generatedAt = new Date().toISOString()): Promise<void> => {
  const normalizedPages = pages.map((entry) => normalizeIndexEntry(entry)).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  const document: SearchIndexFile = {
    version: INDEX_VERSION,
    generatedAt,
    totalPages: normalizedPages.length,
    pages: normalizedPages
  };

  await ensureDir(path.dirname(config.searchIndexFile));
  await writeJsonFile(config.searchIndexFile, document);
};

const checkSearchIndexExistsFlat = async (): Promise<boolean> => {
  try {
    await fs.access(config.searchIndexFile);
    return true;
  } catch {
    return false;
  }
};

const upsertSearchIndexBySlugFlat = async (slug: string): Promise<{ updated: boolean; reason?: string }> => {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) {
    return {
      updated: false,
      reason: "invalid_slug"
    };
  }

  const page = await getPage(normalizedSlug);
  if (!page) {
    return removeSearchIndexBySlugFlat(normalizedSlug);
  }

  const current = await readSearchIndexFile();
  const filtered = current.pages.filter((entry) => entry.slug !== normalizedSlug);
  filtered.push(buildIndexEntryFromPage(page));

  await writeSearchIndexDocument(filtered);
  return {
    updated: true
  };
};

const removeSearchIndexBySlugFlat = async (slug: string): Promise<{ updated: boolean; reason?: string }> => {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) {
    return {
      updated: false,
      reason: "invalid_slug"
    };
  }

  const exists = await checkSearchIndexExistsFlat();
  if (!exists) {
    return {
      updated: false,
      reason: "index_missing"
    };
  }

  const current = await readSearchIndexFile();
  const filtered = current.pages.filter((entry) => entry.slug !== normalizedSlug);
  if (filtered.length === current.pages.length) {
    return {
      updated: false,
      reason: "entry_missing"
    };
  }

  await writeSearchIndexDocument(filtered);
  return {
    updated: true
  };
};

const getConsistencyReasonFromEntries = (
  pages: WikiPageSummary[],
  entries: Array<
    Pick<
      WikiPageSummary,
      "slug" | "title" | "categoryId" | "categoryName" | "visibility" | "allowedUsers" | "encrypted" | "tags" | "excerpt" | "updatedAt"
    >
  >
): string => {
  if (entries.length !== pages.length) {
    return "page_count_mismatch";
  }

  const indexedBySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  for (const page of pages) {
    const indexed = indexedBySlug.get(page.slug);
    if (!indexed) {
      return "missing_page";
    }

    if (buildEntrySignature(indexed) !== buildEntrySignature(page)) {
      return "changed_page_metadata";
    }
  }

  return "";
};

export const upsertSearchIndexBySlug = async (slug: string): Promise<{ updated: boolean; reason?: string }> => {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) {
    return {
      updated: false,
      reason: "invalid_slug"
    };
  }

  if (buildPromise) {
    return {
      updated: false,
      reason: "rebuild_running"
    };
  }

  if (!isSqliteBackend()) {
    return upsertSearchIndexBySlugFlat(normalizedSlug);
  }

  const page = await getPage(normalizedSlug);
  if (!page) {
    return removeSearchIndexBySlug(normalizedSlug);
  }

  const generatedAt = new Date().toISOString();
  const entry = buildIndexEntryFromPage(page);
  const sqliteUpdated = await upsertSqliteIndexEntry(entry, {
    version: INDEX_VERSION,
    generatedAt
  });

  // Flat-Datei als robuster Fallback wird weiterhin mitgeführt.
  await upsertSearchIndexBySlugFlat(normalizedSlug);

  if (!sqliteUpdated) {
    return {
      updated: true,
      reason: "sqlite_unavailable_flat_fallback"
    };
  }

  return {
    updated: true,
    reason: "sqlite"
  };
};

export const removeSearchIndexBySlug = async (slug: string): Promise<{ updated: boolean; reason?: string }> => {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) {
    return {
      updated: false,
      reason: "invalid_slug"
    };
  }

  if (buildPromise) {
    return {
      updated: false,
      reason: "rebuild_running"
    };
  }

  if (!isSqliteBackend()) {
    return removeSearchIndexBySlugFlat(normalizedSlug);
  }

  const generatedAt = new Date().toISOString();
  const sqliteResult = await removeSqliteIndexEntry(normalizedSlug, {
    version: INDEX_VERSION,
    generatedAt
  });

  const flatResult = await removeSearchIndexBySlugFlat(normalizedSlug);

  if (!sqliteResult.available) {
    return {
      updated: flatResult.updated,
      reason: flatResult.updated ? "sqlite_unavailable_flat_fallback" : "sqlite_unavailable"
    };
  }

  const reason = sqliteResult.updated ? "sqlite" : flatResult.reason;
  if (reason) {
    return {
      updated: sqliteResult.updated || flatResult.updated,
      reason
    };
  }

  return {
    updated: sqliteResult.updated || flatResult.updated
  };
};

export const ensureSearchIndexConsistency = async (): Promise<{ rebuilt: boolean; reason: string }> => {
  if (buildPromise) {
    await buildPromise;
    return {
      rebuilt: false,
      reason: "rebuild_already_running"
    };
  }

  const pages = await listPages({ forceFileScan: true });
  let reason = "";

  if (isSqliteBackend()) {
    const sqliteInfo = await getSqliteIndexInfo();
    const sqliteEntries = await readSqliteIndexEntries();

    if (!sqliteInfo || sqliteEntries === null) {
      reason = "sqlite_unavailable";
    } else if (!sqliteInfo.exists) {
      reason = "index_missing";
    } else if (sqliteInfo.version !== INDEX_VERSION) {
      reason = "version_mismatch";
    } else {
      reason = getConsistencyReasonFromEntries(pages, sqliteEntries);
    }
  } else {
    const exists = await checkSearchIndexExistsFlat();
    const indexDocument = exists ? await readSearchIndexFile() : emptyIndexFile();

    if (!exists) {
      reason = "index_missing";
    } else if (indexDocument.version !== INDEX_VERSION) {
      reason = "version_mismatch";
    } else {
      reason = getConsistencyReasonFromEntries(pages, indexDocument.pages);
    }
  }

  if (!reason) {
    return {
      rebuilt: false,
      reason: "up_to_date"
    };
  }

  await runSearchIndexRebuild();
  return {
    rebuilt: true,
    reason
  };
};
