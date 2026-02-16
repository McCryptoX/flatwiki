import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { WikiPageTemplate, WikiTemplateSensitivity } from "../types.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

const DEFAULT_TEMPLATES: Array<
  Omit<WikiPageTemplate, "createdAt" | "updatedAt">
> = [
  {
    id: "idea",
    name: "Idee",
    description: "Für schnelle Ideen und erste Konzepte.",
    defaultTitle: "Neue Idee",
    defaultTags: ["idee"],
    defaultContent: `## Idee in einem Satz

Beschreibe die Idee kurz und klar.

## Ziel / Nutzen

- Welches Problem wird gelöst?
- Für wen ist es hilfreich?

## Nächste Schritte

- [ ] Ersten Entwurf erstellen
- [ ] Aufwand einschätzen
- [ ] Entscheidung treffen`,
    sensitivity: "normal",
    enabled: true,
    sortOrder: 10,
    system: true
  },
  {
    id: "documentation",
    name: "Dokumentation",
    description: "Für Prozesse, Anleitungen und technische Notizen.",
    defaultTitle: "Neue Dokumentation",
    defaultTags: ["doku", "howto"],
    defaultContent: `## Zweck

Wofür ist diese Dokumentation gedacht?

## Schritt-für-Schritt

1. Schritt 1
2. Schritt 2
3. Schritt 3

## Fehlerbehebung

- Problem:
- Lösung:`,
    sensitivity: "normal",
    enabled: true,
    sortOrder: 20,
    system: true
  },
  {
    id: "travel",
    name: "Reisebericht",
    description: "Für Urlaubstagebuch, Orte und Fotos.",
    defaultTitle: "Reisebericht",
    defaultTags: ["reise", "urlaub"],
    defaultContent: `## Reiseüberblick

- Zeitraum:
- Ort:
- Mit wem:

## Tagesnotizen

### Tag 1

Was ist passiert?

### Tag 2

Was war besonders?

## Tipps für das nächste Mal

- Tipp 1
- Tipp 2`,
    sensitivity: "normal",
    enabled: true,
    sortOrder: 30,
    system: true
  },
  {
    id: "finance",
    name: "Finanznotiz",
    description: "Für sensible Finanz- oder Vertragsnotizen.",
    defaultTitle: "Finanznotiz",
    defaultTags: ["finanzen", "sensibel"],
    defaultContent: `## Zusammenfassung

Kurzer Überblick über den aktuellen Stand.

## Konten / Depots

- Konto/Depot A:
- Konto/Depot B:

## Änderungen

- Datum:
- Was wurde geändert:

## Hinweis

Keine PIN/TAN im Klartext speichern. Für besonders sensible Daten verschlüsseln und Zugriff einschränken.`,
    sensitivity: "sensitive",
    enabled: true,
    sortOrder: 40,
    system: true
  },
  {
    id: "blank",
    name: "Leer starten",
    description: "Leere Seite ohne Vorgaben.",
    defaultTitle: "",
    defaultTags: [],
    defaultContent: "",
    sensitivity: "normal",
    enabled: true,
    sortOrder: 1000,
    system: true
  }
];

const normalizeTemplateName = (value: string): string => value.trim().replace(/\s+/g, " ");

const normalizeDescription = (value: string): string => value.trim().replace(/\s+/g, " ").slice(0, 260);

const normalizeTitle = (value: string): string => value.trim().slice(0, 120);

const normalizeTags = (value: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of value) {
    const tag = raw.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    output.push(tag);
    if (output.length >= 20) break;
  }
  return output;
};

const normalizeSensitivity = (value: unknown): WikiTemplateSensitivity => (value === "sensitive" ? "sensitive" : "normal");

const normalizeSortOrder = (value: unknown, fallback = 100): number => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, -100000), 100000);
};

const slugifyTemplateId = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const sortTemplates = (templates: WikiPageTemplate[]): WikiPageTemplate[] =>
  [...templates].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "de", { sensitivity: "base" }) || a.id.localeCompare(b.id)
  );

