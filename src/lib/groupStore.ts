import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { UserGroup } from "../types.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

const GROUP_NAME_MIN = 2;
const GROUP_NAME_MAX = 80;
const GROUP_DESC_MAX = 300;

let mutationQueue: Promise<void> = Promise.resolve();

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

const normalizeGroupName = (value: string): string => value.trim().replace(/\s+/g, " ");

const normalizeGroupDescription = (value: string): string => value.trim().replace(/\s+/g, " ");

const normalizeMembers = (members: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of members) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
};

const ensureGroupsFile = async (): Promise<void> => {
  await ensureFile(config.groupsFile, "[]\n");
};

const loadGroups = async (): Promise<UserGroup[]> => {
  await ensureGroupsFile();
  const groups = await readJsonFile<UserGroup[]>(config.groupsFile, []);

  return groups
    .filter((entry) => Boolean(entry && entry.id && entry.name))
    .map((entry) => ({
      id: String(entry.id),
      name: normalizeGroupName(String(entry.name)),
      description: normalizeGroupDescription(String(entry.description ?? "")),
      members: normalizeMembers(Array.isArray(entry.members) ? entry.members.map((value) => String(value)) : []),
      createdAt: String(entry.createdAt ?? new Date().toISOString()),
      updatedAt: String(entry.updatedAt ?? new Date().toISOString())
    }));
};

const saveGroups = async (groups: UserGroup[]): Promise<void> => {
  await writeJsonFile(config.groupsFile, groups);
};

const validateGroupName = (name: string): string | null => {
  const normalized = normalizeGroupName(name);
  if (normalized.length < GROUP_NAME_MIN || normalized.length > GROUP_NAME_MAX) {
    return `Gruppenname muss zwischen ${GROUP_NAME_MIN} und ${GROUP_NAME_MAX} Zeichen lang sein.`;
  }

  return null;
};

const validateGroupDescription = (description: string): string | null => {
  const normalized = normalizeGroupDescription(description);
  if (normalized.length > GROUP_DESC_MAX) {
    return `Beschreibung darf maximal ${GROUP_DESC_MAX} Zeichen lang sein.`;
  }
  return null;
};

export const listGroups = async (): Promise<UserGroup[]> => {
  const groups = await loadGroups();
  return [...groups].sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
};

export const findGroupById = async (id: string): Promise<UserGroup | null> => {
  const normalizedId = id.trim();
  if (!normalizedId) return null;
  const groups = await loadGroups();
  return groups.find((group) => group.id === normalizedId) ?? null;
};

export const createGroup = async (input: {
  name: string;
  description?: string;
}): Promise<{ ok: boolean; group?: UserGroup; error?: string }> => {
  return withMutationLock(async () => {
    const normalizedName = normalizeGroupName(input.name);
    const normalizedDescription = normalizeGroupDescription(input.description ?? "");

    const nameError = validateGroupName(normalizedName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const descriptionError = validateGroupDescription(normalizedDescription);
    if (descriptionError) {
      return { ok: false, error: descriptionError };
    }

    const groups = await loadGroups();
    const duplicate = groups.some((group) => group.name.toLowerCase() === normalizedName.toLowerCase());
    if (duplicate) {
      return { ok: false, error: "Gruppenname existiert bereits." };
    }

    const now = new Date().toISOString();
    const group: UserGroup = {
      id: randomUUID(),
      name: normalizedName,
      description: normalizedDescription,
      members: [],
      createdAt: now,
      updatedAt: now
    };

    groups.push(group);
    await saveGroups(groups);

    return { ok: true, group };
  });
};

export const updateGroup = async (
  groupId: string,
  input: { name: string; description?: string }
): Promise<{ ok: boolean; group?: UserGroup; error?: string }> => {
  return withMutationLock(async () => {
    const groups = await loadGroups();
    const target = groups.find((group) => group.id === groupId);
    if (!target) {
      return { ok: false, error: "Gruppe nicht gefunden." };
    }

    const normalizedName = normalizeGroupName(input.name);
    const normalizedDescription = normalizeGroupDescription(input.description ?? "");

    const nameError = validateGroupName(normalizedName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const descriptionError = validateGroupDescription(normalizedDescription);
    if (descriptionError) {
      return { ok: false, error: descriptionError };
    }

    const duplicate = groups.some((group) => group.id !== groupId && group.name.toLowerCase() === normalizedName.toLowerCase());
    if (duplicate) {
      return { ok: false, error: "Gruppenname existiert bereits." };
    }

    target.name = normalizedName;
    target.description = normalizedDescription;
    target.updatedAt = new Date().toISOString();

    await saveGroups(groups);
    return { ok: true, group: target };
  });
};

export const setGroupMembers = async (
  groupId: string,
  members: string[]
): Promise<{ ok: boolean; group?: UserGroup; error?: string }> => {
  return withMutationLock(async () => {
    const groups = await loadGroups();
    const target = groups.find((group) => group.id === groupId);
    if (!target) {
      return { ok: false, error: "Gruppe nicht gefunden." };
    }

    target.members = normalizeMembers(members);
    target.updatedAt = new Date().toISOString();
    await saveGroups(groups);

    return { ok: true, group: target };
  });
};

export const deleteGroup = async (groupId: string): Promise<boolean> => {
  return withMutationLock(async () => {
    const groups = await loadGroups();
    const next = groups.filter((group) => group.id !== groupId);
    if (next.length === groups.length) return false;
    await saveGroups(next);
    return true;
  });
};

export const listGroupIdsForUser = async (username: string): Promise<string[]> => {
  const normalized = username.trim().toLowerCase();
  if (!normalized) return [];

  const groups = await loadGroups();
  return groups.filter((group) => group.members.includes(normalized)).map((group) => group.id);
};

export const removeUserFromAllGroups = async (username: string): Promise<number> => {
  return withMutationLock(async () => {
    const normalized = username.trim().toLowerCase();
    if (!normalized) return 0;

    const groups = await loadGroups();
    let touched = 0;

    for (const group of groups) {
      const before = group.members.length;
      group.members = group.members.filter((member) => member !== normalized);
      if (group.members.length !== before) {
        touched += 1;
        group.updatedAt = new Date().toISOString();
      }
    }

    if (touched > 0) {
      await saveGroups(groups);
    }

    return touched;
  });
};
