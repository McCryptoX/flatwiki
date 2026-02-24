import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { config } from "../config.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fileStore.js";

const SLUG_PATTERN = /^[a-z0-9-]{1,80}$/;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

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

interface VersionFileEntry {
  fileName: string;
  versionId: string;
  compressed: boolean;
}

export interface VersionStoreReportItem {
  slug: string;
  totalVersions: number;
  diskBytes: number;
}

export interface VersionStoreReport {
  totalSlugs: number;
  totalVersions: number;
  totalDiskBytes: number;
  topItems: VersionStoreReportItem[];
}

export interface VersionCleanupResult {
  scannedSlugs: number;
  compressedFiles: number;
  deletedFiles: number;
  errors: string[];
}

interface CleanupOptions {
  keepLatest: number;
  compressAfter: number;
}

const normalizeSlug = (slug: string): string => slug.trim().toLowerCase();

const getSlugShard = (slug: string): string => slug.slice(0, 2).replace(/[^a-z0-9]/g, "_").padEnd(2, "_");

const getVersionDir = (slug: string): string => path.join(config.versionsDir, getSlugShard(slug), slug);

const getVersionFilePath = (slug: string, versionId: string): string =>
  path.join(getVersionDir(slug), `${versionId}.json`);

const getCompressedVersionFilePath = (slug: string, versionId: string): string =>
  path.join(getVersionDir(slug), `${versionId}.json.gz`);

let mutationQueue: Promise<void> = Promise.resolve();

const withMutationLock = async <T>(task: () => Promise<T>): Promise<T> => {
  const waitFor = mutationQueue;
  let release!: () => void;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await waitFor;
  try {
    return await task();
  } finally {
    release();
  }
};

const parseVersionFileName = (name: string): VersionFileEntry | null => {
  if (name.endsWith(".json.gz")) {
    return {
      fileName: name,
      versionId: name.slice(0, -".json.gz".length),
      compressed: true
    };
  }

  if (name.endsWith(".json")) {
    return {
      fileName: name,
      versionId: name.slice(0, -".json".length),
      compressed: false
    };
  }

  return null;
};

const loadVersionFileEntries = async (slug: string): Promise<VersionFileEntry[]> => {
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

  const dedup = new Map<string, VersionFileEntry>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseVersionFileName(entry.name);
    if (!parsed || parsed.versionId.length < 8) continue;

    const current = dedup.get(parsed.versionId);
    if (!current) {
      dedup.set(parsed.versionId, parsed);
      continue;
    }

    if (current.compressed && !parsed.compressed) {
      dedup.set(parsed.versionId, parsed);
    }
  }

  return [...dedup.values()].sort((a, b) => b.versionId.localeCompare(a.versionId));
};

const readVersionPayload = async (slug: string, file: VersionFileEntry): Promise<PageVersionPayload | null> => {
  const fullPath = path.join(getVersionDir(slug), file.fileName);
  try {
    if (file.compressed) {
      const compressed = await fs.readFile(fullPath);
      const raw = await gunzipAsync(compressed);
      const payload = JSON.parse(raw.toString("utf8")) as PageVersionPayload;
      return payload;
    }
  } catch {
    return null;
  }

  const payload = await readJsonFile<PageVersionPayload | null>(fullPath, null);
  return payload;
};

const defaultCleanupOptions = (): CleanupOptions => ({
  keepLatest: Math.max(config.versionHistoryRetention, 1),
  compressAfter: Math.max(config.versionHistoryCompressAfter, 0)
});