const ensureTemplatesFile = async (): Promise<void> => {
  await ensureFile(config.templatesFile, "[]\n");
};

const toTemplate = (entry: Record<string, unknown>): WikiPageTemplate | null => {
  const id = String(entry.id ?? "").trim();
  if (!id) return null;

  const name = normalizeTemplateName(String(entry.name ?? ""));
  if (!name) return null;

  const defaultTags = Array.isArray(entry.defaultTags)
    ? normalizeTags(entry.defaultTags.map((tag) => String(tag)))
    : [];

  const createdAtRaw = String(entry.createdAt ?? "").trim();
  const updatedAtRaw = String(entry.updatedAt ?? "").trim();
  const now = new Date().toISOString();

  const template: WikiPageTemplate = {
    id,
    name,
    description: normalizeDescription(String(entry.description ?? "")),
    defaultTitle: normalizeTitle(String(entry.defaultTitle ?? "")),
    defaultTags,
    defaultContent: String(entry.defaultContent ?? ""),
    sensitivity: normalizeSensitivity(entry.sensitivity),
    enabled: Boolean(entry.enabled),
    sortOrder: normalizeSortOrder(entry.sortOrder),
    system: Boolean(entry.system),
    createdAt: createdAtRaw || now,
    updatedAt: updatedAtRaw || now
  };

  if (template.id === "blank") {
    template.enabled = true;
    template.system = true;
  }

  return template;
};

const loadTemplates = async (): Promise<WikiPageTemplate[]> => {
  await ensureTemplatesFile();
  const raw = await readJsonFile<unknown[]>(config.templatesFile, []);
  if (!Array.isArray(raw)) return [];

  const output: WikiPageTemplate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const template = toTemplate(item as Record<string, unknown>);
    if (!template) continue;
    output.push(template);
  }
  return sortTemplates(output);
};

const saveTemplates = async (templates: WikiPageTemplate[]): Promise<void> => {
  await writeJsonFile(config.templatesFile, sortTemplates(templates));
};

export const ensureDefaultTemplates = async (): Promise<WikiPageTemplate[]> => {
  const templates = await loadTemplates();
  const map = new Map(templates.map((template) => [template.id, template]));
  const now = new Date().toISOString();
  let changed = false;

  for (const fallback of DEFAULT_TEMPLATES) {
    const existing = map.get(fallback.id);
    if (existing) {
      if (existing.id === "blank" && !existing.enabled) {
        existing.enabled = true;
        existing.updatedAt = now;
        changed = true;
      }
      if (!existing.system) {
        existing.system = fallback.system;
        existing.updatedAt = now;
        changed = true;
      }
      continue;
    }

    map.set(fallback.id, {
      ...fallback,
      createdAt: now,
      updatedAt: now
    });
    changed = true;
  }

  const merged = sortTemplates(Array.from(map.values()));
  if (!changed) return merged;

  await saveTemplates(merged);
  return merged;
};

export const listTemplates = async (options?: { includeDisabled?: boolean }): Promise<WikiPageTemplate[]> => {
  const includeDisabled = options?.includeDisabled ?? true;
  const templates = await ensureDefaultTemplates();
  if (includeDisabled) return templates;
  return templates.filter((template) => template.enabled);
};

export const findTemplateById = async (id: string): Promise<WikiPageTemplate | null> => {
  const normalized = id.trim();
  if (!normalized) return null;
  const templates = await listTemplates({ includeDisabled: true });
  return templates.find((template) => template.id === normalized) ?? null;
};

