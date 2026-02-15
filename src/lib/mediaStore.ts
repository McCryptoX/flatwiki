import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { ensureDir, listFiles, removeFile } from "./fileStore.js";
import { getPage, listPages } from "./wikiStore.js";

const SAFE_UPLOAD_FILENAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,255}$/i;
const UPLOAD_REFERENCE_PATTERN = /\/uploads\/([a-z0-9][a-z0-9._%+-]{0,255})(?:\?[^)\s"'`<>]*)?/gi;

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

export const normalizeUploadFileName = (rawName: string): string | null => {
  const trimmed = rawName.trim();
  if (!trimmed) return null;

  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }

  const baseName = path.basename(decoded);
  if (!SAFE_UPLOAD_FILENAME_PATTERN.test(baseName)) {
    return null;
  }

  return baseName;
};

export const extractUploadReferencesFromMarkdown = (markdown: string): string[] => {
  const refs = new Set<string>();

  for (const match of markdown.matchAll(UPLOAD_REFERENCE_PATTERN)) {
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

const buildUsageMap = async (): Promise<Map<string, Map<string, UploadPageReference>>> => {
  const pages = await listPages();
  const usageMap = new Map<string, Map<string, UploadPageReference>>();

  for (const pageSummary of pages) {
    const page = await getPage(pageSummary.slug);
    if (!page) continue;

    const refs = extractUploadReferencesFromMarkdown(page.content);
    for (const fileName of refs) {
      const byPage = usageMap.get(fileName) ?? new Map<string, UploadPageReference>();
      byPage.set(page.slug, {
        slug: page.slug,
        title: page.title
      });
      usageMap.set(fileName, byPage);
    }
  }

  return usageMap;
};

const listUploadFilesWithStats = async (): Promise<Array<{ fileName: string; sizeBytes: number; modifiedAt: string }>> => {
  await ensureDir(config.uploadDir);
  const allFilePaths = await listFiles(config.uploadDir);

  const entries = await Promise.all(
    allFilePaths.map(async (filePath) => {
      const fileName = path.basename(filePath);
      const normalized = normalizeUploadFileName(fileName);
      if (!normalized || normalized !== fileName) return null;

      try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) return null;
        return {
          fileName,
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

export const getUploadUsageReport = async (): Promise<UploadUsageReport> => {
  const [usageMap, uploadFiles] = await Promise.all([buildUsageMap(), listUploadFilesWithStats()]);
  const knownUploads = new Set(uploadFiles.map((file) => file.fileName));

  const files: UploadUsageEntry[] = uploadFiles.map((file) => ({
    fileName: file.fileName,
    url: `/uploads/${file.fileName}`,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    referencedBy: sortRefs([...(usageMap.get(file.fileName)?.values() ?? [])])
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

  const filePath = path.join(config.uploadDir, normalized);

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return false;
  } catch {
    return false;
  }

  await removeFile(filePath);
  return true;
};

export const cleanupUnusedUploads = async (options?: { candidateFileNames?: string[] }): Promise<CleanupUploadsResult> => {
  const report = await getUploadUsageReport();
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
