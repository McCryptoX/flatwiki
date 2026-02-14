import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const writeLocks = new Map<string, Promise<void>>();

const withWriteLock = async <T>(filePath: string, task: () => Promise<T>): Promise<T> => {
  const current = writeLocks.get(filePath) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queued = current.then(() => next);
  writeLocks.set(filePath, queued);
  await current;

  try {
    return await task();
  } finally {
    release();
    if (writeLocks.get(filePath) === queued) {
      writeLocks.delete(filePath);
    }
  }
};

export const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

export const ensureFile = async (filePath: string, defaultContent: string): Promise<void> => {
  try {
    await fs.access(filePath);
  } catch {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, defaultContent, "utf8");
  }
};

export const readJsonFile = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
};

export const writeJsonFile = async <T>(filePath: string, data: T): Promise<void> => {
  await ensureDir(path.dirname(filePath));

  await withWriteLock(filePath, async () => {
    const tempFile = `${filePath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    await fs.writeFile(tempFile, serialized, "utf8");
    await fs.rename(tempFile, filePath);
  });
};

export const writeTextFile = async (filePath: string, content: string): Promise<void> => {
  await ensureDir(path.dirname(filePath));

  await withWriteLock(filePath, async () => {
    const tempFile = `${filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tempFile, content, "utf8");
    await fs.rename(tempFile, filePath);
  });
};

export const appendTextFile = async (filePath: string, content: string): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  await withWriteLock(filePath, async () => {
    await fs.appendFile(filePath, content, "utf8");
  });
};

export const listFiles = async (dirPath: string): Promise<string[]> => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
};

export const readTextFile = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
};

export const removeFile = async (filePath: string): Promise<void> => {
  try {
    await fs.unlink(filePath);
  } catch {
    // noop
  }
};
