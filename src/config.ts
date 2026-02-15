import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";

const rootDir = process.cwd();
const configEnvPath = path.join(rootDir, "config.env");

const generateHex = (bytes: number): string => randomBytes(bytes).toString("hex");

interface InstallerResult {
  created: boolean;
}

export type IndexBackend = "flat" | "sqlite";

const appendMissingEnvKeys = (filePath: string): InstallerResult => {
  const result: InstallerResult = { created: false };
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "# FlatWiki Erstkonfiguration\n", "utf8");
    result.created = true;
  }

  const original = fs.readFileSync(filePath, "utf8");
  const hasKey = (key: string): boolean => new RegExp(`^\\s*${key}=`, "m").test(original);

  const defaults: Record<string, string> = {
    PORT: "3000",
    HOST: "0.0.0.0",
    COOKIE_SECRET: generateHex(32),
    PASSWORD_PEPPER: generateHex(24),
    CONTENT_ENCRYPTION_KEY: generateHex(32),
    CONTENT_INTEGRITY_KEY: generateHex(32),
    SESSION_TTL_HOURS: "12",
    VERSION_HISTORY_RETENTION: "150",
    VERSION_HISTORY_COMPRESS_AFTER: "30",
    WIKI_TITLE: "FlatWiki",
    INDEX_BACKEND: "flat",
    BOOTSTRAP_ADMIN_USERNAME: "admin"
  };

  const missingLines = Object.entries(defaults)
    .filter(([key]) => !hasKey(key))
    .map(([key, value]) => `${key}=${value}`);

  if (missingLines.length > 0) {
    const needsNewline = original.length > 0 && !original.endsWith("\n");
    const prefix = needsNewline ? "\n" : "";
    fs.appendFileSync(filePath, `${prefix}${missingLines.join("\n")}\n`, "utf8");
  }

  return result;
};

const hasExternalConfig = [
  "COOKIE_SECRET",
  "PASSWORD_PEPPER",
  "CONTENT_ENCRYPTION_KEY",
  "CONTENT_INTEGRITY_KEY",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "BOOTSTRAP_ADMIN_USERNAME",
  "HOST",
  "PORT",
  "SESSION_TTL_HOURS",
  "VERSION_HISTORY_RETENTION",
  "VERSION_HISTORY_COMPRESS_AFTER",
  "WIKI_TITLE",
  "INDEX_BACKEND"
].some((key) => Boolean(process.env[key]));

const installerResult = fs.existsSync(configEnvPath) || !hasExternalConfig
  ? appendMissingEnvKeys(configEnvPath)
  : { created: false };

dotenv.config({
  path: configEnvPath
});

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseIndexBackend = (value: string | undefined): IndexBackend => {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "sqlite" ? "sqlite" : "flat";
};

const parseHexKey = (value: string | undefined, name: string): Buffer | null => {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    console.warn(`[WARN] ${name} ungültig. Erwartet: 64 Hex-Zeichen.`);
    return null;
  }

  try {
    return Buffer.from(raw, "hex");
  } catch {
    return null;
  }
};

const parseEncryptionKey = (value: string | undefined): Buffer | null => parseHexKey(value, "CONTENT_ENCRYPTION_KEY");
const parseIntegrityKey = (value: string | undefined): Buffer | null => parseHexKey(value, "CONTENT_INTEGRITY_KEY");

const runtimeEncryptionKey = parseEncryptionKey(process.env.CONTENT_ENCRYPTION_KEY);
const runtimeIntegrityKey = parseIntegrityKey(process.env.CONTENT_INTEGRITY_KEY);

export const config = {
  rootDir,
  port: parsePositiveInt(process.env.PORT, 3000),
  host: process.env.HOST ?? "0.0.0.0",
  cookieSecret: process.env.COOKIE_SECRET ?? "dev-only-change-cookie-secret-please",
  isProduction: process.env.NODE_ENV === "production",
  sessionTtlHours: parsePositiveInt(process.env.SESSION_TTL_HOURS, 12),
  versionHistoryRetention: parsePositiveInt(process.env.VERSION_HISTORY_RETENTION, 150),
  versionHistoryCompressAfter: parseNonNegativeInt(process.env.VERSION_HISTORY_COMPRESS_AFTER, 30),
  wikiTitle: process.env.WIKI_TITLE ?? "FlatWiki",
  indexBackend: parseIndexBackend(process.env.INDEX_BACKEND),
  bootstrapAdminUsername: process.env.BOOTSTRAP_ADMIN_USERNAME ?? "admin",
  contentEncryptionKey: runtimeEncryptionKey,
  contentIntegrityKey: runtimeIntegrityKey,
  dataDir: path.join(rootDir, "data"),
  indexDir: path.join(rootDir, "data", "index"),
  searchIndexFile: path.join(rootDir, "data", "index", "pages.json"),
  sqliteIndexFile: path.join(rootDir, "data", "index", "pages.sqlite"),
  runtimeSettingsFile: path.join(rootDir, "data", "runtime-settings.json"),
  wikiDir: path.join(rootDir, "data", "wiki"),
  uploadDir: path.join(rootDir, "data", "uploads"),
  versionsDir: path.join(rootDir, "data", "versions"),
  categoriesFile: path.join(rootDir, "data", "categories.json"),
  groupsFile: path.join(rootDir, "data", "groups.json"),
  usersFile: path.join(rootDir, "data", "users.json"),
  sessionsFile: path.join(rootDir, "data", "sessions.json"),
  auditFile: path.join(rootDir, "data", "audit.log")
};

if (installerResult.created) {
  console.warn("[INSTALLER] config.env wurde automatisch erstellt.");
}

if (config.cookieSecret === "dev-only-change-cookie-secret-please") {
  console.warn("[WARN] COOKIE_SECRET nicht gesetzt. Bitte in Produktion zwingend setzen.");
}