export const createTemplate = async (input: {
  name: string;
  description: string;
  defaultTitle: string;
  defaultTags: string[];
  defaultContent: string;
  sensitivity: WikiTemplateSensitivity;
  enabled: boolean;
  sortOrder?: number;
}): Promise<{ ok: boolean; template?: WikiPageTemplate; error?: string }> => {
  const name = normalizeTemplateName(input.name);
  if (name.length < 2 || name.length > 80) {
    return { ok: false, error: "Vorlagenname muss zwischen 2 und 80 Zeichen lang sein." };
  }

  const templates = await listTemplates({ includeDisabled: true });
  const duplicate = templates.some((template) => template.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    return { ok: false, error: "Vorlagenname existiert bereits." };
  }

  const usedIds = new Set(templates.map((template) => template.id));
  const baseId = slugifyTemplateId(name);
  let id = baseId || `template-${randomUUID().slice(0, 8)}`;
  let counter = 2;
  while (usedIds.has(id)) {
    id = baseId ? `${baseId}-${counter}` : `template-${randomUUID().slice(0, 8)}`;
    counter += 1;
  }

  const now = new Date().toISOString();
  const currentMaxOrder = templates.reduce((max, template) => Math.max(max, template.sortOrder), 0);
  const template: WikiPageTemplate = {
    id,
    name,
    description: normalizeDescription(input.description),
    defaultTitle: normalizeTitle(input.defaultTitle),
    defaultTags: normalizeTags(input.defaultTags),
    defaultContent: String(input.defaultContent ?? ""),
    sensitivity: normalizeSensitivity(input.sensitivity),
    enabled: Boolean(input.enabled),
    sortOrder: normalizeSortOrder(input.sortOrder, currentMaxOrder + 10),
    system: false,
    createdAt: now,
    updatedAt: now
  };

  await saveTemplates([...templates, template]);
  return { ok: true, template };
};

export const updateTemplate = async (input: {
  id: string;
  name: string;
  description: string;
  defaultTitle: string;
  defaultTags: string[];
  defaultContent: string;
  sensitivity: WikiTemplateSensitivity;
  enabled: boolean;
  sortOrder: number;
}): Promise<{ ok: boolean; template?: WikiPageTemplate; error?: string }> => {
  const templates = await listTemplates({ includeDisabled: true });
  const template = templates.find((entry) => entry.id === input.id.trim());
  if (!template) {
    return { ok: false, error: "Vorlage nicht gefunden." };
  }

  const name = normalizeTemplateName(input.name);
  if (name.length < 2 || name.length > 80) {
    return { ok: false, error: "Vorlagenname muss zwischen 2 und 80 Zeichen lang sein." };
  }

  const duplicate = templates.some(
    (entry) => entry.id !== template.id && entry.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    return { ok: false, error: "Vorlagenname existiert bereits." };
  }

  if (template.id === "blank" && !input.enabled) {
    return { ok: false, error: 'Die Systemvorlage "Leer starten" muss aktiv bleiben.' };
  }

  template.name = name;
  template.description = normalizeDescription(input.description);
  template.defaultTitle = normalizeTitle(input.defaultTitle);
  template.defaultTags = normalizeTags(input.defaultTags);
  template.defaultContent = String(input.defaultContent ?? "");
  template.sensitivity = normalizeSensitivity(input.sensitivity);
  template.enabled = Boolean(input.enabled);
  template.sortOrder = normalizeSortOrder(input.sortOrder, template.sortOrder);
  template.updatedAt = new Date().toISOString();

  await saveTemplates(templates);
  return { ok: true, template };
};

export const deleteTemplate = async (id: string): Promise<{ ok: boolean; error?: string }> => {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return { ok: false, error: "Ungültige Vorlagen-ID." };
  }

  const templates = await listTemplates({ includeDisabled: true });
  const target = templates.find((template) => template.id === normalizedId);
  if (!target) {
    return { ok: false, error: "Vorlage nicht gefunden." };
  }

  if (target.system) {
    return { ok: false, error: "Systemvorlagen können nicht gelöscht werden. Bitte deaktivieren." };
  }

  const next = templates.filter((template) => template.id !== normalizedId);
  if (next.filter((template) => template.enabled).length < 1) {
    return { ok: false, error: "Mindestens eine aktive Vorlage muss erhalten bleiben." };
  }

  await saveTemplates(next);
  return { ok: true };
};
