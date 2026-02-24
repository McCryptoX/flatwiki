import { config } from "../config.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

interface UploadSecurityFile {
  entries?: unknown;
}

export interface UploadSecurityEntry {
  fileName: string;
  slug: string;
  encrypted: boolean;
  mimeType: string;
  updatedAt: string;
}

let mutationQueue: Promise<void> = Promise.resolve();
const SAFE_UPLOAD_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

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

const normalizeUploadFileName = (rawName: string): string | null => {
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

const normalizeEntry = (value: unknown): UploadSecurityEntry | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const fileName = normalizeUploadFileName(String(raw.fileName ?? ""));
  const slug = String(raw.slug ?? "").trim().toLowerCase();
  const encrypted = raw.encrypted === true;
  const mimeType = String(raw.mimeType ?? "application/octet-stream").trim().toLowerCase() || "application/octet-stream";
  const updatedAtRaw = String(raw.updatedAt ?? "").trim();
  const parsedUpdatedAt = Date.parse(updatedAtRaw);

  if (!fileName || !slug) return null;

  return {
    fileName,
    slug,
    encrypted,
    mimeType,
    updatedAt: Number.isFinite(parsedUpdatedAt) ? new Date(parsedUpdatedAt).toISOString() : new Date().toISOString()
  };
};

const ensureStoreFile = async (): Promise<void> => {
  await ensureFile(config.uploadSecurityFile, '{"entries":[]}\n');
};

const loadEntries = async (): Promise<UploadSecurityEntry[]> => {
  await ensureStoreFile();
  const raw = await readJsonFile<UploadSecurityFile>(config.uploadSecurityFile, { entries: [] });
  const entries = Array.isArray(raw.entries) ? raw.entries.map((entry) => normalizeEntry(entry)).filter((entry): entry is UploadSecurityEntry => entry !== null) : [];
  return entries;
};

const saveEntries = async (entries: UploadSecurityEntry[]): Promise<void> => {
  await writeJsonFile(config.uploadSecurityFile, { entries });
};

export const getUploadSecurityByFile = async (fileNameInput: string): Promise<UploadSecurityEntry | null> => {
  const fileName = normalizeUploadFileName(fileNameInput);
  if (!fileName) return null;
  const entries = await loadEntries();
  return entries.find((entry) => entry.fileName === fileName) ?? null;
};

export const upsertUploadSecurityEntry = async (input: {
  fileName: string;
  slug: string;
  encrypted: boolean;
  mimeType: string;
}): Promise<UploadSecurityEntry | null> => {
  const fileName = normalizeUploadFileName(input.fileName);
  const slug = String(input.slug ?? "").trim().toLowerCase();
  if (!fileName || !slug) return null;

  return withMutationLock(async () => {
    const entries = await loadEntries();
    const now = new Date().toISOString();
    const next: UploadSecurityEntry = {
      fileName,
      slug,
      encrypted: input.encrypted === true,
      mimeType: String(input.mimeType ?? "application/octet-stream").trim().toLowerCase() || "application/octet-stream",
      updatedAt: now
    };
    const index = entries.findIndex((entry) => entry.fileName === fileName);
    if (index >= 0) {
      entries[index] = next;
    } else {
      entries.push(next);
    }
    await saveEntries(entries);
    return next;
  });
};

export const removeUploadSecurityByFile = async (fileNameInput: string): Promise<boolean> => {
  const fileName = normalizeUploadFileName(fileNameInput);
  if (!fileName) return false;

  return withMutationLock(async () => {
    const entries = await loadEntries();
    const filtered = entries.filter((entry) => entry.fileName !== fileName);
    if (filtered.length === entries.length) return false;
    await saveEntries(filtered);
    return true;
  });
};
