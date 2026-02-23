import { config, type IndexBackend } from "../config.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";
import { canEncryptSecrets, decryptSecret, encryptSecret } from "./secretCrypto.js";

export type UiMode = "simple" | "advanced";
export type CommentModerationMode = "moderated" | "all_auto" | "trusted_auto";

interface RuntimeSettingsFile {
  indexBackend?: string;
  uiMode?: string;
  publicRead?: boolean;
  uploadDerivativesEnabled?: boolean;
  smtp?: {
    host?: string;
    port?: number | string;
    secure?: boolean | string;
    user?: string;
    pass?: string;
    passEnc?: string;
    from?: string;
  };
  comments?: {
    moderationMode?: string;
    trustedAutoApproveUsernames?: string[];
  };
  updatedAt?: string;
  updatedBy?: string;
}

export interface RuntimeSmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

interface RuntimeSettings {
  indexBackend: IndexBackend;
  uiMode: UiMode;
  publicRead: boolean;
  uploadDerivativesEnabled: boolean;
  smtp: RuntimeSmtpSettings;
  comments: RuntimeCommentModerationSettings;
  updatedAt?: string;
  updatedBy?: string;
}

export interface RuntimeCommentModerationSettings {
  moderationMode: CommentModerationMode;
  trustedAutoApproveUsernames: string[];
}

let initialized = false;
let currentIndexBackend: IndexBackend = config.indexBackend;
let currentUiMode: UiMode = "simple";
let currentPublicRead = false;
let currentUploadDerivativesEnabled = config.uploadDerivativesEnabled;
let mutationQueue: Promise<void> = Promise.resolve();
let currentSmtp: RuntimeSmtpSettings = {
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.smtpSecure,
  user: config.smtpUser,
  pass: config.smtpPass,
  from: config.smtpFrom
};
let currentCommentModeration: RuntimeCommentModerationSettings = {
  moderationMode: "moderated",
  trustedAutoApproveUsernames: []
};

const withMutationLock = async <T>(task: () => Promise<T>): Promise<T> => {
  const waitFor = mutationQueue;
  let release!: () => void;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await waitFor;
  try {
    return await task();
  } finally {
    release();
  }
};

const normalizeIndexBackend = (value: string | undefined): IndexBackend => (value?.trim().toLowerCase() === "sqlite" ? "sqlite" : "flat");
const normalizeUiMode = (value: string | undefined): UiMode => (value?.trim().toLowerCase() === "advanced" ? "advanced" : "simple");
const normalizeText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const normalizePositiveInt = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
};
const normalizePublicRead = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  }
  return false;
};
const normalizeCommentModerationMode = (value: unknown): CommentModerationMode => {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "all_auto") return "all_auto";
  if (normalized === "trusted_auto") return "trusted_auto";
  return "moderated";
};
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const normalizeTrustedUsernames = (value: unknown, fallback: string[] = []): string[] => {
  const source = Array.isArray(value) ? value : fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of source) {
    const username = normalizeText(entry).toLowerCase();
    if (!username || seen.has(username)) continue;
    if (!USERNAME_PATTERN.test(username)) continue;
    seen.add(username);
    out.push(username);
  }
  return out;
};
const normalizeCommentModerationSettings = (
  value: RuntimeSettingsFile["comments"] | undefined,
  fallback: RuntimeCommentModerationSettings
): RuntimeCommentModerationSettings => ({
  moderationMode: normalizeCommentModerationMode(value?.moderationMode ?? fallback.moderationMode),
  trustedAutoApproveUsernames: normalizeTrustedUsernames(
    value?.trustedAutoApproveUsernames,
    fallback.trustedAutoApproveUsernames
  )
});
const normalizeSmtpSettings = (value: RuntimeSettingsFile["smtp"] | undefined, fallback: RuntimeSmtpSettings): RuntimeSmtpSettings => {
  const decryptedPass = typeof value?.passEnc === "string" ? decryptSecret(value.passEnc) : null;
  const pass =
    typeof decryptedPass === "string"
      ? decryptedPass
      : typeof value?.pass === "string"
        ? value.pass
        : fallback.pass;
  return {
    host: normalizeText(value?.host ?? fallback.host),
    port: normalizePositiveInt(value?.port, fallback.port),
    secure: normalizePublicRead(value?.secure ?? fallback.secure),
    user: normalizeText(value?.user ?? fallback.user),
    pass,
    from: normalizeText(value?.from ?? fallback.from)
  };
};

