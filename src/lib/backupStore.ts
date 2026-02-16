import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { ensureDir, ensureFile, removeFile } from "./fileStore.js";
import { ensureSearchIndexConsistency } from "./searchIndexStore.js";

const BACKUP_MAGIC = "FLATWIKI_BACKUP_V1";
const KDF_N = 1 << 15;
const KDF_R = 8;
const KDF_P = 1;
const SAFE_BACKUP_FILE_PATTERN = /^flatwiki-backup-[0-9]{8}-[0-9]{6}\.tar\.gz\.enc$/;
const RESTORE_UPLOAD_FILE_PATTERN = /^restore-upload-[0-9]{8}-[0-9]{6}-[a-f0-9]{10}\.tar\.gz\.enc$/;
const RESTORE_TICKET_TTL_MS = 20 * 60 * 1000;

const RESTORE_STAGE_DIR = path.join(config.backupDir, ".restore-stage");
const RESTORE_WORK_DIR = path.join(config.backupDir, ".restore-work");

type BackupPhase = "idle" | "preparing" | "packing" | "encrypting" | "writing" | "done" | "error";
type RestorePhase = "idle" | "decrypting" | "extracting" | "replacing" | "reindexing" | "done" | "error";

interface BackupHeaderMetadata {
  v: number;
  alg: string;
  kdf: {
    name: string;
    n: number;
    r: number;
    p: number;
  };
  salt: string;
  iv: string;
  tag: string;
  createdAt?: string;
  source?: string;
}

interface ParsedBackupHeader {
  metadata: BackupHeaderMetadata;
  headerBytes: number;
  encryptedBytes: number;
}

export interface BackupStatus {
  running: boolean;
  phase: BackupPhase;
  message: string;
  startedAt?: string;
  finishedAt?: string;
  percent: number;
  processedFiles: number;
  totalFiles: number;
  archiveFileName?: string;
  archiveSizeBytes?: number;
  error?: string;
}

export interface RestoreStatus {
  running: boolean;
  phase: RestorePhase;
  message: string;
  startedAt?: string;
  finishedAt?: string;
  percent: number;
  sourceFileName?: string;
  processedEntries: number;
  totalEntries: number;
  error?: string;
}

export interface BackupFileInfo {
  fileName: string;
  sizeBytes: number;
  modifiedAt: string;
  hasChecksum: boolean;
}

export interface PreparedRestoreInfo {
  id: string;
  uploadedFileName: string;
  stagedFileName: string;
  encryptedSizeBytes: number;
  archiveEntries: number;
  backupCreatedAt?: string;
  createdAt: string;
  expiresAt: string;
}

interface PreparedRestoreTicket extends PreparedRestoreInfo {
  stagedFilePath: string;
  createdByUserId?: string;
}

const defaultStatus = (): BackupStatus => ({
  running: false,
  phase: "idle",
  message: "Bereit",
  percent: 0,
  processedFiles: 0,
  totalFiles: 0
});

const defaultRestoreStatus = (): RestoreStatus => ({
  running: false,
  phase: "idle",
  message: "Bereit",
  percent: 0,
  processedEntries: 0,
  totalEntries: 0
});

let backupStatus: BackupStatus = defaultStatus();
let restoreStatus: RestoreStatus = defaultRestoreStatus();
let backupPromise: Promise<void> | null = null;
let restorePromise: Promise<void> | null = null;
let preparedRestoreTicket: PreparedRestoreTicket | null = null;

const toSafePercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const updateStatus = (patch: Partial<BackupStatus>): void => {
  backupStatus = {
    ...backupStatus,
    ...patch,
    percent: patch.percent === undefined ? backupStatus.percent : toSafePercent(patch.percent)
  };
};

const updateRestoreStatus = (patch: Partial<RestoreStatus>): void => {
  restoreStatus = {
    ...restoreStatus,
    ...patch,
    percent: patch.percent === undefined ? restoreStatus.percent : toSafePercent(patch.percent)
  };
};

const makeTimestamp = (): string => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

