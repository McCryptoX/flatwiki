import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { WikiCategory } from "../types.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

const DEFAULT_CATEGORY_ID = "default";
const DEFAULT_CATEGORY_NAME = "Allgemein";

const normalizeCategoryName = (value: string): string => value.trim().replace(/\s+/g, " ");

const slugifyFolder = (value: string): string => {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return normalized || "allgemein";
};

const ensureCategoriesFile = async (): Promise<void> => {
  await ensureFile(config.categoriesFile, "[]\n");
};

const loadCategories = async (): Promise<WikiCategory[]> => {
  await ensureCategoriesFile();
  const categories = await readJsonFile<WikiCategory[]>(config.categoriesFile, []);
  return categories
    .filter((entry) => Boolean(entry && entry.id && entry.name && entry.uploadFolder))
    .map((entry) => ({
      ...entry,
      name: normalizeCategoryName(entry.name)
    }));
};

const saveCategories = async (categories: WikiCategory[]): Promise<void> => {
  await writeJsonFile(config.categoriesFile, categories);
};

export const ensureDefaultCategory = async (): Promise<WikiCategory> => {
  const categories = await loadCategories();
  const existing = categories.find((entry) => entry.id === DEFAULT_CATEGORY_ID);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const created: WikiCategory = {
    id: DEFAULT_CATEGORY_ID,
    name: DEFAULT_CATEGORY_NAME,
    uploadFolder: "allgemein",
    createdAt: now,
    updatedAt: now
  };

  await saveCategories([created, ...categories]);
  return created;
};

export const getDefaultCategory = async (): Promise<WikiCategory> => {
  return ensureDefaultCategory();
};

export const listCategories = async (): Promise<WikiCategory[]> => {
  const categories = await loadCategories();
  if (!categories.some((entry) => entry.id === DEFAULT_CATEGORY_ID)) {
    const created = await ensureDefaultCategory();
    return [created, ...categories];
  }

  return [...categories].sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
};

export const findCategoryById = async (id: string): Promise<WikiCategory | null> => {
  const normalized = id.trim();
  if (!normalized) return null;
  const categories = await listCategories();
  return categories.find((entry) => entry.id === normalized) ?? null;
};

export const createCategory = async (name: string): Promise<{ ok: boolean; category?: WikiCategory; error?: string }> => {
  const normalizedName = normalizeCategoryName(name);
  if (normalizedName.length < 2 || normalizedName.length > 80) {
    return { ok: false, error: "Kategoriename muss zwischen 2 und 80 Zeichen lang sein." };
  }

  const categories = await listCategories();
  const nameTaken = categories.some((entry) => entry.name.toLowerCase() === normalizedName.toLowerCase());
  if (nameTaken) {
    return { ok: false, error: "Kategoriename existiert bereits." };
  }

  const now = new Date().toISOString();
  const baseFolder = slugifyFolder(normalizedName);
  let uploadFolder = baseFolder;
  let i = 2;
  while (categories.some((entry) => entry.uploadFolder === uploadFolder)) {
    uploadFolder = `${baseFolder}-${i}`;
    i += 1;
  }

  const category: WikiCategory = {
    id: randomUUID(),
    name: normalizedName,
    uploadFolder,
    createdAt: now,
    updatedAt: now
  };

  await saveCategories([...categories, category]);
  return { ok: true, category };
};

export const renameCategory = async (
  id: string,
  name: string
): Promise<{ ok: boolean; category?: WikiCategory; error?: string }> => {
  const normalizedName = normalizeCategoryName(name);
  if (normalizedName.length < 2 || normalizedName.length > 80) {
    return { ok: false, error: "Kategoriename muss zwischen 2 und 80 Zeichen lang sein." };
  }

  const categories = await listCategories();
  const target = categories.find((entry) => entry.id === id);
  if (!target) {
    return { ok: false, error: "Kategorie nicht gefunden." };
  }

  const duplicate = categories.some(
    (entry) => entry.id !== id && entry.name.toLowerCase() === normalizedName.toLowerCase()
  );
  if (duplicate) {
    return { ok: false, error: "Kategoriename existiert bereits." };
  }

  target.name = normalizedName;
  target.updatedAt = new Date().toISOString();
  await saveCategories(categories);

  return { ok: true, category: target };
};
