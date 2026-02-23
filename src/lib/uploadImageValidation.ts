import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { safeResolve } from "./fileStore.js";

export type AllowedUploadImageType = "png" | "jpg" | "webp" | "gif" | "avif";

const MIME_TO_IMAGE_TYPE: Record<string, AllowedUploadImageType> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif"
};

const EXTENSION_TO_IMAGE_TYPE: Record<string, AllowedUploadImageType> = {
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  webp: "webp",
  gif: "gif",
  avif: "avif"
};

const AVIF_BRANDS = new Set(["avif", "avis"]);

const normalizeExtension = (fileName: string | undefined): string =>
  path.extname(fileName ?? "").replace(/^\./, "").trim().toLowerCase();

export const detectImageTypeFromMagic = (magic: Buffer): AllowedUploadImageType | null => {
  if (magic.length >= 8 && magic.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }

  if (magic.length >= 3 && magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff) {
    return "jpg";
  }

  if (magic.length >= 6) {
    const sig6 = magic.subarray(0, 6).toString("ascii");
    if (sig6 === "GIF87a" || sig6 === "GIF89a") {
      return "gif";
    }
  }

  if (magic.length >= 12) {
    const riff = magic.subarray(0, 4).toString("ascii");
    const webp = magic.subarray(8, 12).toString("ascii");
    if (riff === "RIFF" && webp === "WEBP") {
      return "webp";
    }
  }

  if (magic.length >= 12 && magic.subarray(4, 8).toString("ascii") === "ftyp") {
    const majorBrand = magic.subarray(8, 12).toString("ascii");
    if (AVIF_BRANDS.has(majorBrand)) {
      return "avif";
    }
  }

  return null;
};

const readMagicBytes = async (filePath: string, bytes = 64): Promise<Buffer> => {
  const handle = await fs.open(filePath, "r");
  try {
    const chunk = Buffer.alloc(bytes);
    const read = await handle.read(chunk, 0, chunk.length, 0);
    return chunk.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
  }
};

export const detectImageTypeFromFile = async (filePath: string): Promise<AllowedUploadImageType | null> => {
  const magic = await readMagicBytes(filePath, 64);
  return detectImageTypeFromMagic(magic);
};

export const resolveDeclaredImageType = (
  fileName: string | undefined,
  mimeTypeInput: string
): { ok: true; type: AllowedUploadImageType } | { ok: false; error: string } => {
  const mimeType = String(mimeTypeInput ?? "").trim().toLowerCase();
  const mimeTypeResolved = MIME_TO_IMAGE_TYPE[mimeType];
  const extensionResolved = EXTENSION_TO_IMAGE_TYPE[normalizeExtension(fileName)];

  if (!mimeTypeResolved && !extensionResolved) {
    return { ok: false, error: "Nicht unterstütztes Bildformat." };
  }

  if (mimeTypeResolved && extensionResolved && mimeTypeResolved !== extensionResolved) {
    return { ok: false, error: "Dateiendung und MIME-Typ passen nicht zusammen." };
  }

  const type = mimeTypeResolved ?? extensionResolved;
  if (!type) {
    return { ok: false, error: "Nicht unterstütztes Bildformat." };
  }

  return { ok: true, type };
};

export const validateImageFileMagic = async (
  filePath: string,
  declaredType: AllowedUploadImageType
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const magic = await readMagicBytes(filePath, 64);
  const detectedType = detectImageTypeFromMagic(magic);
  if (!detectedType) {
    return { ok: false, error: "Datei enthält keine gültige Bildsignatur." };
  }

  if (detectedType !== declaredType) {
    return { ok: false, error: "Dateisignatur passt nicht zum angegebenen Bildformat." };
  }

  return { ok: true };
};

export const persistValidatedImageUpload = async (input: {
  stream: NodeJS.ReadableStream;
  uploadTargetDir: string;
  storedName: string;
  fileName: string | undefined;
  mimeType: string;
}): Promise<{ ok: true; filePath: string; type: AllowedUploadImageType } | { ok: false; error: string }> => {
  const declared = resolveDeclaredImageType(input.fileName, input.mimeType);
  if (!declared.ok) {
    return { ok: false, error: declared.error };
  }

  const cleanupPath = async (filePath: string): Promise<void> => {
    await fs.unlink(filePath).catch(() => {});
  };

  let finalPath = "";
  let tempPath = "";

  try {
    finalPath = safeResolve(input.uploadTargetDir, input.storedName);
    tempPath = safeResolve(input.uploadTargetDir, `${input.storedName}.${randomUUID()}.tmp`);
    await pipeline(input.stream, createWriteStream(tempPath, { flags: "wx" }));
    const magicCheck = await validateImageFileMagic(tempPath, declared.type);
    if (!magicCheck.ok) {
      await cleanupPath(tempPath);
      return { ok: false, error: magicCheck.error };
    }

    await fs.rename(tempPath, finalPath);
    return { ok: true, filePath: finalPath, type: declared.type };
  } catch {
    if (tempPath) {
      await cleanupPath(tempPath);
    }
    if (finalPath) {
      await cleanupPath(finalPath);
    }
    return { ok: false, error: "Upload fehlgeschlagen. Bitte Dateigröße/Format prüfen." };
  }
};
