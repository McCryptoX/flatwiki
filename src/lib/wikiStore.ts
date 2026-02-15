import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { marked, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";
import { config } from "../config.js";
import type { PublicUser, WikiHeading, WikiPage, WikiPageSummary, WikiVisibility } from "../types.js";
import { findCategoryById, getDefaultCategory, listCategories } from "./categoryStore.js";
import { ensureDir, readJsonFile, readTextFile, removeFile, writeTextFile } from "./fileStore.js";
import { listGroupIdsForUser } from "./groupStore.js";
import { createPageVersionSnapshot, getPageVersion, listPageVersions, type PageVersionSummary } from "./pageVersionStore.js";
import { getIndexBackend } from "./runtimeSettingsStore.js";
import { readSqliteIndexEntries } from "./sqliteIndexStore.js";

marked.use({
  gfm: true,
  breaks: true
});

const SLUG_PATTERN = /^[a-z0-9-]{1,80}$/;
const SUGGESTION_INDEX_MAX_AGE_MS = 20_000;

interface EncryptedPayload {
  encIv: string;
  encTag: string;
  encData: string;
}

interface SuggestionIndexEntry {
  summary: WikiPageSummary;
  titleLower: string;
  tagsLower: string[];
  searchableText: string;
}

interface PersistedSearchIndexFile {
  version: number;
  generatedAt: string;
  pages: Array<
    WikiPageSummary & {
      searchableText?: string;
      updatedAtMs?: number;
    }
  >;
}

interface PageCacheEntry {
  mtimeMs: number;
  size: number;
  page: WikiPage;
}

interface SnapshotSourceMeta {
  updatedAt?: string;
  updatedBy?: string;
}

let suggestionIndex: SuggestionIndexEntry[] | null = null;
let suggestionIndexBuiltAt = 0;
let suggestionIndexDirty = true;
const pageRenderCache = new Map<string, PageCacheEntry>();
let lastWikiMutationAtMs = 0;

const cleanTextExcerpt = (markdown: string): string => {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[#>*_[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const toSafeHtml = (rawHtml: string): string => {
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "span", "pre", "code"]),
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "title"],
      "*": ["class", "id"]
    },
    allowedSchemes: ["http", "https", "mailto"]
  });
};

const headingAnchorSlug = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "section";

const collectHeadings = (content: string): WikiHeading[] => {
  const tokens = marked.lexer(content, { gfm: true, breaks: true });
  const headings = tokens.filter((token): token is Tokens.Heading => token.type === "heading" && token.depth >= 2);
  const usedIds = new Map<string, number>();

  return headings.map((heading) => {
    const text = heading.text.trim() || "Abschnitt";
    const base = headingAnchorSlug(text);
    const seen = usedIds.get(base) ?? 0;
    usedIds.set(base, seen + 1);

    const id = seen === 0 ? base : `${base}-${seen + 1}`;
    return {
      id,
      text,
      depth: Math.min(Math.max(heading.depth, 2), 6)
    };
  });
};

const renderMarkdownToHtmlWithAnchors = (content: string): { html: string; tableOfContents: WikiHeading[] } => {
  const tableOfContents = collectHeadings(content);
  const renderer = new marked.Renderer();
  let headingIndex = 0;

  renderer.heading = function headingWithAnchor({ tokens, depth }: Tokens.Heading): string {
    const inner = this.parser.parseInline(tokens);
    const normalizedDepth = Math.min(Math.max(depth, 1), 6);

    if (normalizedDepth < 2) {
      return `<h${normalizedDepth}>${inner}</h${normalizedDepth}>`;
    }

    const tocEntry = tableOfContents[headingIndex];
    headingIndex += 1;

    if (!tocEntry) {
      return `<h${normalizedDepth}>${inner}</h${normalizedDepth}>`;
    }

    return `<h${normalizedDepth} id="${tocEntry.id}">${inner}</h${normalizedDepth}>`;
  };

  const rendered = marked.parse(content, { async: false, renderer });
  const html = toSafeHtml(typeof rendered === "string" ? rendered : "");

  return {
    html,
    tableOfContents
  };
};

const normalizeTags = (rawTags: unknown): string[] => {
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .map((tag) => String(tag).trim().toLowerCase())
    .filter((tag) => tag.length > 0)
    .slice(0, 20);
};

