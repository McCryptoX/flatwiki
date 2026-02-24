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
export type AttachmentScanMode = "auto" | "required" | "off";
const HOST_PATTERN = /^[a-z0-9:.-]+$/i;
const SCANNER_COMMAND_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const HEX_64_PATTERN = /^[a-f0-9]{64}$/i;

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
    SECRET_ENCRYPTION_KEY: generateHex(32),
    CONTENT_INTEGRITY_KEY: generateHex(32),
    BACKUP_ENCRYPTION_KEY: generateHex(32),
    BACKUP_AUTO_ENABLED: "false",
    BACKUP_AUTO_INTERVAL_HOURS: "24",
    BACKUP_RETENTION_MAX_FILES: "30",
    BACKUP_RETENTION_MAX_AGE_DAYS: "0",
    SESSION_TTL_HOURS: "12",
    VERSION_HISTORY_RETENTION: "150",
    VERSION_HISTORY_COMPRESS_AFTER: "30",
    WIKI_TITLE: "FlatWiki",
    PUBLIC_BASE_URL: "",
    INDEX_BACKEND: "flat",
    ATTACHMENT_SCAN_MODE: "auto",
    ATTACHMENT_SCANNER_CMD: "clamscan",
    TRUST_PROXY: "false",
    UPLOAD_DERIVATIVES_ENABLED: "false",
    BOOTSTRAP_ADMIN_USERNAME: "admin",
    AUDIT_LOG_MAX_SIZE_MB: "10",
    AUDIT_LOG_MAX_AGE_DAYS: "90",
    SMTP_HOST: "",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_USER: "",
    SMTP_PASS: "",
    SMTP_FROM: ""
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
  "SECRET_ENCRYPTION_KEY",
  "CONTENT_INTEGRITY_KEY",
  "BACKUP_ENCRYPTION_KEY",
  "BACKUP_AUTO_ENABLED",
  "BACKUP_AUTO_INTERVAL_HOURS",
  "BACKUP_RETENTION_MAX_FILES",
  "BACKUP_RETENTION_MAX_AGE_DAYS",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "BOOTSTRAP_ADMIN_USERNAME",
  "HOST",
  "PORT",
  "SESSION_TTL_HOURS",
  "VERSION_HISTORY_RETENTION",
  "VERSION_HISTORY_COMPRESS_AFTER",
  "WIKI_TITLE",
  "PUBLIC_BASE_URL",
  "INDEX_BACKEND",
  "ATTACHMENT_SCAN_MODE",
  "ATTACHMENT_SCANNER_CMD",
  "TRUST_PROXY",
  "UPLOAD_DERIVATIVES_ENABLED"
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

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const parseIndexBackend = (value: string | undefined): IndexBackend => {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "sqlite" ? "sqlite" : "flat";
};

const parseAttachmentScanMode = (value: string | undefined): AttachmentScanMode => {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "required") return "required";
  if (normalized === "off") return "off";
  return "auto";
};

const parseHost = (value: string | undefined): string => {
  const normalized = (value ?? "0.0.0.0").trim();
  if (!normalized) return "0.0.0.0";
  if (normalized === "::" || normalized === "::1") return normalized;
  if (!HOST_PATTERN.test(normalized)) {
    console.warn(`[WARN] HOST ungültig (${normalized}). Fallback auf 0.0.0.0.`);
    return "0.0.0.0";
  }
  return normalized;
};

const parseAttachmentScannerCommand = (value: string | undefined): string => {
  const normalized = (value ?? "clamscan").trim();
  if (!normalized) return "clamscan";
  if (!SCANNER_COMMAND_PATTERN.test(normalized)) {
    console.warn(`[WARN] ATTACHMENT_SCANNER_CMD ungültig (${normalized}). Fallback auf clamscan.`);
    return "clamscan";
  }
  return normalized;
};

const parseTrustProxy = (value: string | undefined): boolean => parseBoolean(value, false);

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
const parseSecretEncryptionKey = (value: string | undefined): Buffer | null => parseHexKey(value, "SECRET_ENCRYPTION_KEY");
const parseIntegrityKey = (value: string | undefined): Buffer | null => parseHexKey(value, "CONTENT_INTEGRITY_KEY");

const runtimeEncryptionKey = parseEncryptionKey(process.env.CONTENT_ENCRYPTION_KEY);
const runtimeSecretEncryptionKey = parseSecretEncryptionKey(process.env.SECRET_ENCRYPTION_KEY);
const runtimeIntegrityKey = parseIntegrityKey(process.env.CONTENT_INTEGRITY_KEY);

const isProvided = (value: string | undefined): boolean => value !== undefined && value.trim().length > 0;

