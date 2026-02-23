import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { detectImageTypeFromFile, type AllowedUploadImageType } from "./uploadImageValidation.js";
import { deriveUploadPaths, isLikelyGeneratedDerivative } from "./uploadDerivatives.js";

type DerivativeFormat = "avif" | "webp";
type SourceImageType = Exclude<AllowedUploadImageType, "avif" | "webp">;

interface BackfillCandidate {
  relativePath: string;
  absolutePath: string;
  basePath: string;
  sourceType: SourceImageType;
  sizeBytes: number;
  mtimeMs: number;
}

export interface UploadDerivativeToolingStatus {
  avifenc: { available: boolean; command: string };
  cwebp: { available: boolean; command: string };
}

export interface BackfillUploadDerivativesOptions {
  uploadRootDir: string;
  dryRun: boolean;
  limit: number;
  concurrency: number;
  since?: Date;
  maxSizeBytes: number;
  maxPixels: number;
  timeoutMsPerFile: number;
  log?: (message: string) => void;
  converter?: DerivativeConverter;
}

export interface BackfillUploadDerivativesSummary {
  scanned: number;
  eligible: number;
  converted: number;
  skipped: number;
  errors: number;
}

export interface DerivativeConverterInput {
  sourcePath: string;
  sourceType: AllowedUploadImageType;
  targetPath: string;
  format: DerivativeFormat;
  timeoutMs: number;
}

export type DerivativeConverter = (input: DerivativeConverterInput) => Promise<void>;

const DEFAULT_MAX_SIZE_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 40_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

const commandExists = async (commandName: string): Promise<boolean> => {
  const normalized = commandName.trim();
  if (!normalized) return false;
  if (/[\r\n\t]/.test(normalized)) return false;

  const isPath = normalized.includes("/") || normalized.startsWith(".");
  const candidates = isPath
    ? [path.resolve(normalized)]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((segment) => path.join(segment, normalized));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // continue
    }
  }

  return false;
};

const withTimeout = async <T>(promiseFactory: () => Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timeout nach ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promiseFactory(), timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const runCommand = async (command: string, args: string[], timeoutMs: number): Promise<void> =>
  withTimeout(
    () =>
      new Promise<void>((resolve, reject) => {
        const proc = spawn(command, args, {
          stdio: ["ignore", "ignore", "pipe"]
        });

        let stderr = "";
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });

        proc.on("error", reject);
        proc.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(new Error(stderr.trim() || `${command} failed with exit code ${code ?? "?"}`));
        });
      }),
    timeoutMs
  );

const parseJpegDimensions = (buffer: Buffer): { width: number; height: number } | null => {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;

  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === undefined) break;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) break;
    const isSof =
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf;

    if (isSof && segmentLength >= 7) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) {
        return { width, height };
      }
      return null;
    }

    offset += 2 + segmentLength;
  }

  return null;
};

const parsePngDimensions = (buffer: Buffer): { width: number; height: number } | null => {
  if (buffer.length < 24) return null;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) return null;
  return { width, height };
};

const parseGifDimensions = (buffer: Buffer): { width: number; height: number } | null => {
  if (buffer.length < 10) return null;
  const header = buffer.subarray(0, 6).toString("ascii");
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (width < 1 || height < 1) return null;
  return { width, height };
};

const ensureImageWithinPixelLimit = async (sourcePath: string, maxPixels: number): Promise<void> => {
  const header = await fs.readFile(sourcePath);
  const dimensions = parsePngDimensions(header) ?? parseGifDimensions(header) ?? parseJpegDimensions(header);
  if (!dimensions) {
    throw new Error("Bilddimensionen konnten nicht verifiziert werden.");
  }

  const pixels = dimensions.width * dimensions.height;
  if (pixels > maxPixels) {
    throw new Error(`Bild überschreitet Max-Pixel-Limit (${pixels} > ${maxPixels}).`);
  }
};