const normalizeVisibility = (value: unknown): WikiVisibility => (value === "restricted" ? "restricted" : "all");

const normalizeAllowedUsers = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const normalized = String(item).trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
};

const normalizeAllowedGroups = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const normalized = String(item).trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
};

const getWikiShard = (slug: string): string => slug.slice(0, 2).replace(/[^a-z0-9]/g, "_").padEnd(2, "_");

const resolveLegacyPagePath = (slug: string): string => path.join(config.wikiDir, `${slug}.md`);

const resolvePagePath = (slug: string): string => path.join(config.wikiDir, getWikiShard(slug), `${slug}.md`);

const listMarkdownFilesRecursive = async (rootDir: string): Promise<string[]> => {
  const files: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;

    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = (await fs.readdir(current, {
        withFileTypes: true,
        encoding: "utf8"
      })) as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      files.push(fullPath);
    }
  }

  return files;
};

const resolveAllPagePaths = async (slug: string): Promise<string[]> => {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(normalizedSlug)) return [];

  const seen = new Set<string>();
  const matches: string[] = [];
  const addIfExists = async (filePath: string): Promise<void> => {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) return;
    try {
      await fs.access(filePath);
      seen.add(normalized);
      matches.push(filePath);
    } catch {
      // noop
    }
  };

  await addIfExists(resolvePagePath(normalizedSlug));
  await addIfExists(resolveLegacyPagePath(normalizedSlug));

  const files = await listMarkdownFilesRecursive(config.wikiDir);
  for (const filePath of files) {
    const base = path.basename(filePath, ".md");
    if (base.toLowerCase() !== normalizedSlug) continue;
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    matches.push(filePath);
  }

  return matches;
};

const resolveExistingPagePath = async (slug: string): Promise<string | null> => {
  const matches = await resolveAllPagePaths(slug);
  return matches[0] ?? null;
};

const snapshotCurrentPageFile = async (input: {
  slug: string;
  actor: string;
  reason: "update" | "delete" | "restore-backup";
  source?: SnapshotSourceMeta;
}): Promise<{ ok: boolean; error?: string; created: boolean }> => {
  const existingPath = await resolveExistingPagePath(input.slug);
  if (!existingPath) {
    return { ok: true, created: false };
  }

  const raw = await readTextFile(existingPath);
  if (!raw || raw.trim().length < 1) {
    return { ok: true, created: false };
  }

  const snapshot = await createPageVersionSnapshot({
    slug: input.slug,
    reason: input.reason,
    createdBy: input.actor.trim() || "unknown",
    ...(input.source?.updatedAt ? { sourceUpdatedAt: input.source.updatedAt } : {}),
    ...(input.source?.updatedBy ? { sourceUpdatedBy: input.source.updatedBy } : {}),
    fileContent: raw
  });

  if (!snapshot.ok) {
    return {
      ok: false,
      error: snapshot.error ?? "Versionierung fehlgeschlagen.",
      created: false
    };
  }

  return { ok: true, created: true };
};

const encryptContent = (plaintext: string): EncryptedPayload | null => {
  const key = config.contentEncryptionKey;
  if (!key) return null;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encIv: iv.toString("base64"),
    encTag: tag.toString("base64"),
    encData: encrypted.toString("base64")
  };
};