const isPathInside = (filePath: string, parentDir: string): boolean => {
  const relative = path.relative(path.resolve(parentDir), path.resolve(filePath));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const clearPreparedRestoreTicket = async (): Promise<void> => {
  if (!preparedRestoreTicket) return;
  await removeFile(preparedRestoreTicket.stagedFilePath);
  preparedRestoreTicket = null;
};

const pruneExpiredPreparedRestoreTicket = async (): Promise<void> => {
  if (!preparedRestoreTicket) return;
  if (Date.parse(preparedRestoreTicket.expiresAt) > Date.now()) return;
  await clearPreparedRestoreTicket();
};

const toPreparedRestoreInfo = (ticket: PreparedRestoreTicket): PreparedRestoreInfo => ({
  id: ticket.id,
  uploadedFileName: ticket.uploadedFileName,
  stagedFileName: ticket.stagedFileName,
  encryptedSizeBytes: ticket.encryptedSizeBytes,
  archiveEntries: ticket.archiveEntries,
  ...(ticket.backupCreatedAt ? { backupCreatedAt: ticket.backupCreatedAt } : {}),
  createdAt: ticket.createdAt,
  expiresAt: ticket.expiresAt
});

const decodeBase64Buffer = (value: string, fieldName: string): Buffer => {
  try {
    const buffer = Buffer.from(value, "base64");
    if (buffer.length < 1) {
      throw new Error(`${fieldName} ist leer.`);
    }
    return buffer;
  } catch {
    throw new Error(`Ungültiges Feld im Backup-Header: ${fieldName}.`);
  }
};

const parseBackupHeader = async (filePath: string): Promise<ParsedBackupHeader> => {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error("Backup-Datei fehlt.");
  }

  if (stats.size < 32) {
    throw new Error("Backup-Datei ist zu klein.");
  }

  const handle = await fs.open(filePath, "r");
  try {
    const maxHeaderBytes = 64 * 1024;
    const headerBuffer = Buffer.alloc(maxHeaderBytes);
    const { bytesRead } = await handle.read(headerBuffer, 0, maxHeaderBytes, 0);
    if (bytesRead < 3) {
      throw new Error("Backup-Header fehlt oder ist beschädigt.");
    }

    const payload = headerBuffer.subarray(0, bytesRead);
    const firstBreak = payload.indexOf(0x0a);
    const secondBreak = payload.indexOf(0x0a, firstBreak + 1);

    if (firstBreak < 0 || secondBreak < 0) {
      throw new Error("Backup-Header unvollständig.");
    }

    const magic = payload.subarray(0, firstBreak).toString("utf8").replace(/\r$/, "").trim();
    if (magic !== BACKUP_MAGIC) {
      throw new Error("Ungültiges Backup-Format.");
    }

    const metadataRaw = payload.subarray(firstBreak + 1, secondBreak).toString("utf8").trim();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(metadataRaw);
    } catch {
      throw new Error("Backup-Metadaten sind ungültig.");
    }

    if (!parsedJson || typeof parsedJson !== "object") {
      throw new Error("Backup-Metadaten fehlen.");
    }

    const metadata = parsedJson as Record<string, unknown>;
    const kdf = metadata.kdf as Record<string, unknown> | undefined;

    if (metadata.alg !== "aes-256-gcm") {
      throw new Error("Backup-Algorithmus wird nicht unterstützt.");
    }

    if (!kdf || kdf.name !== "scrypt") {
      throw new Error("Backup-KDF wird nicht unterstützt.");
    }

    const n = Number(kdf.n);
    const r = Number(kdf.r);
    const p = Number(kdf.p);

    if (!Number.isFinite(n) || n < 2 || !Number.isFinite(r) || r < 1 || !Number.isFinite(p) || p < 1) {
      throw new Error("Backup-KDF-Parameter sind ungültig.");
    }

    const salt = typeof metadata.salt === "string" ? metadata.salt : "";
    const iv = typeof metadata.iv === "string" ? metadata.iv : "";
    const tag = typeof metadata.tag === "string" ? metadata.tag : "";

    const saltBuffer = decodeBase64Buffer(salt, "salt");
    const ivBuffer = decodeBase64Buffer(iv, "iv");
    const tagBuffer = decodeBase64Buffer(tag, "tag");

    if (ivBuffer.length !== 12) {
      throw new Error("Backup-IV hat ein ungültiges Format.");
    }

    if (tagBuffer.length !== 16) {
      throw new Error("Backup-Auth-Tag hat ein ungültiges Format.");
    }

    if (saltBuffer.length < 8) {
      throw new Error("Backup-Salt ist zu kurz.");
    }

    const headerBytes = secondBreak + 1;
    if (headerBytes >= stats.size) {
      throw new Error("Backup enthält keinen verschlüsselten Inhalt.");
    }

    const encryptedBytes = stats.size - headerBytes;

    return {
      metadata: {
        v: Number(metadata.v) || 1,
        alg: "aes-256-gcm",
        kdf: {
          name: "scrypt",
          n,
          r,
          p
        },
        salt,
        iv,
        tag,
        ...(typeof metadata.createdAt === "string" && metadata.createdAt.trim().length > 0
          ? { createdAt: metadata.createdAt }
          : {}),
        ...(typeof metadata.source === "string" && metadata.source.trim().length > 0 ? { source: metadata.source } : {})
      },
      headerBytes,
      encryptedBytes
    };
  } finally {
    await handle.close();
  }
};

