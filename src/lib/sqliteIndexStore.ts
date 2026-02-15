import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { config } from "../config.js";
import type { WikiPageSummary } from "../types.js";
import { ensureDir } from "./fileStore.js";

export interface SqliteIndexEntry extends WikiPageSummary {
  searchableText: string;
  updatedAtMs: number;
}

export interface SqliteIndexInfo {
  exists: boolean;
  indexFile: string;
  version: number;
  generatedAt?: string;
  totalPages: number;
  fileSizeBytes: number;
}

interface SqliteWriteMeta {
  version: number;
  generatedAt: string;
}

interface SqlJsStatement {
  bind(params?: unknown[] | Record<string, unknown>): void;
  step(): boolean;
  getAsObject(params?: unknown[] | Record<string, unknown>): Record<string, unknown>;
  free(): void;
}

interface SqlJsDatabase {
  run(sql: string, params?: unknown[] | Record<string, unknown>): void;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}

type SqlJsInit = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;

const require = createRequire(import.meta.url);

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  categoryId TEXT NOT NULL,
  categoryName TEXT NOT NULL,
  visibility TEXT NOT NULL,
  allowedUsers TEXT NOT NULL,
  allowedGroups TEXT NOT NULL,
  encrypted INTEGER NOT NULL,
  tags TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  updatedAtMs INTEGER NOT NULL,
  searchableText TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_updated_idx ON pages(updatedAtMs DESC);
CREATE INDEX IF NOT EXISTS pages_category_idx ON pages(categoryId);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let sqlRuntimePromise: Promise<SqlJsStatic> | null = null;
let sqliteDb: SqlJsDatabase | null = null;
let sqliteLock: Promise<void> = Promise.resolve();

const withSqliteLock = async <T>(task: () => Promise<T>): Promise<T> => {
  const current = sqliteLock;
  let release!: () => void;
  sqliteLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await current;
  try {
    return await task();
  } finally {
    release();
  }
};