export const createCliDerivativeConverter = async (): Promise<DerivativeConverter> => {
  const avifenc = process.env.UPLOAD_DERIVATIVE_AVIFENC_CMD?.trim() || "avifenc";
  const cwebp = process.env.UPLOAD_DERIVATIVE_CWEBP_CMD?.trim() || "cwebp";
  const hasAvifenc = await commandExists(avifenc);
  const hasCwebp = await commandExists(cwebp);

  return async (input) => {
    if (input.format === "avif") {
      if (!hasAvifenc) {
        throw new Error(`AVIF-Konverter nicht gefunden (${avifenc}).`);
      }
      await runCommand(avifenc, ["--min", "28", "--max", "32", "--speed", "6", input.sourcePath, input.targetPath], input.timeoutMs);
      return;
    }

    if (!hasCwebp) {
      throw new Error(`WEBP-Konverter nicht gefunden (${cwebp}).`);
    }
    await runCommand(cwebp, ["-quiet", "-q", "85", input.sourcePath, "-o", input.targetPath], input.timeoutMs);
  };
};

export const getUploadDerivativeToolingStatus = async (): Promise<UploadDerivativeToolingStatus> => {
  const avifenc = process.env.UPLOAD_DERIVATIVE_AVIFENC_CMD?.trim() || "avifenc";
  const cwebp = process.env.UPLOAD_DERIVATIVE_CWEBP_CMD?.trim() || "cwebp";
  const [avifencAvailable, cwebpAvailable] = await Promise.all([commandExists(avifenc), commandExists(cwebp)]);
  return {
    avifenc: { available: avifencAvailable, command: avifenc },
    cwebp: { available: cwebpAvailable, command: cwebp }
  };
};

const listFilesRecursive = async (rootDir: string, currentDir = rootDir): Promise<Array<{ absolutePath: string; relativePath: string }>> => {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" })) as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
  } catch {
    return [];
  }
  const out: Array<{ absolutePath: string; relativePath: string }> = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(rootDir, absolutePath)));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push({
      absolutePath,
      relativePath: path.relative(rootDir, absolutePath).replace(/\\/g, "/")
    });
  }

  return out;
};

const sortCandidates = (items: BackfillCandidate[]): BackfillCandidate[] =>
  [...items].sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath));