const decryptContent = (payload: EncryptedPayload): string | null => {
  const key = config.contentEncryptionKey;
  if (!key) return null;

  try {
    const iv = Buffer.from(payload.encIv, "base64");
    const tag = Buffer.from(payload.encTag, "base64");
    const data = Buffer.from(payload.encData, "base64");

    if (iv.length !== 12 || tag.length !== 16 || data.length < 1) {
      return null;
    }

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
};

const resolveCategoryMeta = async (categoryId: string): Promise<{ id: string; name: string }> => {
  const defaultCategory = await getDefaultCategory();
  if (!categoryId) {
    return { id: defaultCategory.id, name: defaultCategory.name };
  }

  const category = await findCategoryById(categoryId);
  if (!category) {
    return { id: defaultCategory.id, name: defaultCategory.name };
  }

  return {
    id: category.id,
    name: category.name
  };
};

const parseMarkdownPageFromPath = async (slug: string, filePath: string, fallbackTimestamp: string): Promise<WikiPage | null> => {
  const source = await readTextFile(filePath);
  if (!source) return null;

  const parsed = matter(source);
  const data = parsed.data as Record<string, unknown>;

  const category = await resolveCategoryMeta(String(data.categoryId ?? "").trim());
  const visibility = normalizeVisibility(data.visibility);
  const allowedUsers = visibility === "restricted" ? normalizeAllowedUsers(data.allowedUsers) : [];
  const allowedGroups = visibility === "restricted" ? normalizeAllowedGroups(data.allowedGroups) : [];

  const title = String(data.title ?? slug).trim() || slug;
  const tags = normalizeTags(data.tags);
  const createdBy = String(data.createdBy ?? data.updatedBy ?? "unknown");
  const createdAt = String(data.createdAt ?? data.updatedAt ?? fallbackTimestamp);
  const updatedAt = String(data.updatedAt ?? data.createdAt ?? fallbackTimestamp);
  const updatedBy = String(data.updatedBy ?? "unknown");

  const encryptedByMeta = data.encrypted === true;
  const encryptedByPayload =
    typeof data.encIv === "string" && typeof data.encTag === "string" && typeof data.encData === "string";
  const encrypted = encryptedByMeta || encryptedByPayload;

  let encryptionState: WikiPage["encryptionState"] = "none";
  let content = parsed.content.trim();

  if (encrypted) {
    const decrypted = decryptContent({
      encIv: String(data.encIv ?? ""),
      encTag: String(data.encTag ?? ""),
      encData: String(data.encData ?? "")
    });

    if (decrypted === null) {
      encryptionState = config.contentEncryptionKey ? "error" : "locked";
      content = "";
    } else {
      encryptionState = "ok";
      content = decrypted.trim();
    }
  }

  if (encrypted && encryptionState !== "ok") {
    const html =
      encryptionState === "locked"
        ? '<p class="muted-note">Dieser Artikel ist verschlüsselt. Zum Anzeigen wird <code>CONTENT_ENCRYPTION_KEY</code> benötigt.</p>'
        : '<p class="muted-note">Verschlüsselter Artikel konnte nicht entschlüsselt werden. Bitte Schlüssel prüfen.</p>';

    return {
      slug,
      title,
      categoryId: category.id,
      categoryName: category.name,
      visibility,
      allowedUsers,
      allowedGroups,
      encrypted,
      encryptionState,
      tags,
      content,
      html,
      tableOfContents: [],
      createdBy,
      createdAt,
      updatedAt,
      updatedBy
    };
  }

  const { html, tableOfContents } = renderMarkdownToHtmlWithAnchors(content);

  return {
    slug,
    title,
    categoryId: category.id,
    categoryName: category.name,
    visibility,
    allowedUsers,
    allowedGroups,
    encrypted,
    encryptionState,
    tags,
    content,
    html,
    tableOfContents,
    createdBy,
    createdAt,
    updatedAt,
    updatedBy
  };
};

const toSummary = (page: WikiPage): WikiPageSummary => ({
  slug: page.slug,
  title: page.title,
  categoryId: page.categoryId,
  categoryName: page.categoryName,
  visibility: page.visibility,
  allowedUsers: page.allowedUsers,
  allowedGroups: page.allowedGroups,
  encrypted: page.encrypted,
  tags: page.tags,
  excerpt: page.encrypted && page.encryptionState !== "ok" ? "Verschlüsselter Inhalt" : cleanTextExcerpt(page.content).slice(0, 220),
  updatedAt: page.updatedAt
});

const clonePage = (page: WikiPage): WikiPage => ({
  ...page,
  tags: [...page.tags],
  allowedUsers: [...page.allowedUsers],
  allowedGroups: [...page.allowedGroups],
  tableOfContents: page.tableOfContents.map((heading) => ({ ...heading }))
});

export const slugifyTitle = (title: string): string => {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
};

export const isValidSlug = (slug: string): boolean => SLUG_PATTERN.test(slug);

export const canUserAccessPage = (
  page:
    | Pick<WikiPage, "visibility" | "allowedUsers" | "allowedGroups">
    | Pick<WikiPageSummary, "visibility" | "allowedUsers" | "allowedGroups">,
  user: PublicUser | undefined
): boolean => {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (page.visibility === "all") return true;
  const username = user.username.toLowerCase();
  if (page.allowedUsers.includes(username)) return true;

  const userGroupIds = user.groupIds ?? [];
  if (userGroupIds.length < 1 || page.allowedGroups.length < 1) return false;
  return page.allowedGroups.some((groupId) => userGroupIds.includes(groupId));
};

const getPageFromPathWithCache = async (slug: string, filePath: string): Promise<WikiPage | null> => {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(filePath);
  } catch {
    pageRenderCache.delete(slug);
    return null;
  }

  const cached = pageRenderCache.get(slug);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return clonePage(cached.page);
  }

  const parsed = await parseMarkdownPageFromPath(slug, filePath, stats.mtime.toISOString());
  if (!parsed) {
    pageRenderCache.delete(slug);
    return null;
  }

  pageRenderCache.set(slug, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    page: parsed
  });

  return clonePage(parsed);
};