const loadRuntimeSettingsFile = async (): Promise<RuntimeSettingsFile> => {
  await ensureFile(config.runtimeSettingsFile, "{}\n");
  return readJsonFile<RuntimeSettingsFile>(config.runtimeSettingsFile, {});
};

export const initRuntimeSettings = async (): Promise<void> => {
  const file = await loadRuntimeSettingsFile();
  currentIndexBackend = normalizeIndexBackend(file.indexBackend ?? config.indexBackend);
  currentUiMode = normalizeUiMode(file.uiMode);
  currentPublicRead = normalizePublicRead(file.publicRead);
  currentUploadDerivativesEnabled = normalizePublicRead(file.uploadDerivativesEnabled ?? config.uploadDerivativesEnabled);
  currentSmtp = normalizeSmtpSettings(file.smtp, currentSmtp);
  currentCommentModeration = normalizeCommentModerationSettings(file.comments, currentCommentModeration);

  const legacyPass = typeof file.smtp?.pass === "string" ? file.smtp.pass : "";
  const hasEncryptedPass = typeof file.smtp?.passEnc === "string" && file.smtp.passEnc.trim().length > 0;
  if (legacyPass && !hasEncryptedPass) {
    const encrypted = encryptSecret(legacyPass);
    if (encrypted) {
      const smtpRaw = file.smtp ?? {};
      const { pass: _legacyPass, ...smtpWithoutLegacyPass } = smtpRaw;
      await writeJsonFile(config.runtimeSettingsFile, {
        ...file,
        smtp: {
          ...smtpWithoutLegacyPass,
          passEnc: encrypted
        },
        updatedAt: new Date().toISOString()
      });
    }
  }
  initialized = true;
};

const ensureInitialized = (): void => {
  if (!initialized) {
    currentIndexBackend = config.indexBackend;
    currentUiMode = "simple";
    currentPublicRead = false;
    currentUploadDerivativesEnabled = config.uploadDerivativesEnabled;
    currentSmtp = {
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      user: config.smtpUser,
      pass: config.smtpPass,
      from: config.smtpFrom
    };
    currentCommentModeration = {
      moderationMode: "moderated",
      trustedAutoApproveUsernames: []
    };
    initialized = true;
  }
};

export const getIndexBackend = (): IndexBackend => {
  ensureInitialized();
  return currentIndexBackend;
};

export const getUiMode = (): UiMode => {
  ensureInitialized();
  return currentUiMode;
};

export const getPublicReadEnabled = (): boolean => {
  ensureInitialized();
  return currentPublicRead;
};

export const getUploadDerivativesEnabled = (): boolean => {
  ensureInitialized();
  return currentUploadDerivativesEnabled;
};

export const getSmtpSettings = async (): Promise<RuntimeSmtpSettings> => {
  const file = await loadRuntimeSettingsFile();
  const smtp = normalizeSmtpSettings(file.smtp, currentSmtp);
  currentSmtp = smtp;
  initialized = true;
  return smtp;
};