const mapDecryptError = (error: unknown): Error => {
  if (error instanceof Error) {
    const normalized = error.message.toLowerCase();
    if (normalized.includes("authenticate") || normalized.includes("unable to") || normalized.includes("bad decrypt")) {
      return new Error("Passphrase ungültig oder Backup-Datei beschädigt.");
    }

    return error;
  }

  return new Error("Entschlüsselung fehlgeschlagen.");
};

const decryptBackupToArchive = async (input: {
  encryptedFilePath: string;
  outputArchivePath: string;
  passphrase: string;
  onProgress?: (processedBytes: number, totalBytes: number) => void;
}): Promise<{ metadata: BackupHeaderMetadata; archiveSizeBytes: number }> => {
  const parsed = await parseBackupHeader(input.encryptedFilePath);

  const salt = decodeBase64Buffer(parsed.metadata.salt, "salt");
  const iv = decodeBase64Buffer(parsed.metadata.iv, "iv");
  const tag = decodeBase64Buffer(parsed.metadata.tag, "tag");

  const key = scryptSync(input.passphrase, salt, 32, {
    N: parsed.metadata.kdf.n,
    r: parsed.metadata.kdf.r,
    p: parsed.metadata.kdf.p,
    maxmem: 96 * 1024 * 1024
  });

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  let processedBytes = 0;
  const source = createReadStream(input.encryptedFilePath, {
    start: parsed.headerBytes
  });

  source.on("data", (chunk: Buffer | string) => {
    processedBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    input.onProgress?.(processedBytes, parsed.encryptedBytes);
  });

  try {
    await pipeline(source, decipher, createWriteStream(input.outputArchivePath, { flags: "wx" }));
  } catch (error) {
    await removeFile(input.outputArchivePath);
    throw mapDecryptError(error);
  }

  const archiveStats = await fs.stat(input.outputArchivePath);

  return {
    metadata: parsed.metadata,
    archiveSizeBytes: archiveStats.size
  };
};

const listArchiveEntries = async (archivePath: string): Promise<{ entryCount: number; hasDataRoot: boolean }> => {
  return new Promise<{ entryCount: number; hasDataRoot: boolean }>((resolve, reject) => {
    const tar = spawn("tar", ["-tzf", archivePath], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let entryCount = 0;
    let hasDataRoot = false;

    tar.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const normalized = line.trim();
        if (!normalized) continue;
        entryCount += 1;
        if (normalized === "data" || normalized === "data/" || normalized.startsWith("data/")) {
          hasDataRoot = true;
        }
      }
    });

    tar.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderrBuffer.trim() || `tar -tzf fehlgeschlagen (Exit ${code ?? -1}).`));
        return;
      }

      resolve({
        entryCount,
        hasDataRoot
      });
    });
  });
};

const extractArchive = async (input: {
  archivePath: string;
  targetDir: string;
  onEntry?: (processedEntries: number) => void;
}): Promise<void> => {
  await ensureDir(input.targetDir);

  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-xzvf", input.archivePath, "-C", input.targetDir], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let processedEntries = 0;

    tar.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        processedEntries += 1;
        input.onEntry?.(processedEntries);
      }
    });

    tar.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderrBuffer.trim() || `tar -xzf fehlgeschlagen (Exit ${code ?? -1}).`));
    });
  });
};

const ensureDataScaffold = async (): Promise<void> => {
  await ensureDir(config.dataDir);
  await ensureDir(config.indexDir);
  await ensureDir(config.wikiDir);
  await ensureDir(config.uploadDir);
  await ensureDir(config.versionsDir);
  await ensureDir(config.backupDir);

  await ensureFile(config.categoriesFile, "[]\n");
  await ensureFile(config.groupsFile, "[]\n");
  await ensureFile(config.usersFile, "[]\n");
  await ensureFile(config.sessionsFile, "[]\n");
  await ensureFile(config.auditFile, "");
  await ensureFile(config.runtimeSettingsFile, "{}\n");
};

