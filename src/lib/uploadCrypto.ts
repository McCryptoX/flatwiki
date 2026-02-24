import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs/promises";

import { config } from "../config.js";

const MAGIC = Buffer.from("FWUP1", "ascii");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MAX_MIME_LENGTH = 255;

const buildEnvelope = (input: { plaintext: Buffer; mimeType: string }): Buffer | null => {
  const key = config.contentEncryptionKey;
  if (!key) return null;

  const normalizedMime = String(input.mimeType ?? "application/octet-stream").trim().toLowerCase() || "application/octet-stream";
  const mimeBytes = Buffer.from(normalizedMime, "utf8");
  if (mimeBytes.length > MAX_MIME_LENGTH) return null;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = Buffer.allocUnsafe(MAGIC.length + IV_LENGTH + TAG_LENGTH + 2 + mimeBytes.length + ciphertext.length);
  let offset = 0;
  MAGIC.copy(envelope, offset);
  offset += MAGIC.length;
  iv.copy(envelope, offset);
  offset += IV_LENGTH;
  tag.copy(envelope, offset);
  offset += TAG_LENGTH;
  envelope.writeUInt16BE(mimeBytes.length, offset);
  offset += 2;
  mimeBytes.copy(envelope, offset);
  offset += mimeBytes.length;
  ciphertext.copy(envelope, offset);
  return envelope;
};

const parseEnvelope = (raw: Buffer): { encrypted: false } | { encrypted: true; mimeType: string; plaintext: Buffer } | { encrypted: true; error: string } => {
  if (raw.length < MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    return { encrypted: false };
  }

  const key = config.contentEncryptionKey;
  if (!key) {
    return { encrypted: true, error: "CONTENT_ENCRYPTION_KEY fehlt." };
  }

  const headerMin = MAGIC.length + IV_LENGTH + TAG_LENGTH + 2;
  if (raw.length < headerMin) {
    return { encrypted: true, error: "Upload-Header ist beschädigt." };
  }

  let offset = MAGIC.length;
  const iv = raw.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const tag = raw.subarray(offset, offset + TAG_LENGTH);
  offset += TAG_LENGTH;
  const mimeLength = raw.readUInt16BE(offset);
  offset += 2;

  if (mimeLength < 1 || mimeLength > MAX_MIME_LENGTH) {
    return { encrypted: true, error: "Upload-Header enthält ungültigen MIME-Typ." };
  }

  if (raw.length < offset + mimeLength) {
    return { encrypted: true, error: "Upload-Header ist unvollständig." };
  }

  const mimeType = raw.subarray(offset, offset + mimeLength).toString("utf8").trim().toLowerCase();
  offset += mimeLength;
  const ciphertext = raw.subarray(offset);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return {
      encrypted: true,
      mimeType: mimeType || "application/octet-stream",
      plaintext
    };
  } catch {
    return { encrypted: true, error: "Upload-Datei konnte nicht entschlüsselt werden." };
  }
};

export const isEncryptedUploadPayload = (raw: Buffer): boolean => raw.length >= MAGIC.length && raw.subarray(0, MAGIC.length).equals(MAGIC);

export const encryptUploadFileInPlace = async (filePath: string, mimeType: string): Promise<{ ok: true; alreadyEncrypted: boolean } | { ok: false; error: string }> => {
  const source = await fs.readFile(filePath).catch(() => null);
  if (!source) return { ok: false, error: "Upload-Datei nicht gefunden." };
  if (isEncryptedUploadPayload(source)) return { ok: true, alreadyEncrypted: true };

  const envelope = buildEnvelope({ plaintext: source, mimeType });
  if (!envelope) {
    return { ok: false, error: "Upload-Verschlüsselung ist nicht verfügbar." };
  }

  const tmpPath = `${filePath}.enc.tmp`;
  try {
    await fs.writeFile(tmpPath, envelope, { flag: "wx" });
    await fs.rename(tmpPath, filePath);
    return { ok: true, alreadyEncrypted: false };
  } catch {
    await fs.unlink(tmpPath).catch(() => {});
    return { ok: false, error: "Upload konnte nicht verschlüsselt gespeichert werden." };
  }
};

export const decryptUploadFileInPlace = async (filePath: string): Promise<{ ok: true; wasEncrypted: boolean; mimeType: string | null } | { ok: false; error: string }> => {
  const source = await fs.readFile(filePath).catch(() => null);
  if (!source) return { ok: false, error: "Upload-Datei nicht gefunden." };

  const parsed = parseEnvelope(source);
  if (!parsed.encrypted) {
    return { ok: true, wasEncrypted: false, mimeType: null };
  }

  if ("error" in parsed) {
    return { ok: false, error: parsed.error };
  }

  const tmpPath = `${filePath}.dec.tmp`;
  try {
    await fs.writeFile(tmpPath, parsed.plaintext, { flag: "wx" });
    await fs.rename(tmpPath, filePath);
    return { ok: true, wasEncrypted: true, mimeType: parsed.mimeType };
  } catch {
    await fs.unlink(tmpPath).catch(() => {});
    return { ok: false, error: "Upload konnte nicht entschlüsselt gespeichert werden." };
  }
};

export const decryptUploadFileToBuffer = async (
  filePath: string
): Promise<{ ok: true; encrypted: boolean; mimeType: string | null; data: Buffer } | { ok: false; error: string }> => {
  const source = await fs.readFile(filePath).catch(() => null);
  if (!source) return { ok: false, error: "Upload-Datei nicht gefunden." };

  const parsed = parseEnvelope(source);
  if (!parsed.encrypted) {
    return { ok: true, encrypted: false, mimeType: null, data: source };
  }

  if ("error" in parsed) {
    return { ok: false, error: parsed.error };
  }

  return { ok: true, encrypted: true, mimeType: parsed.mimeType, data: parsed.plaintext };
};