export const listPages = async (options?: { categoryId?: string; forceFileScan?: boolean }): Promise<WikiPageSummary[]> => {
  if (!options?.forceFileScan) {
    const persisted = await loadPersistedPageSummaries(options);
    if (persisted.length > 0) {
      return persisted;
    }
  }

  await ensureDir(config.wikiDir);
  const markdownFiles = await listMarkdownFilesRecursive(config.wikiDir);

  const candidateBySlug = new Map<string, { filePath: string; score: number }>();
  const scoreCandidate = (slug: string, filePath: string): number => {
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath === path.normalize(resolvePagePath(slug))) return 3;
    if (normalizedPath === path.normalize(resolveLegacyPagePath(slug))) return 2;
    return 1;
  };

  for (const filePath of markdownFiles) {
    const slug = path.basename(filePath, ".md").toLowerCase();
    if (!isValidSlug(slug)) continue;

    const score = scoreCandidate(slug, filePath);
    const current = candidateBySlug.get(slug);
    if (!current || score > current.score || (score === current.score && filePath.localeCompare(current.filePath) < 0)) {
      candidateBySlug.set(slug, { filePath, score });
    }
  }

  const pages: WikiPageSummary[] = [];

  for (const [slug, candidate] of candidateBySlug.entries()) {
    const page = await getPageFromPathWithCache(slug, candidate.filePath);
    if (!page) continue;
    if (options?.categoryId && page.categoryId !== options.categoryId) continue;
    pages.push(toSummary(page));
  }

  return pages.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
};

export const filterAccessiblePageSummaries = async (
  summaries: WikiPageSummary[],
  user: PublicUser | undefined
): Promise<WikiPageSummary[]> => {
  if (!user) return [];
  if (user.role === "admin") return summaries;

  const userWithGroups: PublicUser =
    user.groupIds && user.groupIds.length >= 0
      ? user
      : {
          ...user,
          groupIds: await listGroupIdsForUser(user.username)
        };

  return summaries.filter((summary) => canUserAccessPage(summary, userWithGroups));
};

export const listPagesForUser = async (
  user: PublicUser | undefined,
  options?: { categoryId?: string }
): Promise<WikiPageSummary[]> => {
  const pages = await listPages(options);
  return filterAccessiblePageSummaries(pages, user);
};

const buildSuggestionIndex = async (options?: { categoryId?: string }): Promise<SuggestionIndexEntry[]> => {
  const pages = await listPages(options);
  return pages.map((page) => {
    const titleLower = page.title.toLowerCase();
    const tagsLower = page.tags.map((tag) => tag.toLowerCase());
    const searchableText = `${titleLower}\n${page.excerpt.toLowerCase()}\n${tagsLower.join(" ")}`;

    return {
      summary: page,
      titleLower,
      tagsLower,
      searchableText
    };
  });
};

const getSuggestionIndex = async (options?: { categoryId?: string }): Promise<SuggestionIndexEntry[]> => {
  const now = Date.now();
  const isExpired = now - suggestionIndexBuiltAt > SUGGESTION_INDEX_MAX_AGE_MS;
  if (!suggestionIndex || suggestionIndexDirty || isExpired || options?.categoryId) {
    suggestionIndex = await buildSuggestionIndex(options);
    suggestionIndexBuiltAt = now;
    suggestionIndexDirty = false;
  }

  return suggestionIndex;
};