const replaceDataFromExtracted = async (extractedDataDir: string): Promise<void> => {
  await ensureDir(config.dataDir);

  let currentEntries: Array<{ name: string }> = [];
  try {
    currentEntries = await fs.readdir(config.dataDir, { withFileTypes: true });
  } catch {
    currentEntries = [];
  }

  for (const entry of currentEntries) {
    if (entry.name === "backups") {
      continue;
    }

    await fs.rm(path.join(config.dataDir, entry.name), {
      recursive: true,
      force: true
    });
  }

  const sourceEntries = await fs.readdir(extractedDataDir, { withFileTypes: true });
  for (const entry of sourceEntries) {
    if (entry.name === "backups") {
      continue;
    }

    await fs.cp(path.join(extractedDataDir, entry.name), path.join(config.dataDir, entry.name), {
      recursive: true,
      force: true
    });
  }

  await ensureDataScaffold();
};

const listDataFiles = async (root: string, current = root): Promise<string[]> => {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await fs.readdir(current, {
      withFileTypes: true,
      encoding: "utf8"
    })) as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (path.normalize(fullPath) === path.normalize(config.backupDir)) {
        continue;
      }
      files.push(...(await listDataFiles(root, fullPath)));
      continue;
    }

    if (!entry.isFile()) continue;
    files.push(path.relative(config.rootDir, fullPath).replace(/\\/g, "/"));
  }

  return files;
};

const runTarArchive = async (tmpArchivePath: string, totalFiles: number): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const tarArgs = ["-czvf", tmpArchivePath, "--exclude=data/backups", "-C", config.rootDir, "data"];
    const tar = spawn("tar", tarArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let processed = 0;

    const handleStdoutChunk = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        processed += 1;
        const percentBase = totalFiles > 0 ? 10 + (processed / totalFiles) * 55 : 65;
        updateStatus({
          phase: "packing",
          message: totalFiles > 0 ? `Dateien werden gepackt (${Math.min(processed, totalFiles)}/${totalFiles})...` : "Dateien werden gepackt...",
          processedFiles: Math.min(processed, totalFiles),
          percent: Math.min(percentBase, 65)
        });
      }
    };

    tar.stdout.on("data", handleStdoutChunk);
    tar.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    tar.on("error", (error) => {
      reject(error);
    });

    tar.on("close", (code) => {
      if (code === 0) {
        updateStatus({
          phase: "packing",
          message: "Packen abgeschlossen.",
          processedFiles: totalFiles,
          percent: 65
        });
        resolve();
        return;
      }

      reject(new Error(stderrBuffer.trim() || `tar beendet mit Exit-Code ${code ?? -1}`));
    });
  });
};

const buildEncryptedBackup = async (input: {
  tmpArchivePath: string;
  targetFilePath: string;
  backupPassphrase: string;
}): Promise<void> => {
  const stats = await fs.stat(input.tmpArchivePath);
  const totalBytes = Math.max(stats.size, 1);

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(input.backupPassphrase, salt, 32, {
    N: KDF_N,
    r: KDF_R,
    p: KDF_P,
    maxmem: 96 * 1024 * 1024
  });

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const tmpCipherPath = `${input.targetFilePath}.cipherpart`;
  const tmpOutputPath = `${input.targetFilePath}.tmp`;
  try {
    let processedBytes = 0;
    const source = createReadStream(input.tmpArchivePath);
    source.on("data", (chunk: Buffer | string) => {
      processedBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      const ratio = Math.min(processedBytes / totalBytes, 1);
      updateStatus({
        phase: "encrypting",
        message: "Backup wird verschlüsselt...",
        percent: 65 + ratio * 25
      });
    });

    await pipeline(source, cipher, createWriteStream(tmpCipherPath, { flags: "wx" }));
    const authTag = cipher.getAuthTag();

    const metadata = {
      v: 1,
      alg: "aes-256-gcm",
      kdf: {
        name: "scrypt",
        n: KDF_N,
        r: KDF_R,
        p: KDF_P
      },
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: authTag.toString("base64"),
      createdAt: new Date().toISOString(),
      source: "data"
    };

    await new Promise<void>((resolve, reject) => {
      const destination = createWriteStream(tmpOutputPath, { flags: "wx" });
      destination.on("error", reject);

      destination.write(`${BACKUP_MAGIC}\n${JSON.stringify(metadata)}\n`, "utf8", (writeError) => {
        if (writeError) {
          reject(writeError);
          return;
        }

        void fs
          .stat(tmpCipherPath)
          .then((cipherStats) => {
            const cipherTotal = Math.max(cipherStats.size, 1);
            let copied = 0;
            const encryptedSource = createReadStream(tmpCipherPath);
            encryptedSource.on("data", (chunk: Buffer | string) => {
              copied += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
              const ratio = Math.min(copied / cipherTotal, 1);
              updateStatus({
                phase: "writing",
                message: "Backup-Datei wird geschrieben...",
                percent: 90 + ratio * 8
              });
            });

            encryptedSource.on("error", reject);
            encryptedSource.on("end", () => {
              destination.end();
            });
            encryptedSource.pipe(destination, { end: false });
          })
          .catch(reject);
      });

      destination.on("finish", resolve);
    });

    await fs.rename(tmpOutputPath, input.targetFilePath);

    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const encryptedStream = createReadStream(input.targetFilePath);
      encryptedStream.on("data", (chunk: Buffer | string) => {
        hash.update(chunk);
      });
      encryptedStream.on("error", reject);
      encryptedStream.on("end", () => resolve());
    });

    const digest = hash.digest("hex");
    await fs.writeFile(`${input.targetFilePath}.sha256`, `${digest}  ${path.basename(input.targetFilePath)}\n`, "utf8");
  } finally {
    await removeFile(tmpCipherPath);
    await removeFile(tmpOutputPath);
  }
};

