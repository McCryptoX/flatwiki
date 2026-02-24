import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { ensureDir, removeFile, safeResolve } from "./fileStore.js";
import { getPageVersion, listPageVersions, listVersionSlugs } from "./pageVersionStore.js";
import { deriveUploadPaths, isLikelyGeneratedDerivative } from "./uploadDerivatives.js";
import { removeUploadSecurityByFile } from "./uploadSecurityStore.js";
import { getPage, listPages } from "./wikiStore.js";

const SAFE_UPLOAD_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,120}$/i;
const UPLOAD_REFERENCE_PATTERN = /\/uploads\/([a-z0-9][a-z0-9._%+-]*(?:\/[a-z0-9][a-z0-9._%+-]*)*)(?:\?[^)\s"'`<>]*)?/gi;

export interface UploadPageReference {
  slug: string;
  title: string;
}

export interface UploadUsageEntry {
  fileName: string;
  url: string;
  sizeBytes: number;
  modifiedAt: string;
  referencedBy: UploadPageReference[];
}

export interface MissingUploadReference {
  fileName: string;
  referencedBy: UploadPageReference[];
}

export interface UploadUsageReport {
  files: UploadUsageEntry[];
  missingReferences: MissingUploadReference[];
  totalSizeBytes: number;
}

export interface CleanupUploadsResult {
  deleted: string[];
  inUse: Array<{ fileName: string; referencedBy: UploadPageReference[] }>;
}

interface UploadReferenceSource {
  slug: string;
  title: string;
  markdown: string;
}

export const normalizeUploadFileName = (rawName: string): string | null => {
  const trimmed = rawName.trim();
  if (!trimmed) return null;

  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }

  const normalized = decoded.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  if (segments.length < 1) return null;
  if (!segments.every((segment) => SAFE_UPLOAD_SEGMENT_PATTERN.test(segment))) return null;

  return segments.join("/");
};

const stripMarkdownCodeForUploadScan = (markdown: string): string =>
  markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^(?: {4}|\t).+$/gm, " ");

export const extractUploadReferencesFromMarkdown = (markdown: string): string[] => {
  const refs = new Set<string>();
  const scanSource = stripMarkdownCodeForUploadScan(markdown);

  for (const match of scanSource.matchAll(UPLOAD_REFERENCE_PATTERN)) {
    const rawFileName = match[1];
    if (!rawFileName) continue;

    const normalized = normalizeUploadFileName(rawFileName);
    if (normalized) {
      refs.add(normalized);
    }
  }

  return [...refs];
};

const sortRefs = (refs: UploadPageReference[]): UploadPageReference[] =>
  refs.sort((a, b) => a.title.localeCompare(b.title, "de", { sensitivity: "base" }));

const buildBaseReferenceMap = (usageMap: Map<string, Map<string, UploadPageReference>>): Map<string, Map<string, UploadPageReference>> => {
  const baseMap = new Map<string, Map<string, UploadPageReference>>();

  for (const [fileName, refsByPage] of usageMap.entries()) {
    if (isLikelyGeneratedDerivative(fileName)) continue;
    const basePath = deriveUploadPaths(fileName).basePath;
    const bucket = baseMap.get(basePath) ?? new Map<string, UploadPageReference>();
    for (const [slug, ref] of refsByPage.entries()) {
      bucket.set(slug, ref);
    }
    baseMap.set(basePath, bucket);
  }

  return baseMap;
};

export const resolveDerivativeAwareReferences = (
  fileName: string,
  usageMap: Map<string, Map<string, UploadPageReference>>,
  baseReferenceMap: Map<string, Map<string, UploadPageReference>>,
  existingOriginalBasePaths?: Set<string>
): UploadPageReference[] => {
  const exact = usageMap.get(fileName);
  if (exact && exact.size > 0) {
    return sortRefs([...exact.values()]);
  }

  if (!isLikelyGeneratedDerivative(fileName)) {
    return [];
  }

  const basePath = deriveUploadPaths(fileName).basePath;
  if (existingOriginalBasePaths && !existingOriginalBasePaths.has(basePath)) {
    return [];
  }
  const inherited = baseReferenceMap.get(basePath);
  return sortRefs([...(inherited?.values() ?? [])]);
};

const listUploadFilesRecursive = async (
  rootDir: string,
  currentDir = rootDir
): Promise<Array<{ relativePath: string; absolutePath: string }>> => {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await fs.readdir(currentDir, {
      withFileTypes: true,
      encoding: "utf8"
    })) as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  } catch {
    return [];
  }

  const results: Array<{ relativePath: string; absolutePath: string }> = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listUploadFilesRecursive(rootDir, absolutePath);
      results.push(...nested);
      continue;
    }

    if (!entry.isFile()) continue;
    const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
    results.push({
      relativePath,
      absolutePath
    });
  }

  return results;
};

const applyUploadReferences = (
  usageMap: Map<string, Map<string, UploadPageReference>>,
  source: UploadReferenceSource
): void => {
  const refs = extractUploadReferencesFromMarkdown(source.markdown);
  for (const fileName of refs) {
    const byPage = usageMap.get(fileName) ?? new Map<string, UploadPageReference>();
    byPage.set(source.slug, {
      slug: source.slug,
      title: source.title
    });
    usageMap.set(fileName, byPage);
  }
};