const loadPersistedSuggestionIndex = async (options?: { categoryId?: string }): Promise<SuggestionIndexEntry[]> => {
  if (getIndexBackend() === "sqlite") {
    const sqliteEntries = await readSqliteIndexEntries(options);
    if (sqliteEntries) {
      return sqliteEntries.map((entry) => ({
        summary: {
          slug: entry.slug,
          title: entry.title,
          categoryId: entry.categoryId,
          categoryName: entry.categoryName,
          visibility: entry.visibility,
          allowedUsers: entry.allowedUsers,
          allowedGroups: entry.allowedGroups,
          encrypted: entry.encrypted,
          tags: entry.tags,
          excerpt: entry.excerpt,
          updatedAt: entry.updatedAt
        },
        titleLower: entry.title.toLowerCase(),
        tagsLower: entry.tags.map((tag) => tag.toLowerCase()),
        searchableText: entry.searchableText
      }));
    }
  }

  const fallback: PersistedSearchIndexFile = {
    version: 0,
    generatedAt: "",
    pages: []
  };
  const persisted = await readJsonFile<PersistedSearchIndexFile>(config.searchIndexFile, fallback);
  if (!Array.isArray(persisted.pages) || persisted.pages.length < 1) {
    return [];
  }

  const generatedAtMs = Date.parse(persisted.generatedAt || "");
  if (lastWikiMutationAtMs > 0 && (!Number.isFinite(generatedAtMs) || generatedAtMs < lastWikiMutationAtMs)) {
    return [];
  }

  const entries: SuggestionIndexEntry[] = [];
  for (const raw of persisted.pages) {
    const slug = String(raw.slug ?? "").trim().toLowerCase();
    if (!isValidSlug(slug)) continue;

    const summary: WikiPageSummary = {
      slug,
      title: String(raw.title ?? slug).trim() || slug,
      categoryId: String(raw.categoryId ?? "").trim() || "default",
      categoryName: String(raw.categoryName ?? "Allgemein").trim() || "Allgemein",
      visibility: raw.visibility === "restricted" ? "restricted" : "all",
      allowedUsers: Array.isArray(raw.allowedUsers)
        ? raw.allowedUsers.map((entry) => String(entry).trim().toLowerCase()).filter((entry) => entry.length > 0)
        : [],
      allowedGroups: Array.isArray(raw.allowedGroups)
        ? raw.allowedGroups.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
        : [],
      encrypted: raw.encrypted === true,
      tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean) : [],
      excerpt: String(raw.excerpt ?? "").trim(),
      updatedAt: String(raw.updatedAt ?? "")
    };

    if (options?.categoryId && summary.categoryId !== options.categoryId) continue;

    const titleLower = summary.title.toLowerCase();
    const tagsLower = summary.tags.map((tag) => tag.toLowerCase());
    const searchableText = String(raw.searchableText ?? `${titleLower}\n${summary.excerpt}\n${tagsLower.join(" ")}`)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    entries.push({
      summary,
      titleLower,
      tagsLower,
      searchableText
    });
  }

  return entries;
};

const loadPersistedPageSummaries = async (options?: { categoryId?: string }): Promise<WikiPageSummary[]> => {
  const entries = await loadPersistedSuggestionIndex(options);
  if (entries.length < 1) return [];

  return entries
    .map((entry) => entry.summary)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
};

export const getPage = async (slug: string): Promise<WikiPage | null> => {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!isValidSlug(normalizedSlug)) return null;

  const filePath = await resolveExistingPagePath(normalizedSlug);
  if (!filePath) return null;

  return getPageFromPathWithCache(normalizedSlug, filePath);
};

export interface SavePageInput {
  slug: string;
  title: string;
  tags: string[];
  content: string;
  updatedBy: string;
  categoryId?: string;
  visibility?: WikiVisibility;
  allowedUsers?: string[];
  allowedGroups?: string[];
  encrypted?: boolean;
}