const isPositiveIntString = (value: string): boolean => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0;
};

const isNonNegativeIntString = (value: string): boolean => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0;
};

const isBooleanString = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on", "0", "false", "no", "off"].includes(normalized);
};

const collectConfigValidationErrors = (env: NodeJS.ProcessEnv): string[] => {
  const errors: string[] = [];

  const expectPositiveInt = (key: string): void => {
    const value = env[key];
    if (value === undefined) return;
    if (!isPositiveIntString(value)) {
      errors.push(`${key} muss eine positive Ganzzahl sein.`);
    }
  };

  const expectNonNegativeInt = (key: string): void => {
    const value = env[key];
    if (value === undefined) return;
    if (!isNonNegativeIntString(value)) {
      errors.push(`${key} muss eine nicht-negative Ganzzahl sein.`);
    }
  };

  const expectBoolean = (key: string): void => {
    const value = env[key];
    if (value === undefined) return;
    if (!isBooleanString(value)) {
      errors.push(`${key} muss true/false (oder 1/0, yes/no, on/off) sein.`);
    }
  };

  const expectEnum = (key: string, allowed: string[]): void => {
    const value = env[key];
    if (value === undefined) return;
    const normalized = value.trim().toLowerCase();
    if (!allowed.includes(normalized)) {
      errors.push(`${key} muss einer von [${allowed.join(", ")}] sein.`);
    }
  };

  const expectHex64 = (key: string): void => {
    const value = env[key];
    if (!isProvided(value)) return;
    if (!HEX_64_PATTERN.test(value ?? "")) {
      errors.push(`${key} muss aus genau 64 Hex-Zeichen bestehen.`);
    }
  };

  const host = env.HOST;
  if (isProvided(host)) {
    const normalized = host!.trim();
    if (normalized !== "::" && normalized !== "::1" && !HOST_PATTERN.test(normalized)) {
      errors.push("HOST enthält ungültige Zeichen.");
    }
  }

  const scannerCommand = env.ATTACHMENT_SCANNER_CMD;
  if (isProvided(scannerCommand) && !SCANNER_COMMAND_PATTERN.test(scannerCommand ?? "")) {
    errors.push("ATTACHMENT_SCANNER_CMD enthält ungültige Zeichen.");
  }

  expectPositiveInt("PORT");
  expectPositiveInt("SESSION_TTL_HOURS");
  expectPositiveInt("BACKUP_AUTO_INTERVAL_HOURS");
  expectPositiveInt("VERSION_HISTORY_RETENTION");
  expectPositiveInt("SMTP_PORT");

  expectNonNegativeInt("BACKUP_RETENTION_MAX_FILES");
  expectNonNegativeInt("BACKUP_RETENTION_MAX_AGE_DAYS");
  expectNonNegativeInt("VERSION_HISTORY_COMPRESS_AFTER");
  expectNonNegativeInt("AUDIT_LOG_MAX_SIZE_MB");
  expectNonNegativeInt("AUDIT_LOG_MAX_AGE_DAYS");

  expectBoolean("BACKUP_AUTO_ENABLED");
  expectBoolean("SMTP_SECURE");
  expectBoolean("TRUST_PROXY");
  expectBoolean("UPLOAD_DERIVATIVES_ENABLED");

  expectEnum("INDEX_BACKEND", ["flat", "sqlite"]);
  expectEnum("ATTACHMENT_SCAN_MODE", ["auto", "required", "off"]);

  expectHex64("CONTENT_ENCRYPTION_KEY");
  expectHex64("SECRET_ENCRYPTION_KEY");
  expectHex64("CONTENT_INTEGRITY_KEY");
  expectHex64("BACKUP_ENCRYPTION_KEY");

  return errors;
};

const configValidationErrors = collectConfigValidationErrors(process.env);
if (configValidationErrors.length > 0) {
  for (const error of configValidationErrors) {
    console.error(`[FATAL] Konfigurationsfehler: ${error}`);
  }
  process.exit(1);
}