export const buildUploadUsageMapFromSources = (
  sources: UploadReferenceSource[]
): Map<string, Map<string, UploadPageReference>> => {
  const usageMap = new Map<string, Map<string, UploadPageReference>>();
  for (const source of sources) {
    applyUploadReferences(usageMap, source);
  }
  return usageMap;
};

const buildUsageMap = async (options?: { includeVersionHistory?: boolean }): Promise<Map<string, Map<string, UploadPageReference>>> => {
  const pages = await listPages();
  const sources: UploadReferenceSource[] = [];

  for (const pageSummary of pages) {
    const page = await getPage(pageSummary.slug);
    if (!page) continue;
    sources.push({
      slug: page.slug,
      title: page.title,
      markdown: page.content
    });
  }

  if (options?.includeVersionHistory) {
    const knownTitles = new Map<string, string>();
    for (const page of sources) {
      knownTitles.set(page.slug, page.title);
    }

    const versionSlugs = await listVersionSlugs();
    for (const slug of versionSlugs) {
      const versions = await listPageVersions(slug, Math.max(config.versionHistoryRetention, 1));
      if (versions.length < 1) continue;

      const title = knownTitles.get(slug) ?? slug;
      for (const version of versions) {
        const detail = await getPageVersion(slug, version.id);
        if (!detail) continue;

        sources.push({
          slug,
          title,
          markdown: detail.fileContent
        });
      }
    }
  }

  return buildUploadUsageMapFromSources(sources);
};

export const getUploadUsageReport = async (options?: { includeVersionHistory?: boolean }): Promise<UploadUsageReport> => {
  const [usageMap, uploadFiles] = await Promise.all([buildUsageMap(options), listUploadFilesWithStats()]);
  const knownUploads = new Set(uploadFiles.map((file) => file.fileName));
  const baseReferenceMap = buildBaseReferenceMap(usageMap);
  const existingOriginalBasePaths = new Set(
    uploadFiles.filter((file) => !isLikelyGeneratedDerivative(file.fileName)).map((file) => deriveUploadPaths(file.fileName).basePath)
  );

  const files: UploadUsageEntry[] = uploadFiles.map((file) => ({
    fileName: file.fileName,
    url: `/uploads/${file.fileName}`,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    referencedBy: resolveDerivativeAwareReferences(file.fileName, usageMap, baseReferenceMap, existingOriginalBasePaths)
  }));

  const missingReferences: MissingUploadReference[] = [...usageMap.entries()]
    .filter(([fileName]) => !knownUploads.has(fileName))
    .map(([fileName, refsByPage]) => ({
      fileName,
      referencedBy: sortRefs([...refsByPage.values()])
    }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName, "de", { sensitivity: "base" }));

  const totalSizeBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);

  return {
    files,
    missingReferences,
    totalSizeBytes
  };
};

export const deleteUploadFile = async (fileName: string): Promise<boolean> => {
  const normalized = normalizeUploadFileName(fileName);
  if (!normalized || normalized !== fileName) {
    return false;
  }

  const filePath = safeResolve(config.uploadDir, normalized);

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return false;
  } catch {
    return false;
  }

  await removeFile(filePath);
  await removeUploadSecurityByFile(normalized);

  if (!isLikelyGeneratedDerivative(normalized)) {
    const basePath = deriveUploadPaths(normalized).basePath;
    const siblings = [`${basePath}.avif`, `${basePath}.webp`];
    for (const sibling of siblings) {
      await removeFile(safeResolve(config.uploadDir, sibling));
      await removeUploadSecurityByFile(sibling);
    }
  }

  return true;
};

export const cleanupUnusedUploads = async (options?: { candidateFileNames?: string[] }): Promise<CleanupUploadsResult> => {
  const report = await getUploadUsageReport({ includeVersionHistory: true });
  const candidateSet = options?.candidateFileNames
    ? new Set(
        options.candidateFileNames
          .map((candidate) => normalizeUploadFileName(candidate))
          .filter((candidate): candidate is string => Boolean(candidate))
      )
    : null;

  const deletableFiles = report.files.filter(
    (file) => file.referencedBy.length === 0 && (!candidateSet || candidateSet.has(file.fileName))
  );
  const inUse = report.files
    .filter((file) => Boolean(candidateSet?.has(file.fileName) && file.referencedBy.length > 0))
    .map((file) => ({
      fileName: file.fileName,
      referencedBy: file.referencedBy
    }));

  const deleted: string[] = [];
  for (const file of deletableFiles) {
    const removed = await deleteUploadFile(file.fileName);
    if (removed) {
      deleted.push(file.fileName);
    }
  }

  return {
    deleted,
    inUse
  };
};
const listUploadFilesWithStats = async (): Promise<Array<{ fileName: string; sizeBytes: number; modifiedAt: string }>> => {
  await ensureDir(config.uploadDir);
  const allFiles = await listUploadFilesRecursive(config.uploadDir);

  const entries = await Promise.all(
    allFiles.map(async (entry) => {
      const normalized = normalizeUploadFileName(entry.relativePath);
      if (!normalized || normalized !== entry.relativePath) return null;

      try {
        const stats = await fs.stat(entry.absolutePath);
        if (!stats.isFile()) return null;
        return {
          fileName: normalized,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString()
        };
      } catch {
        return null;
      }
    })
  );

  return entries
    .filter((entry): entry is { fileName: string; sizeBytes: number; modifiedAt: string } => entry !== null)
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
};