export const getRuntimeSettings = async (): Promise<RuntimeSettings> => {
  const file = await loadRuntimeSettingsFile();
  const indexBackend = normalizeIndexBackend(file.indexBackend ?? currentIndexBackend);
  const uiMode = normalizeUiMode(file.uiMode ?? currentUiMode);
  const publicRead = normalizePublicRead(file.publicRead ?? currentPublicRead);
  const uploadDerivativesEnabled = normalizePublicRead(file.uploadDerivativesEnabled ?? currentUploadDerivativesEnabled);
  const smtp = normalizeSmtpSettings(file.smtp, currentSmtp);
  const comments = normalizeCommentModerationSettings(file.comments, currentCommentModeration);
  currentIndexBackend = indexBackend;
  currentUiMode = uiMode;
  currentPublicRead = publicRead;
  currentUploadDerivativesEnabled = uploadDerivativesEnabled;
  currentSmtp = smtp;
  currentCommentModeration = comments;
  initialized = true;

  return {
    indexBackend,
    uiMode,
    publicRead,
    uploadDerivativesEnabled,
    smtp,
    comments,
    ...(typeof file.updatedAt === "string" && file.updatedAt.trim().length > 0 ? { updatedAt: file.updatedAt } : {}),
    ...(typeof file.updatedBy === "string" && file.updatedBy.trim().length > 0 ? { updatedBy: file.updatedBy } : {})
  };
};

export const getCommentModerationSettings = async (): Promise<RuntimeCommentModerationSettings> => {
  const file = await loadRuntimeSettingsFile();
  const comments = normalizeCommentModerationSettings(file.comments, currentCommentModeration);
  currentCommentModeration = comments;
  initialized = true;
  return comments;
};

export const setSmtpSettings = async (input: {
  host: string;
  port: string;
  secure: string | boolean;
  user: string;
  pass: string;
  from: string;
  updatedBy?: string;
}): Promise<{ ok: boolean; changed: boolean; smtp: RuntimeSmtpSettings; error?: string }> =>
  withMutationLock(async () => {
    const host = input.host.trim();
    const port = normalizePositiveInt(input.port, 0);
    const secure = normalizePublicRead(input.secure);
    const user = input.user.trim();
    const pass = input.pass;
    const from = input.from.trim();

    if (host.length > 255) {
      return { ok: false, changed: false, smtp: currentSmtp, error: "SMTP-Host ist zu lang (max. 255 Zeichen)." };
    }
    if (host.length > 0 && (port < 1 || port > 65535)) {
      return { ok: false, changed: false, smtp: currentSmtp, error: "SMTP-Port muss zwischen 1 und 65535 liegen." };
    }
    if (from.length > 260) {
      return { ok: false, changed: false, smtp: currentSmtp, error: "SMTP-Absender ist zu lang (max. 260 Zeichen)." };
    }
    if (user.length > 254) {
      return { ok: false, changed: false, smtp: currentSmtp, error: "SMTP-Benutzer ist zu lang (max. 254 Zeichen)." };
    }

    const file = await loadRuntimeSettingsFile();
    const previous = normalizeSmtpSettings(file.smtp, currentSmtp);
    const nextSmtp: RuntimeSmtpSettings = { host, port: host ? port : 587, secure, user, pass, from };
    const changed =
      previous.host !== nextSmtp.host ||
      previous.port !== nextSmtp.port ||
      previous.secure !== nextSmtp.secure ||
      previous.user !== nextSmtp.user ||
      previous.pass !== nextSmtp.pass ||
      previous.from !== nextSmtp.from;

    const next: RuntimeSettingsFile = {
      ...file,
      indexBackend: normalizeIndexBackend(file.indexBackend ?? currentIndexBackend),
      uiMode: normalizeUiMode(file.uiMode ?? currentUiMode),
      publicRead: normalizePublicRead(file.publicRead ?? currentPublicRead),
      uploadDerivativesEnabled: normalizePublicRead(file.uploadDerivativesEnabled ?? currentUploadDerivativesEnabled),
      smtp: {
        host: nextSmtp.host,
        port: nextSmtp.port,
        secure: nextSmtp.secure,
        user: nextSmtp.user,
        ...(nextSmtp.pass
          ? (() => {
              const encrypted = encryptSecret(nextSmtp.pass);
              if (encrypted) return { passEnc: encrypted };
              return { pass: nextSmtp.pass };
            })()
          : {}),
        from: nextSmtp.from
      },
      updatedAt: new Date().toISOString(),
      ...(input.updatedBy ? { updatedBy: input.updatedBy } : {})
    };

    if (nextSmtp.pass && !canEncryptSecrets()) {
      console.warn("[runtime-settings] SECRET_ENCRYPTION_KEY (oder CONTENT_ENCRYPTION_KEY-Fallback) fehlt oder ist ungültig. SMTP-Passwort wird als Klartext gespeichert.");
    }
    await writeJsonFile(config.runtimeSettingsFile, next);
    currentSmtp = nextSmtp;
    initialized = true;

    return { ok: true, changed, smtp: nextSmtp };
  });

