import { config, type IndexBackend } from "../config.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

interface RuntimeSettingsFile {
  indexBackend?: string;
  updatedAt?: string;
  updatedBy?: string;
}

interface RuntimeSettings {
  indexBackend: IndexBackend;
  updatedAt?: string;
  updatedBy?: string;
}

let initialized = false;
let currentIndexBackend: IndexBackend = config.indexBackend;

const normalizeIndexBackend = (value: string | undefined): IndexBackend => (value?.trim().toLowerCase() === "sqlite" ? "sqlite" : "flat");

const loadRuntimeSettingsFile = async (): Promise<RuntimeSettingsFile> => {
  await ensureFile(config.runtimeSettingsFile, "{}\n");
  return readJsonFile<RuntimeSettingsFile>(config.runtimeSettingsFile, {});
};

export const initRuntimeSettings = async (): Promise<void> => {
  const file = await loadRuntimeSettingsFile();
  currentIndexBackend = normalizeIndexBackend(file.indexBackend ?? config.indexBackend);
  initialized = true;
};

const ensureInitialized = (): void => {
  if (!initialized) {
    currentIndexBackend = config.indexBackend;
    initialized = true;
  }
};

export const getIndexBackend = (): IndexBackend => {
  ensureInitialized();
  return currentIndexBackend;
};

export const getRuntimeSettings = async (): Promise<RuntimeSettings> => {
  const file = await loadRuntimeSettingsFile();
  const indexBackend = normalizeIndexBackend(file.indexBackend ?? currentIndexBackend);
  currentIndexBackend = indexBackend;
  initialized = true;

  return {
    indexBackend,
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