const runBackup = async (): Promise<void> => {
  const backupPassphrase = (process.env.BACKUP_ENCRYPTION_KEY ?? "").trim();
  if (!backupPassphrase) {
    throw new Error("BACKUP_ENCRYPTION_KEY fehlt. Backup kann nicht gestartet werden.");
  }

  if (config.contentEncryptionKey) {
    const contentKeyHex = config.contentEncryptionKey.toString("hex");
    if (backupPassphrase === contentKeyHex) {
      throw new Error("BACKUP_ENCRYPTION_KEY darf nicht identisch mit CONTENT_ENCRYPTION_KEY sein.");
    }
  }

  await ensureDir(config.backupDir);

  const timestamp = makeTimestamp();
  const outputFileName = `flatwiki-backup-${timestamp}.tar.gz.enc`;
  const outputFilePath = path.join(config.backupDir, outputFileName);
  const tmpArchivePath = path.join(config.backupDir, `.tmp-${outputFileName}.tar.gz`);

  const files = await listDataFiles(config.dataDir);
  const totalFiles = files.length;

  updateStatus({
    phase: "preparing",
    message: "Backup wird vorbereitet...",
    percent: 10,
    totalFiles,
    processedFiles: 0,
    archiveFileName: outputFileName,
    ...(backupStatus.startedAt ? { startedAt: backupStatus.startedAt } : {})
  });

  try {
    await runTarArchive(tmpArchivePath, totalFiles);
    await buildEncryptedBackup({
      tmpArchivePath,
      targetFilePath: outputFilePath,
      backupPassphrase
    });

    const encryptedStats = await fs.stat(outputFilePath);
    updateStatus({
      running: false,
      phase: "done",
      message: "Backup erfolgreich erstellt.",
      percent: 100,
      finishedAt: new Date().toISOString(),
      archiveFileName: outputFileName,
      archiveSizeBytes: encryptedStats.size
    });
  } finally {
    await removeFile(tmpArchivePath);
  }
};