const getSqlRuntime = async (): Promise<SqlJsStatic> => {
  if (!sqlRuntimePromise) {
    sqlRuntimePromise = (async () => {
      const imported = (await import("sql.js")) as { default?: SqlJsInit };
      if (typeof imported.default !== "function") {
        throw new Error("sql.js konnte nicht initialisiert werden.");
      }

      return imported.default({
        locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`)
      });
    })();
  }

  return sqlRuntimePromise;
};

const closeSqliteDb = (): void => {
  if (!sqliteDb) return;
  try {
    sqliteDb.close();
  } catch {
    // noop
  }
  sqliteDb = null;
};

const quarantineCorruptIndexFile = async (): Promise<void> => {
  try {
    await fs.access(config.sqliteIndexFile);
  } catch {
    return;
  }

  const corruptPath = `${config.sqliteIndexFile}.corrupt-${Date.now()}`;
  try {
    await fs.rename(config.sqliteIndexFile, corruptPath);
  } catch {
    // noop
  }
};

const ensureSchema = (db: SqlJsDatabase): void => {
  db.run(SQLITE_SCHEMA);

  const stmt = db.prepare("PRAGMA table_info(pages)");
  let hasAllowedGroups = false;
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (String(row.name ?? "").trim() === "allowedGroups") {
        hasAllowedGroups = true;
        break;
      }
    }
  } finally {
    stmt.free();
  }

  if (!hasAllowedGroups) {
    db.run("ALTER TABLE pages ADD COLUMN allowedGroups TEXT NOT NULL DEFAULT '[]'");
  }
};

const openSqliteDb = async (): Promise<SqlJsDatabase> => {
  if (sqliteDb) return sqliteDb;

  const SQL = await getSqlRuntime();

  let sourceBytes: Uint8Array | null = null;
  try {
    const raw = await fs.readFile(config.sqliteIndexFile);
    sourceBytes = new Uint8Array(raw);
  } catch {
    sourceBytes = null;
  }

  try {
    sqliteDb = sourceBytes ? new SQL.Database(sourceBytes) : new SQL.Database();
    ensureSchema(sqliteDb);
    return sqliteDb;
  } catch {
    closeSqliteDb();
    await quarantineCorruptIndexFile();
    sqliteDb = new SQL.Database();
    ensureSchema(sqliteDb);
    return sqliteDb;
  }
};

const persistSqliteDb = async (db: SqlJsDatabase): Promise<void> => {
  await ensureDir(path.dirname(config.sqliteIndexFile));
  const tmpPath = `${config.sqliteIndexFile}.${randomUUID()}.tmp`;
  const payload = Buffer.from(db.export());
  await fs.writeFile(tmpPath, payload);
  await fs.rename(tmpPath, config.sqliteIndexFile);
};

const toInt = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const parseArray = (raw: unknown, lowercase = true): string[] => {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        const value = String(entry).trim();
        return lowercase ? value.toLowerCase() : value;
      })
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
};

const normalizeEntry = (entry: SqliteIndexEntry): SqliteIndexEntry => ({
  slug: String(entry.slug ?? "").trim().toLowerCase(),
  title: String(entry.title ?? "").trim(),
  categoryId: String(entry.categoryId ?? "").trim() || "default",
  categoryName: String(entry.categoryName ?? "").trim() || "Allgemein",
  visibility: entry.visibility === "restricted" ? "restricted" : "all",
  allowedUsers: [...entry.allowedUsers].map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0),
  allowedGroups: [...entry.allowedGroups].map((value) => value.trim()).filter((value) => value.length > 0),
  encrypted: entry.encrypted === true,
  tags: [...entry.tags].map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0),
  excerpt: String(entry.excerpt ?? "").trim(),
  updatedAt: String(entry.updatedAt ?? "").trim(),
  searchableText: String(entry.searchableText ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
  updatedAtMs: toInt(entry.updatedAtMs)
});

const mapRowToEntry = (row: Record<string, unknown>): SqliteIndexEntry => {
  const title = String(row.title ?? "").trim();
  const slug = String(row.slug ?? "").trim().toLowerCase();
  const tags = parseArray(row.tags);
  const excerpt = String(row.excerpt ?? "").trim();
  const searchableText =
    String(row.searchableText ?? `${title}\n${tags.join(" ")}\n${excerpt}`)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

  return {
    slug,
    title: title || slug,
    categoryId: String(row.categoryId ?? "").trim() || "default",
    categoryName: String(row.categoryName ?? "").trim() || "Allgemein",
    visibility: row.visibility === "restricted" ? "restricted" : "all",
    allowedUsers: parseArray(row.allowedUsers),
    allowedGroups: parseArray(row.allowedGroups, false),
    encrypted: toInt(row.encrypted) === 1,
    tags,
    excerpt,
    updatedAt: String(row.updatedAt ?? "").trim(),
    searchableText,
    updatedAtMs: toInt(row.updatedAtMs)
  };
};

const getMetaValue = (db: SqlJsDatabase, key: string): string | null => {
  const stmt = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1");
  try {
    stmt.bind([key]);
    if (!stmt.step()) return null;
    const row = stmt.getAsObject();
    return typeof row.value === "string" ? row.value : String(row.value ?? "");
  } finally {
    stmt.free();
  }
};

const setMetaValue = (db: SqlJsDatabase, key: string, value: string): void => {
  db.run("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);
};

const getTotalPages = (db: SqlJsDatabase): number => {
  const stmt = db.prepare("SELECT COUNT(1) AS total FROM pages");
  try {
    if (!stmt.step()) return 0;
    const row = stmt.getAsObject();
    return toInt(row.total);
  } finally {
    stmt.free();
  }
};

const writeMeta = (db: SqlJsDatabase, meta: SqliteWriteMeta): void => {
  setMetaValue(db, "version", String(meta.version));
  setMetaValue(db, "generatedAt", meta.generatedAt);
  setMetaValue(db, "totalPages", String(getTotalPages(db)));
};

const insertEntry = (db: SqlJsDatabase, entry: SqliteIndexEntry): void => {
  const normalized = normalizeEntry(entry);
  db.run(
    `INSERT INTO pages (
      slug, title, categoryId, categoryName, visibility, allowedUsers, allowedGroups, encrypted, tags, excerpt, updatedAt, updatedAtMs, searchableText
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      categoryId = excluded.categoryId,
      categoryName = excluded.categoryName,
      visibility = excluded.visibility,
      allowedUsers = excluded.allowedUsers,
      allowedGroups = excluded.allowedGroups,
      encrypted = excluded.encrypted,
      tags = excluded.tags,
      excerpt = excluded.excerpt,
      updatedAt = excluded.updatedAt,
      updatedAtMs = excluded.updatedAtMs,
      searchableText = excluded.searchableText`,
    [
      normalized.slug,
      normalized.title,
      normalized.categoryId,
      normalized.categoryName,
      normalized.visibility,
      JSON.stringify(normalized.allowedUsers),
      JSON.stringify(normalized.allowedGroups),
      normalized.encrypted ? 1 : 0,
      JSON.stringify(normalized.tags),
      normalized.excerpt,
      normalized.updatedAt,
      normalized.updatedAtMs,
      normalized.searchableText
    ]
  );
};

const queryEntries = (db: SqlJsDatabase, options?: { categoryId?: string }): SqliteIndexEntry[] => {
  const categoryId = options?.categoryId?.trim();
  const stmt = db.prepare(
    categoryId
      ? "SELECT * FROM pages WHERE categoryId = ? ORDER BY updatedAtMs DESC"
      : "SELECT * FROM pages ORDER BY updatedAtMs DESC"
  );

  try {
    if (categoryId) {
      stmt.bind([categoryId]);
    }

    const rows: SqliteIndexEntry[] = [];
    while (stmt.step()) {
      rows.push(mapRowToEntry(stmt.getAsObject()));
    }
    return rows;
  } finally {
    stmt.free();
  }
};

export const readSqliteIndexEntries = async (options?: { categoryId?: string }): Promise<SqliteIndexEntry[] | null> => {
  return withSqliteLock(async () => {
    try {
      const db = await openSqliteDb();
      return queryEntries(db, options);
    } catch {
      closeSqliteDb();
      return null;
    }
  });
};

export const replaceSqliteIndexEntries = async (
  entries: SqliteIndexEntry[],
  meta: SqliteWriteMeta
): Promise<boolean> => {
  return withSqliteLock(async () => {
    try {
      const db = await openSqliteDb();
      db.run("BEGIN TRANSACTION");
      try {
        db.run("DELETE FROM pages");
        for (const entry of entries) {
          insertEntry(db, entry);
        }
        writeMeta(db, meta);
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }

      await persistSqliteDb(db);
      return true;
    } catch {
      closeSqliteDb();
      return false;
    }
  });
};

export const upsertSqliteIndexEntry = async (entry: SqliteIndexEntry, meta: SqliteWriteMeta): Promise<boolean> => {
  return withSqliteLock(async () => {
    try {
      const db = await openSqliteDb();
      db.run("BEGIN TRANSACTION");
      try {
        insertEntry(db, entry);
        writeMeta(db, meta);
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }

      await persistSqliteDb(db);
      return true;
    } catch {
      closeSqliteDb();
      return false;
    }
  });
};

export const removeSqliteIndexEntry = async (
  slug: string,
  meta: SqliteWriteMeta
): Promise<{ available: boolean; updated: boolean }> => {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) {
    return {
      available: true,
      updated: false
    };
  }

  return withSqliteLock(async () => {
    try {
      const db = await openSqliteDb();

      const check = db.prepare("SELECT 1 AS ok FROM pages WHERE slug = ? LIMIT 1");
      let exists = false;
      try {
        check.bind([normalizedSlug]);
        exists = check.step();
      } finally {
        check.free();
      }

      if (!exists) {
        return {
          available: true,
          updated: false
        };
      }

      db.run("BEGIN TRANSACTION");
      try {
        db.run("DELETE FROM pages WHERE slug = ?", [normalizedSlug]);
        writeMeta(db, meta);
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }

      await persistSqliteDb(db);
      return {
        available: true,
        updated: true
      };
    } catch {
      closeSqliteDb();
      return {
        available: false,
        updated: false
      };
    }
  });
};

export const getSqliteIndexInfo = async (): Promise<SqliteIndexInfo | null> => {
  const indexFile = path.relative(config.rootDir, config.sqliteIndexFile);
  let fileSizeBytes = 0;

  try {
    const stats = await fs.stat(config.sqliteIndexFile);
    fileSizeBytes = stats.size;
  } catch {
    return {
      exists: false,
      indexFile,
      version: 0,
      totalPages: 0,
      fileSizeBytes: 0
    };
  }

  return withSqliteLock(async () => {
    try {
      const db = await openSqliteDb();
      const version = toInt(getMetaValue(db, "version"));
      const generatedAtRaw = getMetaValue(db, "generatedAt");
      const totalPagesRaw = getMetaValue(db, "totalPages");
      const totalPages = totalPagesRaw ? toInt(totalPagesRaw) : getTotalPages(db);
      const generatedAt = generatedAtRaw && generatedAtRaw.trim().length > 0 ? generatedAtRaw : undefined;

      return {
        exists: true,
        indexFile,
        version,
        totalPages,
        fileSizeBytes,
        ...(generatedAt ? { generatedAt } : {})
      };
    } catch {
      closeSqliteDb();
      return null;
    }
  });
};