export const savePage = async (input: SavePageInput): Promise<{ ok: boolean; error?: string }> => {
  const slug = input.slug.trim().toLowerCase();
  const title = input.title.trim();

  if (!isValidSlug(slug)) {
    return { ok: false, error: "Slug ist ungültig." };
  }

  if (title.length < 2 || title.length > 120) {
    return { ok: false, error: "Titel muss zwischen 2 und 120 Zeichen lang sein." };
  }

  await ensureDir(config.wikiDir);
  const existingPaths = await resolveAllPagePaths(slug);
  const targetPath = resolvePagePath(slug);
  const existingPage = await getPage(slug);

  const category = (await findCategoryById(input.categoryId ?? "")) ?? (await getDefaultCategory());
  const visibility = input.visibility === "restricted" ? "restricted" : "all";
  const allowedUsers = visibility === "restricted" ? normalizeAllowedUsers(input.allowedUsers ?? []) : [];
  const allowedGroups = visibility === "restricted" ? normalizeAllowedGroups(input.allowedGroups ?? []) : [];

  if (visibility === "restricted" && allowedUsers.length < 1 && allowedGroups.length < 1) {
    return {
      ok: false,
      error: "Bei eingeschränktem Zugriff muss mindestens ein Benutzer oder eine Gruppe freigegeben werden."
    };
  }

  const encrypted = Boolean(input.encrypted);
  if (encrypted && !config.contentEncryptionKey) {
    return { ok: false, error: "Verschlüsselung ist nicht möglich: CONTENT_ENCRYPTION_KEY fehlt." };
  }

  const createdAt = existingPage?.createdAt ?? new Date().toISOString();
  const createdBy = existingPage?.createdBy ?? input.updatedBy;
  const updatedAt = new Date().toISOString();

  const tags = input.tags
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0)
    .slice(0, 20);

  const frontmatterData: Record<string, unknown> = {
    title,
    categoryId: category.id,
    visibility,
    allowedUsers,
    allowedGroups,
    encrypted,
    tags,
    createdBy,
    createdAt,
    updatedAt,
    updatedBy: input.updatedBy
  };

  let markdownBody = input.content.trim();
  if (encrypted) {
    const payload = encryptContent(markdownBody);
    if (!payload) {
      return { ok: false, error: "Verschlüsselung fehlgeschlagen." };
    }

    frontmatterData.encIv = payload.encIv;
    frontmatterData.encTag = payload.encTag;
    frontmatterData.encData = payload.encData;
    markdownBody = "";
  }

  if (existingPage) {
    const snapshotResult = await snapshotCurrentPageFile({
      slug,
      actor: input.updatedBy,
      reason: "update",
      source: {
        updatedAt: existingPage.updatedAt,
        updatedBy: existingPage.updatedBy
      }
    });

    if (!snapshotResult.ok) {
      return {
        ok: false,
        error: snapshotResult.error ?? "Versionierung vor dem Speichern fehlgeschlagen."
      };
    }
  }

  const frontmatter = matter.stringify(markdownBody, frontmatterData);
  await writeTextFile(targetPath, frontmatter.endsWith("\n") ? frontmatter : `${frontmatter}\n`);

  const normalizedTarget = path.normalize(targetPath);
  for (const existingPath of existingPaths) {
    if (path.normalize(existingPath) === normalizedTarget) continue;
    await removeFile(existingPath);
  }

  lastWikiMutationAtMs = Date.now();
  pageRenderCache.delete(slug);
  suggestionIndexDirty = true;

  return { ok: true };
};

export const deletePage = async (
  slug: string,
  options?: { deletedBy?: string }
): Promise<{ ok: boolean; deleted: boolean; error?: string }> => {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!isValidSlug(normalizedSlug)) return { ok: false, deleted: false, error: "Ungültiger Slug." };

  const existingPage = await getPage(normalizedSlug);
  const pagePaths = await resolveAllPagePaths(normalizedSlug);
  if (pagePaths.length < 1) {
    return { ok: true, deleted: false };
  }

  const snapshotResult = await snapshotCurrentPageFile({
    slug: normalizedSlug,
    actor: options?.deletedBy ?? "unknown",
    reason: "delete",
    ...(existingPage
      ? {
          source: {
            updatedAt: existingPage.updatedAt,
            updatedBy: existingPage.updatedBy
          }
        }
      : {})
  });

  if (!snapshotResult.ok) {
    return {
      ok: false,
      deleted: false,
      error: snapshotResult.error ?? "Versionierung vor dem Löschen fehlgeschlagen."
    };
  }

  for (const pagePath of pagePaths) {
    await removeFile(pagePath);
  }
  lastWikiMutationAtMs = Date.now();
  pageRenderCache.delete(normalizedSlug);
  suggestionIndexDirty = true;
  return { ok: true, deleted: true };
};