const runRestore = async (ticket: PreparedRestoreTicket, restorePassphrase: string): Promise<void> => {
  await ensureDir(RESTORE_WORK_DIR);
  const runId = randomBytes(6).toString("hex");
  const runDir = path.join(RESTORE_WORK_DIR, `run-${runId}`);
  const archivePath = path.join(runDir, "restore.tar.gz");
  const extractDir = path.join(runDir, "extract");

  try {
    await ensureDir(runDir);

    updateRestoreStatus({
      phase: "decrypting",
      message: "Backup wird entschlüsselt...",
      percent: 8,
      processedEntries: 0,
      totalEntries: Math.max(ticket.archiveEntries, 1)
    });

    await decryptBackupToArchive({
      encryptedFilePath: ticket.stagedFilePath,
      outputArchivePath: archivePath,
      passphrase: restorePassphrase,
      onProgress: (processedBytes, totalBytes) => {
        const ratio = totalBytes > 0 ? Math.min(processedBytes / totalBytes, 1) : 1;
        updateRestoreStatus({
          phase: "decrypting",
          message: "Backup wird entschlüsselt...",
          percent: 8 + ratio * 24
        });
      }
    });

    const inspected = await listArchiveEntries(archivePath);
    if (!inspected.hasDataRoot) {
      throw new Error("Backup enthält keinen data/ Ordner.");
    }

    const totalEntries = Math.max(inspected.entryCount, 1);
    updateRestoreStatus({
      phase: "extracting",
      message: "Backup wird entpackt...",
      percent: 34,
      processedEntries: 0,
      totalEntries
    });

    await extractArchive({
      archivePath,
      targetDir: extractDir,
      onEntry: (processedEntries) => {
        const ratio = Math.min(processedEntries / totalEntries, 1);
        updateRestoreStatus({
          phase: "extracting",
          message: `Backup wird entpackt (${Math.min(processedEntries, totalEntries)}/${totalEntries})...`,
          processedEntries: Math.min(processedEntries, totalEntries),
          totalEntries,
          percent: 34 + ratio * 36
        });
      }
    });

    const restoredDataDir = path.join(extractDir, "data");
    try {
      const restoredDataStats = await fs.stat(restoredDataDir);
      if (!restoredDataStats.isDirectory()) {
        throw new Error("Restore-Archiv enthält keinen gültigen data/ Ordner.");
      }
    } catch {
      throw new Error("Restore-Archiv enthält keinen gültigen data/ Ordner.");
    }

    updateRestoreStatus({
      phase: "replacing",
      message: "Dateisystem wird ersetzt...",
      percent: 74
    });

    await replaceDataFromExtracted(restoredDataDir);

    updateRestoreStatus({
      phase: "reindexing",
      message: "Suchindex wird geprüft...",
      percent: 88
    });

    await ensureSearchIndexConsistency();

    updateRestoreStatus({
      running: false,
      phase: "done",
      message: "Wiederherstellung abgeschlossen.",
      percent: 100,
      finishedAt: new Date().toISOString(),
      processedEntries: totalEntries,
      totalEntries
    });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    await removeFile(ticket.stagedFilePath);
  }
};

export const getBackupStatus = (): BackupStatus => ({ ...backupStatus });

export const getRestoreStatus = (): RestoreStatus => ({ ...restoreStatus });

export const getPreparedRestoreInfo = async (actorId?: string): Promise<PreparedRestoreInfo | null> => {
  await pruneExpiredPreparedRestoreTicket();
  if (!preparedRestoreTicket) return null;

  if (
    actorId &&
    preparedRestoreTicket.createdByUserId &&
    preparedRestoreTicket.createdByUserId.trim().length > 0 &&
    preparedRestoreTicket.createdByUserId !== actorId
  ) {
    return null;
  }

  return toPreparedRestoreInfo(preparedRestoreTicket);
};

export const createRestoreUploadTarget = async (): Promise<{ fileName: string; filePath: string }> => {
  await ensureDir(RESTORE_STAGE_DIR);
  const fileName = `restore-upload-${makeTimestamp()}-${randomBytes(5).toString("hex")}.tar.gz.enc`;
  return {
    fileName,
    filePath: path.join(RESTORE_STAGE_DIR, fileName)
  };
};

