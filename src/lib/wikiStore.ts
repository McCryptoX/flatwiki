import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { config } from "../config.js";
import type { WikiPage, WikiPageSummary } from "../types.js";
import { ensureDir, listFiles, readTextFile, removeFile, writeTextFile } from "./fileStore.js";

marked.use({
  gfm: true,
  breaks: true
});

const SLUG_PATTERN = /^[a-z0-9-]{1,80}$/;

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
      "*": ["class"]
    },
    allowedSchemes: ["http", "https", "mailto"]
  });
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
  const rendered = marked.parse(content, { async: false });
  const html = toSafeHtml(typeof rendered === "string" ? rendered : "");

  return {
    slug,
    title,
    tags,
    content,
    html,
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