export const setIndexBackend = async (input: {
  backend: string;
  updatedBy?: string;
}): Promise<{ ok: boolean; changed: boolean; indexBackend: IndexBackend; error?: string }> =>
  withMutationLock(async () => {
    const normalized = normalizeIndexBackend(input.backend);
    const requested = input.backend.trim().toLowerCase();
    if (requested !== "flat" && requested !== "sqlite") {
      return {
        ok: false,
        changed: false,
        indexBackend: currentIndexBackend,
        error: "Ungültiges Index-Backend."
      };
    }

    const file = await loadRuntimeSettingsFile();
    const previous = normalizeIndexBackend(file.indexBackend ?? currentIndexBackend);
    const changed = previous !== normalized;

    const next: RuntimeSettingsFile = {
      ...file,
      indexBackend: normalized,
      uiMode: normalizeUiMode(file.uiMode ?? currentUiMode),
      publicRead: normalizePublicRead(file.publicRead ?? currentPublicRead),
      uploadDerivativesEnabled: normalizePublicRead(file.uploadDerivativesEnabled ?? currentUploadDerivativesEnabled),
      updatedAt: new Date().toISOString(),
      ...(input.updatedBy ? { updatedBy: input.updatedBy } : {})
    };

    await writeJsonFile(config.runtimeSettingsFile, next);
    currentIndexBackend = normalized;
    initialized = true;

    return {
      ok: true,
      changed,
      indexBackend: normalized
    };
  });

export const setUiMode = async (input: {
  mode: string;
  updatedBy?: string;
}): Promise<{ ok: boolean; changed: boolean; uiMode: UiMode; error?: string }> =>
  withMutationLock(async () => {
    const requested = input.mode.trim().toLowerCase();
    if (requested !== "simple" && requested !== "advanced") {
      return {
        ok: false,
        changed: false,
        uiMode: currentUiMode,
        error: "Ungültiger Bedienmodus."
      };
    }

    const normalized = normalizeUiMode(requested);
    const file = await loadRuntimeSettingsFile();
    const previous = normalizeUiMode(file.uiMode ?? currentUiMode);
    const changed = previous !== normalized;

    const next: RuntimeSettingsFile = {
      ...file,
      indexBackend: normalizeIndexBackend(file.indexBackend ?? currentIndexBackend),
      uiMode: normalized,
      publicRead: normalizePublicRead(file.publicRead ?? currentPublicRead),
      uploadDerivativesEnabled: normalizePublicRead(file.uploadDerivativesEnabled ?? currentUploadDerivativesEnabled),
      updatedAt: new Date().toISOString(),
      ...(input.updatedBy ? { updatedBy: input.updatedBy } : {})
    };

    await writeJsonFile(config.runtimeSettingsFile, next);
    currentUiMode = normalized;
    initialized = true;

    return {
      ok: true,
      changed,
      uiMode: normalized
    };
  });