export const prepareRestoreUpload = async (input: {
  stagedFilePath: string;
  stagedFileName: string;
  uploadedFileName: string;
  passphrase: string;
  actorId?: string;
}): Promise<{ ok: true; prepared: PreparedRestoreInfo } | { ok: false; error: string }> => {
  if (backupPromise || restorePromise) {
    return {
      ok: false,
      error: "Während eines laufenden Backups/Restores ist keine Vorbereitung möglich."
    };
  }

  const passphrase = input.passphrase.trim();
  if (!passphrase) {
    await removeFile(input.stagedFilePath);
    return {
      ok: false,
      error: "Backup-Passphrase fehlt."
    };
  }

  if (!RESTORE_UPLOAD_FILE_PATTERN.test(input.stagedFileName)) {
    await removeFile(input.stagedFilePath);
    return {
      ok: false,
      error: "Ungültiger Upload-Dateiname."
    };
  }

  if (!isPathInside(input.stagedFilePath, RESTORE_STAGE_DIR)) {
    await removeFile(input.stagedFilePath);
    return {
      ok: false,
      error: "Ungültiger Upload-Pfad."
    };
  }

  const originalName = input.uploadedFileName.trim() || input.stagedFileName;
  if (!originalName.toLowerCase().endsWith(".tar.gz.enc")) {
    await removeFile(input.stagedFilePath);
    return {
      ok: false,
      error: "Nur Dateien mit Endung .tar.gz.enc sind erlaubt."
    };
  }

  let stagedSize = 0;
  try {
    const stagedStats = await fs.stat(input.stagedFilePath);
    if (!stagedStats.isFile()) {
      throw new Error("Upload-Datei nicht gefunden.");
    }
    stagedSize = stagedStats.size;
  } catch {
    await removeFile(input.stagedFilePath);
    return {
      ok: false,
      error: "Upload-Datei konnte nicht gelesen werden."
    };
  }

  await ensureDir(RESTORE_WORK_DIR);
  const tempArchivePath = path.join(RESTORE_WORK_DIR, `validate-${randomBytes(5).toString("hex")}.tar.gz`);

  try {
    const decrypted = await decryptBackupToArchive({
      encryptedFilePath: input.stagedFilePath,
      outputArchivePath: tempArchivePath,
      passphrase
    });

    const inspected = await listArchiveEntries(tempArchivePath);
    if (!inspected.hasDataRoot) {
      throw new Error("Backup enthält keinen data/ Ordner.");
    }

    await clearPreparedRestoreTicket();

    const now = new Date();
    const ticket: PreparedRestoreTicket = {
      id: randomBytes(10).toString("hex"),
      uploadedFileName: originalName,
      stagedFileName: input.stagedFileName,
      stagedFilePath: input.stagedFilePath,
      encryptedSizeBytes: stagedSize,
      archiveEntries: inspected.entryCount,
      ...(decrypted.metadata.createdAt ? { backupCreatedAt: decrypted.metadata.createdAt } : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RESTORE_TICKET_TTL_MS).toISOString(),
      ...(input.actorId ? { createdByUserId: input.actorId } : {})
    };

    preparedRestoreTicket = ticket;

    return {
      ok: true,
      prepared: toPreparedRestoreInfo(ticket)
    };
  } catch (error) {
    await removeFile(input.stagedFilePath);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Backup konnte nicht geprüft werden."
    };
  } finally {
    await removeFile(tempArchivePath);
  }
};

export const cancelPreparedRestore = async (input: { ticketId: string; actorId?: string }): Promise<boolean> => {
  await pruneExpiredPreparedRestoreTicket();
  if (!preparedRestoreTicket) return false;

  const ticketId = String(input.ticketId ?? "").trim();
  if (!ticketId || ticketId !== preparedRestoreTicket.id) return false;

  if (
    input.actorId &&
    preparedRestoreTicket.createdByUserId &&
    preparedRestoreTicket.createdByUserId.trim().length > 0 &&
    preparedRestoreTicket.createdByUserId !== input.actorId
  ) {
    return false;
  }

  await clearPreparedRestoreTicket();
  return true;
};

export const startRestoreJob = (input: {
  ticketId: string;
  passphrase: string;
  actorId?: string;
}): { started: boolean; reason?: string; status: RestoreStatus } => {
  if (backupPromise) {
    return {
      started: false,
      reason: "Ein Backup läuft bereits.",
      status: getRestoreStatus()
    };
  }

  if (restorePromise) {
    return {
      started: false,
      reason: "Eine Wiederherstellung läuft bereits.",
      status: getRestoreStatus()
    };
  }

  if (!preparedRestoreTicket) {
    return {
      started: false,
      reason: "Kein vorbereitetes Backup gefunden.",
      status: getRestoreStatus()
    };
  }

  if (Date.parse(preparedRestoreTicket.expiresAt) <= Date.now()) {
    const expiredTicketPath = preparedRestoreTicket.stagedFilePath;
    preparedRestoreTicket = null;
    void removeFile(expiredTicketPath);
    return {
      started: false,
      reason: "Die Restore-Vorbereitung ist abgelaufen. Bitte Backup erneut prüfen.",
      status: getRestoreStatus()
    };
  }

  if (String(input.ticketId ?? "").trim() !== preparedRestoreTicket.id) {
    return {
      started: false,
      reason: "Restore-Ticket ungültig.",
      status: getRestoreStatus()
    };
  }

  if (
    input.actorId &&
    preparedRestoreTicket.createdByUserId &&
    preparedRestoreTicket.createdByUserId.trim().length > 0 &&
    preparedRestoreTicket.createdByUserId !== input.actorId
  ) {
    return {
      started: false,
      reason: "Restore-Ticket gehört zu einem anderen Benutzer.",
      status: getRestoreStatus()
    };
  }

  const passphrase = String(input.passphrase ?? "").trim();
  if (!passphrase) {
    return {
      started: false,
      reason: "Backup-Passphrase fehlt.",
      status: getRestoreStatus()
    };
  }

  const ticket = preparedRestoreTicket;
  preparedRestoreTicket = null;

  restoreStatus = {
    ...defaultRestoreStatus(),
    running: true,
    phase: "decrypting",
    message: "Wiederherstellung wird gestartet...",
    startedAt: new Date().toISOString(),
    percent: 3,
    sourceFileName: ticket.uploadedFileName,
    processedEntries: 0,
    totalEntries: Math.max(ticket.archiveEntries, 1)
  };

  restorePromise = runRestore(ticket, passphrase)
    .catch((error) => {
      updateRestoreStatus({
        running: false,
        phase: "error",
        message: "Wiederherstellung fehlgeschlagen.",
        finishedAt: new Date().toISOString(),
        percent: 100,
        error: error instanceof Error ? error.message : "Unbekannter Fehler"
      });
    })
    .finally(() => {
      restorePromise = null;
    });

  return {
    started: true,
    status: getRestoreStatus()
  };
};