const cleanupPageVersionFiles = async (slug: string, options?: Partial<CleanupOptions>): Promise<VersionCleanupResult> => {
  const safe: CleanupOptions = {
    keepLatest: Math.max(options?.keepLatest ?? defaultCleanupOptions().keepLatest, 1),
    compressAfter: Math.max(options?.compressAfter ?? defaultCleanupOptions().compressAfter, 0)
  };

  const entries = await loadVersionFileEntries(slug);
  let compressedFiles = 0;
  let deletedFiles = 0;
  const errors: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;

    if (index >= safe.keepLatest) {
      try {
        await fs.unlink(path.join(getVersionDir(slug), entry.fileName));
        deletedFiles += 1;
      } catch (error) {
        errors.push(`Delete ${slug}/${entry.fileName}: ${error instanceof Error ? error.message : "unknown"}`);
      }
      continue;
    }

    if (index >= safe.compressAfter && !entry.compressed) {
      const sourcePath = path.join(getVersionDir(slug), entry.fileName);
      const targetPath = getCompressedVersionFilePath(slug, entry.versionId);
      try {
        const sourceRaw = await fs.readFile(sourcePath);
        const compressedRaw = await gzipAsync(sourceRaw, { level: 9 });
        await fs.writeFile(targetPath, compressedRaw);
        await fs.unlink(sourcePath);
        compressedFiles += 1;
      } catch (error) {
        errors.push(`Compress ${slug}/${entry.fileName}: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
  }

  return {
    scannedSlugs: 1,
    compressedFiles,
    deletedFiles,
    errors
  };
};

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
  return withMutationLock(async () => {
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
    await cleanupPageVersionFiles(slug);

    return { ok: true, id };
  });
};

export const listPageVersions = async (slugInput: string, limit = 100): Promise<PageVersionSummary[]> => {
  const slug = normalizeSlug(slugInput);
  if (!SLUG_PATTERN.test(slug)) return [];

  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const files = (await loadVersionFileEntries(slug)).slice(0, safeLimit);

  const summaries: PageVersionSummary[] = [];
  for (const file of files) {
    const payload = await readVersionPayload(slug, file);
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

  const fileEntries = await loadVersionFileEntries(slug);
  const file = fileEntries.find((entry) => entry.versionId === versionId);
  if (!file) return null;

  const payload = await readVersionPayload(slug, file);
  if (!payload || payload.slug !== slug || payload.id !== versionId || !payload.fileContent) {
    return null;
  }

  return parseVersionPayload(payload);
};

const listKnownVersionSlugs = async (): Promise<string[]> => {
  let shardDirs: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    shardDirs = (await fs.readdir(config.versionsDir, {
      withFileTypes: true,
      encoding: "utf8"
    })) as Array<{ name: string; isDirectory: () => boolean }>;
  } catch {
    return [];
  }

  const slugs: string[] = [];
  for (const shard of shardDirs) {
    if (!shard.isDirectory()) continue;
    const shardPath = path.join(config.versionsDir, shard.name);
    let slugDirs: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      slugDirs = (await fs.readdir(shardPath, {
        withFileTypes: true,
        encoding: "utf8"
      })) as Array<{ name: string; isDirectory: () => boolean }>;
    } catch {
      continue;
    }

    for (const slugDir of slugDirs) {
      if (!slugDir.isDirectory()) continue;
      const slug = normalizeSlug(slugDir.name);
      if (!SLUG_PATTERN.test(slug)) continue;
      slugs.push(slug);
    }
  }

  return [...new Set(slugs)].sort((a, b) => a.localeCompare(b));
};

export const listVersionSlugs = async (): Promise<string[]> => {
  return listKnownVersionSlugs();
};

export const cleanupAllPageVersions = async (
  options?: Partial<CleanupOptions> & { slug?: string }
): Promise<VersionCleanupResult> => {
  return withMutationLock(async () => {
    const safeSlug = options?.slug ? normalizeSlug(options.slug) : "";
    const slugs =
      safeSlug && SLUG_PATTERN.test(safeSlug)
        ? [safeSlug]
        : await listKnownVersionSlugs();

    const result: VersionCleanupResult = {
      scannedSlugs: 0,
      compressedFiles: 0,
      deletedFiles: 0,
      errors: []
    };

    for (const slug of slugs) {
      const perSlug = await cleanupPageVersionFiles(slug, options);
      result.scannedSlugs += perSlug.scannedSlugs;
      result.compressedFiles += perSlug.compressedFiles;
      result.deletedFiles += perSlug.deletedFiles;
      result.errors.push(...perSlug.errors);
    }

    return result;
  });
};

export const getVersionStoreReport = async (topLimit = 20): Promise<VersionStoreReport> => {
  const slugs = await listKnownVersionSlugs();
  const items: VersionStoreReportItem[] = [];

  for (const slug of slugs) {
    const entries = await loadVersionFileEntries(slug);
    let diskBytes = 0;

    for (const entry of entries) {
      try {
        const stats = await fs.stat(path.join(getVersionDir(slug), entry.fileName));
        diskBytes += stats.size;
      } catch {
        // noop
      }
    }

    items.push({
      slug,
      totalVersions: entries.length,
      diskBytes
    });
  }

  const totalVersions = items.reduce((sum, item) => sum + item.totalVersions, 0);
  const totalDiskBytes = items.reduce((sum, item) => sum + item.diskBytes, 0);
  const safeTopLimit = Math.min(Math.max(topLimit, 1), 200);
  const topItems = [...items]
    .sort((a, b) => b.totalVersions - a.totalVersions || b.diskBytes - a.diskBytes || a.slug.localeCompare(b.slug))
    .slice(0, safeTopLimit);

  return {
    totalSlugs: items.length,
    totalVersions,
    totalDiskBytes,
    topItems
  };
};