export const setPublicRead = async (input: {
  enabled: string | boolean;
  updatedBy?: string;
}): Promise<{ ok: boolean; changed: boolean; publicRead: boolean; error?: string }> =>
  withMutationLock(async () => {
    const normalized = normalizePublicRead(input.enabled);

    if (typeof input.enabled === "string") {
      const requested = input.enabled.trim().toLowerCase();
      if (!["1", "0", "true", "false", "yes", "no", "on", "off"].includes(requested)) {
        return {
          ok: false,
          changed: false,
          publicRead: currentPublicRead,
          error: "Ungültiger Wert für öffentlichen Lesemodus."
        };
      }
    }

    const file = await loadRuntimeSettingsFile();
    const previous = normalizePublicRead(file.publicRead ?? currentPublicRead);
    const changed = previous !== normalized;

    const next: RuntimeSettingsFile = {
      ...file,
      indexBackend: normalizeIndexBackend(file.indexBackend ?? currentIndexBackend),
      uiMode: normalizeUiMode(file.uiMode ?? currentUiMode),
      publicRead: normalized,
      uploadDerivativesEnabled: normalizePublicRead(file.uploadDerivativesEnabled ?? currentUploadDerivativesEnabled),
      updatedAt: new Date().toISOString(),
      ...(input.updatedBy ? { updatedBy: input.updatedBy } : {})
    };

    await writeJsonFile(config.runtimeSettingsFile, next);
    currentPublicRead = normalized;
    initialized = true;

    return {
      ok: true,
      changed,
      publicRead: normalized
    };
  });

export const setUploadDerivativesEnabled = async (input: {
  enabled: string | boolean;
  updatedBy?: string;
}): Promise<{ ok: boolean; changed: boolean; uploadDerivativesEnabled: boolean; error?: string }> =>
  withMutationLock(async () => {
    const normalized = normalizePublicRead(input.enabled);

    if (typeof input.enabled === "string") {
      const requested = input.enabled.trim().toLowerCase();
      if (!["1", "0", "true", "false", "yes", "no", "on", "off"].includes(requested)) {
        return {
          ok: false,
          changed: false,
          uploadDerivativesEnabled: currentUploadDerivativesEnabled,
          error: "Ungültiger Wert für Upload-Derivate."
        };
      }
    }

    const file = await loadRuntimeSettingsFile();
    const previous = normalizePublicRead(file.uploadDerivativesEnabled ?? currentUploadDerivativesEnabled);
    const changed = previous !== normalized;

    const next: RuntimeSettingsFile = {
      ...file,
      indexBackend: normalizeIndexBackend(file.indexBackend ?? currentIndexBackend),
      uiMode: normalizeUiMode(file.uiMode ?? currentUiMode),
      publicRead: normalizePublicRead(file.publicRead ?? currentPublicRead),
      uploadDerivativesEnabled: normalized,
      updatedAt: new Date().toISOString(),
      ...(input.updatedBy ? { updatedBy: input.updatedBy } : {})
    };

    await writeJsonFile(config.runtimeSettingsFile, next);
    currentUploadDerivativesEnabled = normalized;
    initialized = true;

    return {
      ok: true,
      changed,
      uploadDerivativesEnabled: normalized
    };
  });