export const startBackupJob = (): { started: boolean; reason?: string; status: BackupStatus } => {
  if (restorePromise) {
    return {
      started: false,
      reason: "Eine Wiederherstellung läuft bereits.",
      status: getBackupStatus()
    };
  }

  if (backupPromise) {
    return {
      started: false,
      reason: "Ein Backup läuft bereits.",
      status: getBackupStatus()
    };
  }

  if (!(process.env.BACKUP_ENCRYPTION_KEY ?? "").trim()) {
    return {
      started: false,
      reason: "BACKUP_ENCRYPTION_KEY ist nicht gesetzt.",
      status: getBackupStatus()
    };
  }

  backupStatus = {
    ...defaultStatus(),
    running: true,
    phase: "preparing",
    message: "Backup wird gestartet...",
    startedAt: new Date().toISOString(),
    percent: 3
  };

  backupPromise = runBackup()
    .catch((error) => {
      updateStatus({
        running: false,
        phase: "error",
        message: "Backup fehlgeschlagen.",
        finishedAt: new Date().toISOString(),
        percent: 100,
        error: error instanceof Error ? error.message : "Unbekannter Fehler"
      });
    })
    .finally(() => {
      backupPromise = null;
    });

  return {
    started: true,
    status: getBackupStatus()
  };
};

export const listBackupFiles = async (): Promise<BackupFileInfo[]> => {
  await ensureDir(config.backupDir);

  let entries: string[];
  try {
    entries = await fs.readdir(config.backupDir, { encoding: "utf8" });
  } catch {
    return [];
  }

  const files = entries.filter((name) => SAFE_BACKUP_FILE_PATTERN.test(name));
  const items = await Promise.all(
    files.map(async (fileName) => {
      const fullPath = path.join(config.backupDir, fileName);
      try {
        const stats = await fs.stat(fullPath);
        if (!stats.isFile()) return null;

        const checksumPath = `${fullPath}.sha256`;
        let hasChecksum = false;
        try {
          const checksumStats = await fs.stat(checksumPath);
          hasChecksum = checksumStats.isFile();
        } catch {
          hasChecksum = false;
        }

        return {
          fileName,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          hasChecksum
        } satisfies BackupFileInfo;
      } catch {
        return null;
      }
    })
  );

  return items
    .filter((entry): entry is BackupFileInfo => entry !== null)
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
};

export const resolveBackupFilePath = async (fileNameInput: string): Promise<string | null> => {
  const fileName = path.basename(String(fileNameInput ?? "").trim());
  if (!SAFE_BACKUP_FILE_PATTERN.test(fileName)) return null;

  const fullPath = path.join(config.backupDir, fileName);
  try {
    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) return null;
    return fullPath;
  } catch {
    return null;
  }
};

export const deleteBackupFile = async (fileNameInput: string): Promise<boolean> => {
  const fullPath = await resolveBackupFilePath(fileNameInput);
  if (!fullPath) return false;

  await removeFile(fullPath);
  await removeFile(`${fullPath}.sha256`);
  return true;
};