const createDerivativeFromSource = async (input: {
  sourcePath: string;
  sourceType: AllowedUploadImageType;
  targetPath: string;
  format: DerivativeFormat;
  converter: DerivativeConverter;
  dryRun: boolean;
  timeoutMsPerFile: number;
}): Promise<"converted" | "skipped"> => {
  try {
    await fs.access(input.targetPath);
    return "skipped";
  } catch {
    // create below
  }

  if (input.dryRun) {
    return "converted";
  }

  await fs.mkdir(path.dirname(input.targetPath), { recursive: true });
  const tmpPath = `${input.targetPath}.${Date.now()}.tmp`;
  try {
    await input.converter({
      sourcePath: input.sourcePath,
      sourceType: input.sourceType,
      targetPath: tmpPath,
      format: input.format,
      timeoutMs: input.timeoutMsPerFile
    });

    try {
      await fs.access(input.targetPath);
      await fs.unlink(tmpPath).catch(() => {});
      return "skipped";
    } catch {
      await fs.rename(tmpPath, input.targetPath);
      return "converted";
    }
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
};

const isSourceTypeForBackfill = (type: AllowedUploadImageType | null): type is SourceImageType =>
  type === "png" || type === "jpg" || type === "gif";

export const backfillUploadDerivatives = async (optionsInput: Partial<BackfillUploadDerivativesOptions> & { uploadRootDir: string }): Promise<BackfillUploadDerivativesSummary> => {
  const optionsBase = {
    uploadRootDir: optionsInput.uploadRootDir,
    dryRun: optionsInput.dryRun ?? false,
    limit: Math.max(1, optionsInput.limit ?? 500),
    concurrency: Math.max(1, optionsInput.concurrency ?? 2),
    maxSizeBytes: Math.max(1, optionsInput.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES),
    maxPixels: Math.max(1, optionsInput.maxPixels ?? DEFAULT_MAX_PIXELS),
    timeoutMsPerFile: Math.max(1, optionsInput.timeoutMsPerFile ?? DEFAULT_TIMEOUT_MS)
  };
  const options: BackfillUploadDerivativesOptions = {
    ...optionsBase,
    ...(optionsInput.since ? { since: optionsInput.since } : {}),
    ...(optionsInput.log ? { log: optionsInput.log } : {}),
    ...(optionsInput.converter ? { converter: optionsInput.converter } : {})
  };

  const log = (line: string): void => {
    options.log?.(line);
  };

  const converter = options.converter ?? (await createCliDerivativeConverter());
  const entries = await listFilesRecursive(options.uploadRootDir);
  const byBase = new Map<string, BackfillCandidate>();
  let scanned = 0;

  for (const entry of entries) {
    scanned += 1;
    if (isLikelyGeneratedDerivative(entry.relativePath)) {
      continue;
    }

    const derived = deriveUploadPaths(entry.relativePath);
    const stats = await fs.stat(entry.absolutePath).catch(() => null);
    if (!stats || !stats.isFile()) continue;
    if (options.since && stats.mtime < options.since) continue;
    if (stats.size < 1 || stats.size > options.maxSizeBytes) continue;

    const type = await detectImageTypeFromFile(entry.absolutePath).catch(() => null);
    if (!isSourceTypeForBackfill(type)) continue;

    try {
      await ensureImageWithinPixelLimit(entry.absolutePath, options.maxPixels);
    } catch {
      continue;
    }

    const existing = byBase.get(derived.basePath);
    if (!existing || stats.mtimeMs > existing.mtimeMs) {
      byBase.set(derived.basePath, {
        relativePath: entry.relativePath,
        absolutePath: entry.absolutePath,
        basePath: derived.basePath,
        sourceType: type,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs
      });
    }
  }

  const candidates = sortCandidates([...byBase.values()]).slice(0, options.limit);
  const summary: BackfillUploadDerivativesSummary = {
    scanned,
    eligible: candidates.length,
    converted: 0,
    skipped: 0,
    errors: 0
  };

  let cursor = 0;
  const workers = Array.from({ length: options.concurrency }, async () => {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const candidate = candidates[index];
      if (!candidate) continue;

      const derived = deriveUploadPaths(candidate.relativePath);
      const targets: Array<{ path: string; format: DerivativeFormat }> = [
        { path: path.join(options.uploadRootDir, derived.avifPath), format: "avif" },
        { path: path.join(options.uploadRootDir, derived.webpPath), format: "webp" }
      ];

      for (const target of targets) {
        try {
          const state = await createDerivativeFromSource({
            sourcePath: candidate.absolutePath,
            sourceType: candidate.sourceType,
            targetPath: target.path,
            format: target.format,
            converter,
            dryRun: options.dryRun,
            timeoutMsPerFile: options.timeoutMsPerFile
          });
          if (state === "converted") {
            summary.converted += 1;
            log(`converted ${target.format}: ${candidate.relativePath}`);
          } else {
            summary.skipped += 1;
          }
        } catch (error) {
          summary.errors += 1;
          log(`error ${target.format}: ${candidate.relativePath} (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
  });

  await Promise.all(workers);
  return summary;
};

export const generateMissingDerivativesForSource = async (input: {
  uploadRootDir: string;
  relativePath: string;
  sourceType: AllowedUploadImageType;
  timeoutMsPerFile?: number;
  converter?: DerivativeConverter;
}): Promise<{ converted: number; skipped: number; errors: number }> => {
  if (!["png", "jpg", "gif"].includes(input.sourceType)) {
    return { converted: 0, skipped: 0, errors: 0 };
  }

  const timeoutMsPerFile = Math.max(1, input.timeoutMsPerFile ?? DEFAULT_TIMEOUT_MS);
  const converter = input.converter ?? (await createCliDerivativeConverter());
  const derived = deriveUploadPaths(input.relativePath);
  const sourcePath = path.join(input.uploadRootDir, input.relativePath);
  const targets: Array<{ path: string; format: DerivativeFormat }> = [
    { path: path.join(input.uploadRootDir, derived.avifPath), format: "avif" },
    { path: path.join(input.uploadRootDir, derived.webpPath), format: "webp" }
  ];

  let converted = 0;
  let skipped = 0;
  let errors = 0;

  for (const target of targets) {
    if (path.normalize(target.path) === path.normalize(sourcePath)) {
      skipped += 1;
      continue;
    }

    try {
      const state = await createDerivativeFromSource({
        sourcePath,
        sourceType: input.sourceType,
        targetPath: target.path,
        format: target.format,
        converter,
        dryRun: false,
        timeoutMsPerFile
      });
      if (state === "converted") {
        converted += 1;
      } else {
        skipped += 1;
      }
    } catch {
      errors += 1;
    }
  }

  return { converted, skipped, errors };
};