export const validateAndRepairRuntimeSettings = async (input?: {
  updatedBy?: string;
}): Promise<{ ok: boolean; changed: boolean; fixes: string[] }> =>
  withMutationLock(async () => {
    const file = await loadRuntimeSettingsFile();
    const fixes: string[] = [];

    const normalizedIndexBackend = normalizeIndexBackend(file.indexBackend ?? currentIndexBackend);
    if ((file.indexBackend ?? "").trim().toLowerCase() !== normalizedIndexBackend) {
      fixes.push("Index-Backend auf gültigen Wert normalisiert.");
    }

    const normalizedUiMode = normalizeUiMode(file.uiMode ?? currentUiMode);
    if ((file.uiMode ?? "").trim().toLowerCase() !== normalizedUiMode) {
      fixes.push("Bedienmodus auf gültigen Wert normalisiert.");
    }

    const normalizedPublicRead = normalizePublicRead(file.publicRead ?? currentPublicRead);
    const normalizedUploadDerivatives = normalizePublicRead(file.uploadDerivativesEnabled ?? currentUploadDerivativesEnabled);

    const normalizedComments = normalizeCommentModerationSettings(file.comments, currentCommentModeration);
    const rawTrusted = Array.isArray(file.comments?.trustedAutoApproveUsernames) ? file.comments?.trustedAutoApproveUsernames : [];
    if (rawTrusted.length !== normalizedComments.trustedAutoApproveUsernames.length) {
      fixes.push("Doppelte/ungültige Trusted-Usernamen bereinigt.");
    }

    const normalizedSmtp = normalizeSmtpSettings(file.smtp, currentSmtp);
    const normalized: RuntimeSettingsFile = {
      ...file,
      indexBackend: normalizedIndexBackend,
      uiMode: normalizedUiMode,
      publicRead: normalizedPublicRead,
      uploadDerivativesEnabled: normalizedUploadDerivatives,
      smtp: {
        host: normalizedSmtp.host,
        port: normalizedSmtp.port,
        secure: normalizedSmtp.secure,
        user: normalizedSmtp.user,
        ...(normalizedSmtp.pass
          ? (() => {
              const encrypted = encryptSecret(normalizedSmtp.pass);
              if (encrypted) return { passEnc: encrypted };
              return { pass: normalizedSmtp.pass };
            })()
          : {}),
        from: normalizedSmtp.from
      },
      comments: {
        moderationMode: normalizedComments.moderationMode,
        trustedAutoApproveUsernames: normalizedComments.trustedAutoApproveUsernames
      },
      updatedAt: new Date().toISOString(),
      ...(input?.updatedBy ? { updatedBy: input.updatedBy } : {})
    };

    const changed = JSON.stringify(file) !== JSON.stringify(normalized);
    if (!changed) {
      return { ok: true, changed: false, fixes: [] };
    }

    await writeJsonFile(config.runtimeSettingsFile, normalized);
    currentIndexBackend = normalizedIndexBackend;
    currentUiMode = normalizedUiMode;
    currentPublicRead = normalizedPublicRead;
    currentUploadDerivativesEnabled = normalizedUploadDerivatives;
    currentSmtp = normalizedSmtp;
    currentCommentModeration = normalizedComments;
    initialized = true;

    return { ok: true, changed: true, fixes };
  });

export const setCommentModerationSettings = async (input: {
  moderationMode: string;
  trustedAutoApproveUsernames: string[];
  updatedBy?: string;
}): Promise<{ ok: boolean; changed: boolean; comments: RuntimeCommentModerationSettings; error?: string }> =>
  withMutationLock(async () => {
    const moderationMode = normalizeCommentModerationMode(input.moderationMode);
    const requestedMode = normalizeText(input.moderationMode).toLowerCase();
    if (!["moderated", "all_auto", "trusted_auto"].includes(requestedMode)) {
      return { ok: false, changed: false, comments: currentCommentModeration, error: "Ungültiger Moderationsmodus." };
    }

    const trustedAutoApproveUsernames = normalizeTrustedUsernames(input.trustedAutoApproveUsernames);
    const file = await loadRuntimeSettingsFile();
    const previous = normalizeCommentModerationSettings(file.comments, currentCommentModeration);
    const nextComments: RuntimeCommentModerationSettings = {
      moderationMode,
      trustedAutoApproveUsernames
    };
    const changed =
      previous.moderationMode !== nextComments.moderationMode ||
      previous.trustedAutoApproveUsernames.join(",") !== nextComments.trustedAutoApproveUsernames.join(",");

    const next: RuntimeSettingsFile = {
      ...file,
      comments: {
        moderationMode: nextComments.moderationMode,
        trustedAutoApproveUsernames: nextComments.trustedAutoApproveUsernames
      },
      updatedAt: new Date().toISOString(),
      ...(input.updatedBy ? { updatedBy: input.updatedBy } : {})
    };

    await writeJsonFile(config.runtimeSettingsFile, next);
    currentCommentModeration = nextComments;
    initialized = true;
    return { ok: true, changed, comments: nextComments };
  });
