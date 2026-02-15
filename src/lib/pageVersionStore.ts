import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fileStore.js";

const SLUG_PATTERN = /^[a-z0-9-]{1,80}$/;

export type PageVersionReason = "update" | "delete" | "restore-backup";

interface PageVersionPayload {
  id: string;
  slug: string;
  reason: PageVersionReason;
  createdAt: string;
  createdBy: string;
  sourceUpdatedAt?: string;
  sourceUpdatedBy?: string;
  fileContent: string;
}

export interface PageVersionSummary {
  id: string;
  slug: string;
  reason: PageVersionReason;
  createdAt: string;
  createdBy: string;
  sourceUpdatedAt?: string;
  sourceUpdatedBy?: string;
  sizeBytes: number;
}

export interface PageVersionDetail extends PageVersionSummary {
  fileContent: string;
}

const normalizeSlug = (slug: string): string => slug.trim().toLowerCase();

const getSlugShard = (slug: string): string => slug.slice(0, 2).replace(/[^a-z0-9]/g, "_").padEnd(2, "_");

const getVersionDir = (slug: string): string => path.join(config.versionsDir, getSlugShard(slug), slug);

const getVersionFilePath = (slug: string, versionId: string): string =>
  path.join(getVersionDir(slug), `${versionId}.json`);

const parseVersionPayload = (payload: PageVersionPayload): PageVersionDetail => ({
  id: payload.id,
  slug: payload.slug,
  reason: payload.reason,
  createdAt: payload.createdAt,
  createdBy: payload.createdBy,
  ...(payload.sourceUpdatedAt ? { sourceUpdatedAt: payload.sourceUpdatedAt } : {}),
  ...(payload.sourceUpdatedBy ? { sourceUpdatedBy: payload.sourceUpdatedBy } : {}),
  sizeBytes: Buffer.byteLength(payload.fileContent, "utf8"),
  fileContent: payload.fileContent
});

export const createPageVersionSnapshot = async (input: {
  slug: string;
  reason: PageVersionReason;
  createdBy: string;
  sourceUpdatedAt?: string;
  sourceUpdatedBy?: string;
  fileContent: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> => {
  const slug = normalizeSlug(input.slug);
  if (!SLUG_PATTERN.test(slug)) {
    return { ok: false, error: "Ungültiger Slug." };
  }

  const content = input.fileContent;
  if (!content || content.trim().length === 0) {
    return { ok: false, error: "Leerer Inhalt kann nicht versioniert werden." };
  }

  const id = `${Date.now()}-${randomUUID().replaceAll("-", "")}`;
  const payload: PageVersionPayload = {
    id,
    slug,
    reason: input.reason,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy.trim() || "unknown",
    ...(input.sourceUpdatedAt ? { sourceUpdatedAt: input.sourceUpdatedAt } : {}),
    ...(input.sourceUpdatedBy ? { sourceUpdatedBy: input.sourceUpdatedBy } : {}),
    fileContent: content
  };

  const filePath = getVersionFilePath(slug, id);
  await ensureDir(path.dirname(filePath));
  await writeJsonFile(filePath, payload);

  return { ok: true, id };
};

export const listPageVersions = async (slugInput: string, limit = 100): Promise<PageVersionSummary[]> => {
  const slug = normalizeSlug(slugInput);
  if (!SLUG_PATTERN.test(slug)) return [];

  const dir = getVersionDir(slug);
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = (await fs.readdir(dir, {
      withFileTypes: true,
      encoding: "utf8"
    })) as Array<{ name: string; isFile: () => boolean }>;
  } catch {
    return [];
  }

  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, safeLimit);

  const summaries: PageVersionSummary[] = [];
  for (const fileName of files) {
    const versionId = fileName.slice(0, -".json".length);
    const payload = await readJsonFile<PageVersionPayload | null>(getVersionFilePath(slug, versionId), null);
    if (!payload || payload.slug !== slug || !payload.id || !payload.fileContent) continue;

    const detail = parseVersionPayload(payload);
    summaries.push({
      id: detail.id,
      slug: detail.slug,
      reason: detail.reason,
      createdAt: detail.createdAt,
      createdBy: detail.createdBy,
      ...(detail.sourceUpdatedAt ? { sourceUpdatedAt: detail.sourceUpdatedAt } : {}),
      ...(detail.sourceUpdatedBy ? { sourceUpdatedBy: detail.sourceUpdatedBy } : {}),
      sizeBytes: detail.sizeBytes
    });
  }

  return summaries;
};

export const getPageVersion = async (slugInput: string, versionIdInput: string): Promise<PageVersionDetail | null> => {
  const slug = normalizeSlug(slugInput);
  const versionId = versionIdInput.trim();
  if (!SLUG_PATTERN.test(slug) || versionId.length < 8) return null;

  const payload = await readJsonFile<PageVersionPayload | null>(getVersionFilePath(slug, versionId), null);
  if (!payload || payload.slug !== slug || payload.id !== versionId || !payload.fileContent) {
    return null;
  }

  return parseVersionPayload(payload);
};