export const config = {
  rootDir,
  port: parsePositiveInt(process.env.PORT, 3000),
  host: parseHost(process.env.HOST),
  cookieSecret: process.env.COOKIE_SECRET ?? "dev-only-change-cookie-secret-please",
  isProduction: process.env.NODE_ENV === "production",
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  uploadDerivativesEnabled: parseBoolean(process.env.UPLOAD_DERIVATIVES_ENABLED, false),
  sessionTtlHours: parsePositiveInt(process.env.SESSION_TTL_HOURS, 12),
  backupAutoEnabled: parseBoolean(process.env.BACKUP_AUTO_ENABLED, false),
  backupAutoIntervalHours: parsePositiveInt(process.env.BACKUP_AUTO_INTERVAL_HOURS, 24),
  backupRetentionMaxFiles: parseNonNegativeInt(process.env.BACKUP_RETENTION_MAX_FILES, 30),
  backupRetentionMaxAgeDays: parseNonNegativeInt(process.env.BACKUP_RETENTION_MAX_AGE_DAYS, 0),
  versionHistoryRetention: parsePositiveInt(process.env.VERSION_HISTORY_RETENTION, 150),
  versionHistoryCompressAfter: parseNonNegativeInt(process.env.VERSION_HISTORY_COMPRESS_AFTER, 30),
  wikiTitle: process.env.WIKI_TITLE ?? "FlatWiki",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, ""),
  indexBackend: parseIndexBackend(process.env.INDEX_BACKEND),
  attachmentScanMode: parseAttachmentScanMode(process.env.ATTACHMENT_SCAN_MODE),
  attachmentScannerCommand: parseAttachmentScannerCommand(process.env.ATTACHMENT_SCANNER_CMD),
  bootstrapAdminUsername: process.env.BOOTSTRAP_ADMIN_USERNAME ?? "admin",
  contentEncryptionKey: runtimeEncryptionKey,
  // Secret-storage key is separated from article encryption key.
  // Fallback to CONTENT_ENCRYPTION_KEY keeps existing installs readable.
  secretEncryptionKey: runtimeSecretEncryptionKey ?? runtimeEncryptionKey,
  contentIntegrityKey: runtimeIntegrityKey,
  dataDir: path.join(rootDir, "data"),
  indexDir: path.join(rootDir, "data", "index"),
  searchIndexFile: path.join(rootDir, "data", "index", "pages.json"),
  sqliteIndexFile: path.join(rootDir, "data", "index", "pages.sqlite"),
  runtimeSettingsFile: path.join(rootDir, "data", "runtime-settings.json"),
  robotsFile: path.join(rootDir, "data", "robots.txt"),
  wikiDir: path.join(rootDir, "data", "wiki"),
  uploadDir: path.join(rootDir, "data", "uploads"),
  uploadSecurityFile: path.join(rootDir, "data", "upload-security.json"),
  versionsDir: path.join(rootDir, "data", "versions"),
  backupDir: path.join(rootDir, "data", "backups"),
  categoriesFile: path.join(rootDir, "data", "categories.json"),
  templatesFile: path.join(rootDir, "data", "templates.json"),
  groupsFile: path.join(rootDir, "data", "groups.json"),
  usersFile: path.join(rootDir, "data", "users.json"),
  sessionsFile: path.join(rootDir, "data", "sessions.json"),
  pageViewsFile: path.join(rootDir, "data", "page-views.json"),
  pageViewsSqliteFile: path.join(rootDir, "data", "page-views.sqlite"),
  commentsFile: path.join(rootDir, "data", "comments.json"),
  watchFile: path.join(rootDir, "data", "watch.json"),
  notificationsFile: path.join(rootDir, "data", "notifications.json"),
  workflowFile: path.join(rootDir, "data", "workflow.json"),
  attachmentsRootDir: path.join(rootDir, "data", "attachments"),
  attachmentsFileDir: path.join(rootDir, "data", "attachments", "files"),
  attachmentsQuarantineDir: path.join(rootDir, "data", "attachments", "quarantine"),
  attachmentsFile: path.join(rootDir, "data", "attachments", "attachments.json"),
  auditFile: path.join(rootDir, "data", "audit.log"),
  auditLogMaxSizeMb: parseNonNegativeInt(process.env.AUDIT_LOG_MAX_SIZE_MB, 10),
  auditLogMaxAgeDays: parseNonNegativeInt(process.env.AUDIT_LOG_MAX_AGE_DAYS, 90),
  smtpHost: (process.env.SMTP_HOST ?? "").trim(),
  smtpPort: parsePositiveInt(process.env.SMTP_PORT, 587),
  smtpSecure: parseBoolean(process.env.SMTP_SECURE, false),
  smtpUser: (process.env.SMTP_USER ?? "").trim(),
  smtpPass: process.env.SMTP_PASS ?? "",
  smtpFrom: (process.env.SMTP_FROM ?? "").trim()
};

if (installerResult.created) {
  console.warn("[INSTALLER] config.env wurde automatisch erstellt.");
}

if (config.cookieSecret === "dev-only-change-cookie-secret-please") {
  if (config.isProduction) {
    console.error("[FATAL] COOKIE_SECRET nicht gesetzt. In Produktion zwingend erforderlich.");
    process.exit(1);
  }
  console.warn("[WARN] COOKIE_SECRET nicht gesetzt. Bitte in Produktion zwingend setzen.");
}
