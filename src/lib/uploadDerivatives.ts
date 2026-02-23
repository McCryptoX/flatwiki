import fs from "node:fs/promises";
import path from "node:path";

export interface UploadDerivativePaths {
  originalPath: string;
  basePath: string;
  extension: string;
  avifPath: string;
  webpPath: string;
}

const DERIVATIVE_EXTENSIONS = new Set(["avif", "webp"]);

const splitAcceptHeader = (acceptHeader: string | undefined): string[] =>
  String(acceptHeader ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

const acceptsType = (acceptHeader: string | undefined, mime: string): boolean => {
  const parts = splitAcceptHeader(acceptHeader);
  if (parts.length < 1) return false;

  for (const part of parts) {
    const [type, ...params] = part.split(";").map((segment) => segment.trim());
    if (!type || type !== mime) continue;

    const quality = params.find((param) => param.startsWith("q="));
    if (!quality) return true;
    const qValue = Number.parseFloat(quality.slice(2));
    if (Number.isFinite(qValue) && qValue > 0) {
      return true;
    }
  }

  return false;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const deriveUploadPaths = (relativeUploadPath: string): UploadDerivativePaths => {
  const normalized = relativeUploadPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parsed = path.posix.parse(normalized);
  const extension = parsed.ext.replace(/^\./, "").toLowerCase();
  const basePath = parsed.dir ? `${parsed.dir}/${parsed.name}` : parsed.name;

  return {
    originalPath: normalized,
    basePath,
    extension,
    avifPath: `${basePath}.avif`,
    webpPath: `${basePath}.webp`
  };
};

export const isLikelyGeneratedDerivative = (relativeUploadPath: string): boolean => {
  const ext = path.posix.extname(relativeUploadPath.replace(/\\/g, "/")).replace(/^\./, "").toLowerCase();
  return DERIVATIVE_EXTENSIONS.has(ext);
};

export const resolveNegotiatedUploadPath = async (input: {
  originalRelativePath: string;
  uploadRootDir: string;
  acceptHeader: string | undefined;
  enabled: boolean;
  requestedFormat?: "auto" | "avif" | "webp" | "original";
}): Promise<string> => {
  if (!input.enabled) {
    return input.originalRelativePath;
  }

  const derived = deriveUploadPaths(input.originalRelativePath);
  if (DERIVATIVE_EXTENSIONS.has(derived.extension)) {
    return input.originalRelativePath;
  }

  const requestedFormat = input.requestedFormat ?? "auto";
  if (requestedFormat === "original") {
    return input.originalRelativePath;
  }

  const wantsAvif = requestedFormat === "auto" ? acceptsType(input.acceptHeader, "image/avif") : requestedFormat === "avif";
  const wantsWebp = requestedFormat === "auto" ? acceptsType(input.acceptHeader, "image/webp") : requestedFormat === "webp";

  if (wantsAvif) {
    const avifAbsolute = path.join(input.uploadRootDir, derived.avifPath);
    if (await fileExists(avifAbsolute)) {
      return derived.avifPath;
    }
  }

  if (wantsWebp) {
    const webpAbsolute = path.join(input.uploadRootDir, derived.webpPath);
    if (await fileExists(webpAbsolute)) {
      return derived.webpPath;
    }
  }

  return input.originalRelativePath;
};
