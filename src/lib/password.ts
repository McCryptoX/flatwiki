import { randomBytes, scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 64 * 1024 * 1024;

const toBase64 = (buffer: Buffer): string => buffer.toString("base64");
const fromBase64 = (value: string): Buffer => Buffer.from(value, "base64");
const passwordPepper = (): string => process.env.PASSWORD_PEPPER ?? "";

const deriveKey = async (
  input: BinaryLike,
  salt: BinaryLike,
  keyLength: number,
  options: ScryptOptions
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(input, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(derivedKey));
    });
  });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const derivedKey = await deriveKey(`${password}${passwordPepper()}`, salt, KEY_LENGTH, {
    cost: SCRYPT_N,
    blockSize: SCRYPT_R,
    parallelization: SCRYPT_P,
    maxmem: MAX_MEM
  });

  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    toBase64(salt),
    toBase64(derivedKey)
  ].join("$");
};

export const verifyPassword = async (password: string, encodedHash: string): Promise<boolean> => {
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = encodedHash.split("$");
  if (!algorithm || !nRaw || !rRaw || !pRaw || !saltRaw || !hashRaw) return false;
  if (algorithm !== "scrypt") return false;

  const n = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);

  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = fromBase64(saltRaw);
  const expectedHash = fromBase64(hashRaw);
  const actualHash = await deriveKey(`${password}${passwordPepper()}`, salt, expectedHash.length, {
    cost: n,
    blockSize: r,
    parallelization: p,
    maxmem: MAX_MEM
  });

  if (actualHash.length !== expectedHash.length) return false;

  return timingSafeEqual(actualHash, expectedHash);
};

export const needsRehash = (encodedHash: string): boolean => {
  const [algorithm, nRaw, rRaw, pRaw] = encodedHash.split("$");
  if (algorithm !== "scrypt") return true;

  const n = Number.parseInt(nRaw ?? "", 10);
  const r = Number.parseInt(rRaw ?? "", 10);
  const p = Number.parseInt(pRaw ?? "", 10);

  return n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P;
};

export const validatePasswordStrength = (password: string): string | null => {
  if (password.length < 12) {
    return "Passwort muss mindestens 12 Zeichen lang sein.";
  }
  if (!/[A-Z]/.test(password)) {
    return "Passwort muss mindestens einen Großbuchstaben enthalten.";
  }
  if (!/[a-z]/.test(password)) {
    return "Passwort muss mindestens einen Kleinbuchstaben enthalten.";
  }
  if (!/[0-9]/.test(password)) {
    return "Passwort muss mindestens eine Zahl enthalten.";
  }
  return null;
};
