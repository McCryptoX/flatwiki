import { config, type IndexBackend } from "../config.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

export type UiMode = "simple" | "advanced";

interface RuntimeSettingsFile {
  indexBackend?: string;
  uiMode?: string;
  publicRead?: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

interface RuntimeSettings {
  indexBackend: IndexBackend;
  uiMode: UiMode;
  publicRead: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

let initialized = false;
let currentIndexBackend: IndexBackend = config.indexBackend;
let currentUiMode: UiMode = "simple";
let currentPublicRead = false;

const normalizeIndexBackend = (value: string | undefined): IndexBackend => (value?.trim().toLowerCase() === "sqlite" ? "sqlite" : "flat");
const normalizeUiMode = (value: string | undefined): UiMode => (value?.trim().toLowerCase() === "advanced" ? "advanced" : "simple");
const normalizePublicRead = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  }
  return false;
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
  initialized = true;
};

const ensureInitialized = (): void => {
  if (!initialized) {
    currentIndexBackend = config.indexBackend;
    currentUiMode = "simple";
    currentPublicRead = false;
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

export const getRuntimeSettings = async (): Promise<RuntimeSettings> => {
  const file = await loadRuntimeSettingsFile();
  const indexBackend = normalizeIndexBackend(file.indexBackend ?? currentIndexBackend);
  const uiMode = normalizeUiMode(file.uiMode ?? currentUiMode);
  const publicRead = normalizePublicRead(file.publicRead ?? currentPublicRead);
  currentIndexBackend = indexBackend;
  currentUiMode = uiMode;
  currentPublicRead = publicRead;
  initialized = true;

  return {
    indexBackend,
    uiMode,
    publicRead,
    ...(typeof file.updatedAt === "string" && file.updatedAt.trim().length > 0 ? { updatedAt: file.updatedAt } : {}),
    ...(typeof file.updatedBy === "string" && file.updatedBy.trim().length > 0 ? { updatedBy: file.updatedBy } : {})
  };
};

export const setIndexBackend = async (input: {
  backend: string;
  updatedBy?: string;
}): Promise<{ ok: boolean; changed: boolean; indexBackend: IndexBackend; error?: string }> => {
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
};

export const setUiMode = async (input: {
  mode: string;
  updatedBy?: string;
}): Promise<{ ok: boolean; changed: boolean; uiMode: UiMode; error?: string }> => {
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
};

export const setPublicRead = async (input: {
  enabled: string | boolean;
  updatedBy?: string;
}): Promise<{ ok: boolean; changed: boolean; publicRead: boolean; error?: string }> => {
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
};