export const searchPages = async (query: string, options?: { categoryId?: string }): Promise<WikiPageSummary[]> => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const persistedIndex = suggestionIndexDirty ? [] : await loadPersistedSuggestionIndex(options);
  if (persistedIndex.length > 0) {
    return persistedIndex
      .map((entry) => {
        let score = 0;
        if (entry.titleLower.startsWith(normalizedQuery)) {
          score += 12;
        } else if (entry.titleLower.includes(normalizedQuery)) {
          score += 8;
        }

        if (entry.tagsLower.some((tag) => tag.startsWith(normalizedQuery))) {
          score += 5;
        } else if (entry.tagsLower.some((tag) => tag.includes(normalizedQuery))) {
          score += 3;
        }

        if (entry.searchableText.includes(normalizedQuery)) {
          score += 2;
        }

        return {
          score,
          page: entry.summary
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || new Date(b.page.updatedAt).getTime() - new Date(a.page.updatedAt).getTime())
      .map((entry) => entry.page);
  }

  const pages = await listPages(options);

  const pageDetails = await Promise.all(
    pages.map(async (page) => {
      const full = await getPage(page.slug);
      return full ? { summary: page, full } : null;
    })
  );

  const hits = pageDetails
    .filter((entry): entry is { summary: WikiPageSummary; full: WikiPage } => entry !== null)
    .map((entry) => {
      const haystack = `${entry.summary.title}\n${entry.summary.excerpt}\n${entry.full.content}\n${entry.summary.tags.join(" ")}`.toLowerCase();
      const score = haystack.includes(normalizedQuery)
        ? (entry.summary.title.toLowerCase().includes(normalizedQuery) ? 4 : 2) +
          (entry.summary.tags.some((tag) => tag.includes(normalizedQuery)) ? 2 : 0)
        : 0;
      return { score, page: entry.summary };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.page.updatedAt).getTime() - new Date(a.page.updatedAt).getTime())
    .map((entry) => entry.page);

  return hits;
};

export const suggestPages = async (
  query: string,
  limit = 8,
  options?: { categoryId?: string }
): Promise<WikiPageSummary[]> => {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length < 2) {
    return [];
  }

  const safeLimit = Math.min(Math.max(limit, 1), 15);
  const persistedIndex = suggestionIndexDirty ? [] : await loadPersistedSuggestionIndex(options);
  const index = persistedIndex.length > 0 ? persistedIndex : await getSuggestionIndex(options);

  const scored = index
    .map((entry) => {
      let score = 0;

      if (entry.titleLower.startsWith(normalizedQuery)) {
        score += 9;
      } else if (entry.titleLower.includes(normalizedQuery)) {
        score += 6;
      }

      if (entry.tagsLower.some((tag) => tag.startsWith(normalizedQuery))) {
        score += 4;
      } else if (entry.tagsLower.some((tag) => tag.includes(normalizedQuery))) {
        score += 2;
      }

      if (entry.searchableText.includes(normalizedQuery)) {
        score += 1;
      }

      return { score, page: entry.summary };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.page.updatedAt).getTime() - new Date(a.page.updatedAt).getTime())
    .slice(0, safeLimit)
    .map((entry) => entry.page);

  return scored;
};

export const renderMarkdownPreview = (markdown: string): string => {
  const content = markdown.trim();
  if (!content) {
    return "<p class=\"muted-note\">Noch keine Vorschau verfügbar.</p>";
  }

  return renderMarkdownToHtmlWithAnchors(content).html;
};

export const listPageHistory = async (slugInput: string, limit = 100): Promise<PageVersionSummary[]> => {
  const slug = slugInput.trim().toLowerCase();
  if (!isValidSlug(slug)) return [];
  return listPageVersions(slug, limit);
};

