import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { marked, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";
import { config } from "../config.js";
import type { WikiHeading, WikiPage, WikiPageSummary } from "../types.js";
import { ensureDir, listFiles, readTextFile, removeFile, writeTextFile } from "./fileStore.js";

marked.use({
  gfm: true,
  breaks: true
});

const SLUG_PATTERN = /^[a-z0-9-]{1,80}$/;
const SUGGESTION_INDEX_MAX_AGE_MS = 20_000;

interface SuggestionIndexEntry {
  summary: WikiPageSummary;
  titleLower: string;
  tagsLower: string[];
  searchableText: string;
}

let suggestionIndex: SuggestionIndexEntry[] | null = null;
let suggestionIndexBuiltAt = 0;
let suggestionIndexDirty = true;

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

const resolvePagePath = (slug: string): string => path.join(config.wikiDir, `${slug}.md`);

const normalizeTags = (rawTags: unknown): string[] => {
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .map((tag) => String(tag).trim().toLowerCase())
    .filter((tag) => tag.length > 0)
    .slice(0, 20);
};

const parseMarkdownPage = async (slug: string): Promise<WikiPage | null> => {
  const source = await readTextFile(resolvePagePath(slug));
  if (!source) return null;

  const parsed = matter(source);
  const data = parsed.data as Record<string, unknown>;
  const title = String(data.title ?? slug).trim() || slug;
  const tags = normalizeTags(data.tags);
  const createdAt = String(data.createdAt ?? data.updatedAt ?? new Date().toISOString());
  const updatedAt = String(data.updatedAt ?? createdAt);
  const updatedBy = String(data.updatedBy ?? "unknown");
  const content = parsed.content.trim();
  const { html, tableOfContents } = renderMarkdownToHtmlWithAnchors(content);

  return {
    slug,
    title,
    tags,
    content,
    html,
    tableOfContents,
    createdAt,
    updatedAt,
    updatedBy
  };
};

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

export const listPages = async (): Promise<WikiPageSummary[]> => {
  await ensureDir(config.wikiDir);
  const files = await listFiles(config.wikiDir);
  const markdownFiles = files.filter((filePath) => filePath.endsWith(".md"));

  const pages = await Promise.all(
    markdownFiles.map(async (filePath) => {
      const slug = path.basename(filePath, ".md");
      const page = await parseMarkdownPage(slug);
      if (!page) return null;

      return {
        slug: page.slug,
        title: page.title,
        tags: page.tags,
        excerpt: cleanTextExcerpt(page.content).slice(0, 220),
        updatedAt: page.updatedAt
      } satisfies WikiPageSummary;
    })
  );

  return pages
    .filter((page): page is WikiPageSummary => page !== null)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
};

const buildSuggestionIndex = async (): Promise<SuggestionIndexEntry[]> => {
  const pages = await listPages();
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

const getSuggestionIndex = async (): Promise<SuggestionIndexEntry[]> => {
  const now = Date.now();
  const isExpired = now - suggestionIndexBuiltAt > SUGGESTION_INDEX_MAX_AGE_MS;
  if (!suggestionIndex || suggestionIndexDirty || isExpired) {
    suggestionIndex = await buildSuggestionIndex();
    suggestionIndexBuiltAt = now;
    suggestionIndexDirty = false;
  }

  return suggestionIndex;
};

export const getPage = async (slug: string): Promise<WikiPage | null> => {
  if (!isValidSlug(slug)) return null;
  return parseMarkdownPage(slug);
};

export interface SavePageInput {
  slug: string;
  title: string;
  tags: string[];
  content: string;
  updatedBy: string;
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
  const existingPage = await getPage(slug);

  const createdAt = existingPage?.createdAt ?? new Date().toISOString();
  const updatedAt = new Date().toISOString();
  const tags = input.tags
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0)
    .slice(0, 20);

  const frontmatter = matter.stringify(input.content.trim(), {
    title,
    tags,
    createdAt,
    updatedAt,
    updatedBy: input.updatedBy
  });

  await writeTextFile(resolvePagePath(slug), frontmatter.endsWith("\n") ? frontmatter : `${frontmatter}\n`);
  suggestionIndexDirty = true;

  return { ok: true };
};

export const deletePage = async (slug: string): Promise<boolean> => {
  if (!isValidSlug(slug)) return false;

  const pagePath = resolvePagePath(slug);
  try {
    await fs.access(pagePath);
  } catch {
    return false;
  }

  await removeFile(pagePath);
  suggestionIndexDirty = true;
  return true;
};

export const searchPages = async (query: string): Promise<WikiPageSummary[]> => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const pages = await listPages();

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

export const suggestPages = async (query: string, limit = 8): Promise<WikiPageSummary[]> => {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length < 2) {
    return [];
  }

  const safeLimit = Math.min(Math.max(limit, 1), 15);
  const index = await getSuggestionIndex();

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