export const getPageVersionRawContent = async (slugInput: string, versionId: string): Promise<string | null> => {
  const slug = slugInput.trim().toLowerCase();
  if (!isValidSlug(slug)) return null;
  const version = await getPageVersion(slug, versionId);
  return version?.fileContent ?? null;
};

export const restorePageVersion = async (input: {
  slug: string;
  versionId: string;
  restoredBy: string;
}): Promise<{ ok: boolean; error?: string }> => {
  const slug = input.slug.trim().toLowerCase();
  if (!isValidSlug(slug)) {
    return {
      ok: false,
      error: "Ungültiger Slug."
    };
  }

  const version = await getPageVersion(slug, input.versionId);
  if (!version) {
    return {
      ok: false,
      error: "Version nicht gefunden."
    };
  }

  const existingPage = await getPage(slug);
  const backupSnapshot = await snapshotCurrentPageFile({
    slug,
    actor: input.restoredBy,
    reason: "restore-backup",
    ...(existingPage
      ? {
          source: {
            updatedAt: existingPage.updatedAt,
            updatedBy: existingPage.updatedBy
          }
        }
      : {})
  });

  if (!backupSnapshot.ok) {
    return {
      ok: false,
      error: backupSnapshot.error ?? "Sicherung vor Restore fehlgeschlagen."
    };
  }

  const targetPath = resolvePagePath(slug);
  const existingPaths = await resolveAllPagePaths(slug);
  const raw = version.fileContent.endsWith("\n") ? version.fileContent : `${version.fileContent}\n`;

  await writeTextFile(targetPath, raw);

  const normalizedTarget = path.normalize(targetPath);
  for (const existingPath of existingPaths) {
    if (path.normalize(existingPath) === normalizedTarget) continue;
    await removeFile(existingPath);
  }

  lastWikiMutationAtMs = Date.now();
  pageRenderCache.delete(slug);
  suggestionIndexDirty = true;

  return { ok: true };
};

const isPageCreatedByUser = (page: Pick<WikiPage, "createdBy" | "updatedBy">, username: string): boolean => {
  const normalizedUser = username.trim().toLowerCase();
  if (!normalizedUser) return false;

  const createdBy = page.createdBy.trim().toLowerCase();
  const updatedBy = page.updatedBy.trim().toLowerCase();
  if (createdBy && createdBy !== "unknown") {
    return createdBy === normalizedUser;
  }

  return updatedBy === normalizedUser;
};

export interface UserArticleSummary {
  slug: string;
  title: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface UserArticleExportItem extends UserArticleSummary {
  storagePath: string;
  markdown: string;
}

export const listPagesCreatedByUser = async (username: string): Promise<UserArticleSummary[]> => {
  const pages = await listPages();
  const expanded = await Promise.all(
    pages.map(async (summary) => {
      return getPage(summary.slug);
    })
  );

  return expanded
    .filter((page): page is WikiPage => page !== null)
    .filter((page) => isPageCreatedByUser(page, username))
    .map((page) => ({
      slug: page.slug,
      title: page.title,
      tags: page.tags,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      updatedBy: page.updatedBy
    }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
};

export const exportPagesCreatedByUser = async (username: string): Promise<UserArticleExportItem[]> => {
  const pages = await listPages();
  const expanded = await Promise.all(
    pages.map(async (summary) => {
      return getPage(summary.slug);
    })
  );

  const authored = expanded
    .filter((page): page is WikiPage => page !== null)
    .filter((page) => isPageCreatedByUser(page, username));

  const result: UserArticleExportItem[] = [];
  for (const page of authored) {
    const storageAbsolutePath = (await resolveExistingPagePath(page.slug)) ?? resolvePagePath(page.slug);
    const storagePath = path.relative(config.rootDir, storageAbsolutePath).replace(/\\/g, "/");

    result.push({
      slug: page.slug,
      title: page.title,
      tags: page.tags,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      updatedBy: page.updatedBy,
      storagePath,
      markdown: page.content
    });
  }

  return result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
};

export const listKnownCategories = async (): Promise<Array<{ id: string; name: string }>> => {
  const categories = await listCategories();
  return categories.map((entry) => ({ id: entry.id, name: entry.name }));
};
