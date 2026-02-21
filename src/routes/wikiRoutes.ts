import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { requireAdmin, requireAuth, requireAuthOrPublicRead, requireFormCsrfToken, verifySessionCsrfToken } from "../lib/auth.js";
import {
  buildAttachmentDownloadName,
  createAttachmentQuarantinePath,
  deleteAttachmentById,
  deleteAttachmentsForPage,
  finalizeAttachmentFromQuarantine,
  getAttachmentById,
  getAttachmentFilePath,
  listAttachmentsBySlug
} from "../lib/attachmentStore.js";
import { writeAuditLog } from "../lib/audit.js";
import { findCategoryById, getDefaultCategory, listCategories } from "../lib/categoryStore.js";
import { createPageComment, deleteCommentsForPage, deletePageComment, listPageComments } from "../lib/commentStore.js";
import { listGroupIdsForUser, listGroups } from "../lib/groupStore.js";
import { createNotification, deleteNotificationsForPage } from "../lib/notificationStore.js";
import { listTemplates } from "../lib/templateStore.js";
import { config } from "../config.js";
import { ensureDir, removeFile, safeResolve } from "../lib/fileStore.js";
import { cleanupUnusedUploads, extractUploadReferencesFromMarkdown } from "../lib/mediaStore.js";
import { listTrendingTopics, recordPageView } from "../lib/pageViewStore.js";
import { escapeHtml, formatDate, renderLayout, renderPageList } from "../lib/render.js";
import { getCommentModerationSettings, getUiMode, type UiMode } from "../lib/runtimeSettingsStore.js";
import { removeSearchIndexBySlug, upsertSearchIndexBySlug } from "../lib/searchIndexStore.js";
import { buildUnifiedDiff } from "../lib/textDiff.js";
import { findUserByUsername, listUsers } from "../lib/userStore.js";
import { deleteWatchesForPage, isUserWatchingPage, listWatchersForPage, unwatchPage, watchPage } from "../lib/watchStore.js";
import type { PublicUser, SecurityProfile, WikiPageSummary } from "../types.js";
import { getPageWorkflow, removeWorkflowForPage, setPageWorkflow, type WorkflowStatus } from "../lib/workflowStore.js";
import { parseSearchQuery } from "../lib/searchQuery.js";
import { sendMentionNotification, sendPageUpdateNotification } from "../lib/mailer.js";
import {
  canUserAccessPage,
  deletePage,
  filterAccessiblePageSummaries,
  getCurrentPageRawContent,
  getPage,
  getPageVersionRawContent,
  isValidSlug,
  normalizeArticleSlug,
  listPageBacklinks,
  listPageHistory,
  listPagesForUser,
  renderMarkdownPreview,
  restorePageVersion,
  savePage,
  searchPages,
  slugifyTitle,
  suggestPages
} from "../lib/wikiStore.js";

const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
};

const readSingle = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) {
    return String(value[0] ?? "");
  }
  return "";
};

const readMany = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
};

const serializeJsonForHtmlScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

const wantsJsonResponse = (request: { headers: Record<string, string | string[] | undefined> }): boolean => {
  const acceptHeader = request.headers.accept;
  const accepted = Array.isArray(acceptHeader) ? acceptHeader.join(",") : acceptHeader ?? "";
  const requestedWith = request.headers["x-requested-with"];
  const requestedWithValue = Array.isArray(requestedWith) ? requestedWith[0] ?? "" : requestedWith ?? "";
  return accepted.includes("application/json") || requestedWithValue.toLowerCase() === "xmlhttprequest";
};

const normalizeWeakEtag = (value: string): string => value.trim().replace(/^W\//i, "");

const ifNoneMatchMatches = (ifNoneMatchHeader: string | string[] | undefined, etag: string): boolean => {
  if (!ifNoneMatchHeader) return false;
  const value = Array.isArray(ifNoneMatchHeader) ? ifNoneMatchHeader.join(",") : ifNoneMatchHeader;
  const candidates = value.split(",").map((entry) => entry.trim());
  if (candidates.includes("*")) return true;
  const normalizedExpected = normalizeWeakEtag(etag);
  return candidates.some((entry) => normalizeWeakEtag(entry) === normalizedExpected);
};

const createStrongEtag = (value: string): string => `"${createHash("sha256").update(value, "utf8").digest("hex")}"`;

const buildGuestWikiPageEtag = (input: {
  slug: string;
  title: string;
  categoryName: string;
  securityProfile: SecurityProfile;
  visibility: "all" | "restricted";
  encrypted: boolean;
  sensitive: boolean;
  integrityState: string;
  updatedAt: string;
  updatedBy: string;
  html: string;
  tableOfContents: Array<{ id: string; text: string; depth: number }>;
  backlinks: Array<{ slug: string; title: string; categoryName: string; updatedAt: string }>;
  pageComments: Array<{
    id: string;
    authorDisplayName: string;
    authorUsername: string;
    createdAt: string;
    status: string;
    body: string;
  }>;
  currentCommentPage: number;
  totalCommentPages: number;
  notice: string;
  error: string;
}): string => {
  const payload = JSON.stringify({
    slug: input.slug,
    title: input.title,
    categoryName: input.categoryName,
    securityProfile: input.securityProfile,
    visibility: input.visibility,
    encrypted: input.encrypted,
    sensitive: input.sensitive,
    integrityState: input.integrityState,
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy,
    html: input.html,
    tableOfContents: input.tableOfContents.map((entry) => ({
      id: entry.id,
      text: entry.text,
      depth: entry.depth
    })),
    backlinks: input.backlinks.map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      categoryName: entry.categoryName,
      updatedAt: entry.updatedAt
    })),
    pageComments: input.pageComments.map((entry) => ({
      id: entry.id,
      authorDisplayName: entry.authorDisplayName,
      authorUsername: entry.authorUsername,
      createdAt: entry.createdAt,
      status: entry.status,
      body: entry.body
    })),
    currentCommentPage: input.currentCommentPage,
    totalCommentPages: input.totalCommentPages,
    notice: input.notice,
    error: input.error
  });

  return createStrongEtag(payload);
};

const COMMENT_PAGE_SIZE = 50;
const COMMENT_REPLY_MENTION_REGEX = /(^|[\s(>])@([a-z0-9._-]{3,32})\b/gi;

const buildEditConflictToken = (page: {
  slug: string;
  title: string;
  categoryId: string;
  securityProfile: SecurityProfile;
  visibility: "all" | "restricted";
  allowedUsers: string[];
  allowedGroups: string[];
  encrypted: boolean;
  tags: string[];
  content: string;
  updatedAt: string;
  updatedBy: string;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        slug: page.slug,
        title: page.title,
        categoryId: page.categoryId,
        securityProfile: page.securityProfile,
        visibility: page.visibility,
        allowedUsers: [...page.allowedUsers].sort(),
        allowedGroups: [...page.allowedGroups].sort(),
        encrypted: page.encrypted,
        tags: [...page.tags],
        content: page.content,
        updatedAt: page.updatedAt,
        updatedBy: page.updatedBy
      }),
      "utf8"
    )
    .digest("hex");

const injectReplyMentionLinks = (markdown: string, mentionableUsernames: Set<string>): string => {
  if (!markdown || mentionableUsernames.size < 1) return markdown;
  return markdown.replace(COMMENT_REPLY_MENTION_REGEX, (full, prefix: string, usernameRaw: string) => {
    const username = String(usernameRaw ?? "").trim().toLowerCase();
    if (!mentionableUsernames.has(username)) return full;
    return `${prefix}[@${username}](#reply-username-${username})`;
  });
};

const normalizeUsernames = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
};

const normalizeIds = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
};

const sortPagesByTitle = <T extends { title: string }>(pages: T[]): T[] =>
  pages.sort((a, b) => a.title.localeCompare(b.title, "de", { sensitivity: "base" }));

const sortPagesByUpdatedAtDesc = <T extends { updatedAt: string }>(pages: T[]): T[] =>
  pages.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

const groupPagesByInitial = (
  pages: Awaited<ReturnType<typeof listPagesForUser>>
): Array<{ key: string; pages: typeof pages }> => {
  const groups = new Map<string, typeof pages>();

  for (const page of pages) {
    const firstChar = page.title.trim().charAt(0).toUpperCase();
    const key = /^[0-9A-ZÄÖÜ]$/iu.test(firstChar) ? firstChar : "#";
    const bucket = groups.get(key) ?? [];
    bucket.push(page);
    groups.set(key, bucket);
  }

  const keys = [...groups.keys()].sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b, "de", { sensitivity: "base" });
  });

  return keys.map((key) => ({
    key,
    pages: sortPagesByTitle([...(groups.get(key) ?? [])])
  }));
};

const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif"
};

const ALLOWED_UPLOAD_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);

const escapeMarkdownText = (value: string): string => value.replace(/([\\`*_[\]])/g, "\\$1");

const normalizeUploadExtension = (filename: string | undefined, mimeType: string): string | null => {
  const fromName = path.extname(filename ?? "").replace(".", "").toLowerCase();
  if (fromName && ALLOWED_UPLOAD_EXTENSIONS.has(fromName)) {
    return fromName === "jpeg" ? "jpg" : fromName;
  }

  const fromMime = MIME_EXTENSION_MAP[mimeType];
  return fromMime ?? null;
};

const sanitizeAltText = (filename: string): string => {
  const base = path.parse(filename).name;
  const cleaned = base
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return cleaned || "Bild";
};

const renderArticleToc = (slug: string, headings: Array<{ id: string; text: string; depth: number }>): string => {
  if (headings.length < 2) {
    return "";
  }

  return `
    <aside class="article-toc" aria-label="Inhaltsverzeichnis">
      <h2>Inhaltsverzeichnis</h2>
      <ul>
        ${headings
          .map(
            (heading) => `
              <li class="depth-${Math.min(Math.max(heading.depth, 2), 6)}">
                <a href="/wiki/${encodeURIComponent(slug)}#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>
              </li>
            `
          )
          .join("")}
      </ul>
    </aside>
  `;
};

const renderCategoryFilter = (
  actionPath: string,
  categories: Array<{ id: string; name: string }>,
  selectedCategoryId: string,
  queryText?: string,
  activeTag?: string
): string => `
  <form method="get" action="${escapeHtml(actionPath)}" class="action-row">
    ${
      queryText !== undefined
        ? `<input type="search" name="q" value="${escapeHtml(queryText)}" placeholder="Suchbegriff" class="tiny" />`
        : ""
    }
    ${activeTag ? `<input type="hidden" name="tag" value="${escapeHtml(activeTag)}" />` : ""}
    <label class="sr-only" for="category-filter">Kategorie</label>
    <select id="category-filter" name="category" class="tiny">
      <option value="">Alle Kategorien</option>
      ${categories
        .map(
          (category) =>
            `<option value="${escapeHtml(category.id)}" ${category.id === selectedCategoryId ? "selected" : ""}>${escapeHtml(category.name)}</option>`
        )
        .join("")}
    </select>
    <button type="submit" class="tiny secondary">Filtern</button>
    <a class="button tiny ghost" href="${escapeHtml(actionPath)}">Zurücksetzen</a>
  </form>
`;

const parsePageNumber = (raw: string): number => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
};

const paginate = <T>(items: T[], requestedPage: number, pageSize: number): { page: number; totalPages: number; slice: T[] } => {
  const safePageSize = Math.max(1, Math.min(pageSize, 200));
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize));
  const page = Math.min(Math.max(requestedPage, 1), totalPages);
  const offset = (page - 1) * safePageSize;
  return {
    page,
    totalPages,
    slice: items.slice(offset, offset + safePageSize)
  };
};

const renderPager = (
  basePath: string,
  page: number,
  totalPages: number,
  extraParams?: Record<string, string>
): string => {
  if (totalPages <= 1) return "";

  const buildUrl = (targetPage: number): string => {
    const params = new URLSearchParams();
    params.set("page", String(targetPage));
    for (const [key, value] of Object.entries(extraParams ?? {})) {
      if (value.trim().length > 0) {
        params.set(key, value);
      }
    }
    return `${basePath}?${params.toString()}`;
  };

  return `
    <nav class="action-row" aria-label="Seitennavigation">
      <a class="button tiny secondary" href="${escapeHtml(buildUrl(Math.max(1, page - 1)))}" ${page <= 1 ? 'aria-disabled="true"' : ""}>Zurück</a>
      <span class="muted-note small">Seite ${page} von ${totalPages}</span>
      <a class="button tiny secondary" href="${escapeHtml(buildUrl(Math.min(totalPages, page + 1)))}" ${page >= totalPages ? 'aria-disabled="true"' : ""}>Weiter</a>
    </nav>
  `;
};

const formatBreadcrumbLabel = (segment: string): string => {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const plain = decoded.replace(/[-_]+/g, " ").trim();
  return plain.length > 0 ? plain : decoded;
};

const renderSlugBreadcrumbs = (slug: string): string => {
  const segments = slug
    .split("/")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (segments.length <= 1) return "";

  const categorySegments = segments.slice(0, -1);
  const links = categorySegments
    .map((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      return `<a href="/wiki/${encodeURIComponent(path)}">${escapeHtml(formatBreadcrumbLabel(segment))}</a>`;
    })
    .join('<span aria-hidden="true">›</span>');

  return `<nav class="article-breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">›</span>${links}</nav>`;
};

const formatHistoryReason = (reason: string): string => {
  if (reason === "delete") return "Löschen";
  if (reason === "restore-backup") return "Restore-Sicherung";
  return "Bearbeiten";
};

const renderDiffLineNumber = (value: number | undefined): string => {
  if (typeof value !== "number") return "";
  return String(value);
};

const renderHistoryDiff = (fromText: string, toText: string): { html: string; addedLines: number; removedLines: number; changed: boolean } => {
  const diff = buildUnifiedDiff(fromText, toText, { contextLines: 3 });

  const rows = diff.lines
    .map((line) => {
      if (line.type === "skip") {
        const oldCount = Math.max(0, line.hiddenOldLines ?? 0);
        const newCount = Math.max(0, line.hiddenNewLines ?? 0);
        return `
          <tr class="diff-row diff-skip">
            <td class="diff-line-no"></td>
            <td class="diff-line-no"></td>
            <td class="diff-line-content">… ${oldCount}/${newCount} unveränderte Zeilen ausgeblendet …</td>
          </tr>
        `;
      }

      const rowClass =
        line.type === "add"
          ? "diff-row diff-add"
          : line.type === "del"
            ? "diff-row diff-del"
            : "diff-row diff-context";

      return `
        <tr class="${rowClass}">
          <td class="diff-line-no">${renderDiffLineNumber(line.oldLineNumber)}</td>
          <td class="diff-line-no">${renderDiffLineNumber(line.newLineNumber)}</td>
          <td class="diff-line-content"><code>${escapeHtml(line.text ?? "")}</code></td>
        </tr>
      `;
    })
    .join("");

  return {
    html: `
      <div class="table-wrap history-diff-wrap">
        <table class="history-diff-table">
          <thead>
            <tr>
              <th>Alt</th>
              <th>Neu</th>
              <th>Inhalt</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `,
    addedLines: diff.addedLines,
    removedLines: diff.removedLines,
    changed: diff.changed
  };
};

const normalizeTagFilter = (value: string): string => {
  const normalized = value.trim().replace(/^#+/, "").toLowerCase();
  return normalized;
};

const normalizeSecurityProfileValue = (value: string | undefined): SecurityProfile => {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "sensitive") return "sensitive";
  if (normalized === "confidential") return "confidential";
  return "standard";
};

const formatSecurityProfileLabel = (value: SecurityProfile): string => {
  if (value === "confidential") return "Vertraulich";
  if (value === "sensitive") return "Sensibel";
  return "Standard";
};

const normalizeWorkflowStatusInput = (value: string): WorkflowStatus => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "in_review") return "in_review";
  return "draft";
};

const formatWorkflowStatusLabel = (status: WorkflowStatus): string => {
  if (status === "approved") return "Freigegeben";
  if (status === "in_review") return "In Review";
  return "Entwurf";
};

const formatMultilinePlainText = (value: string): string => escapeHtml(value).replace(/\n/g, "<br />");

const formatAttachmentFileSize = (sizeBytes: number): string => {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
};

const buildAccessUser = async (user: PublicUser): Promise<PublicUser> => {
  const groupIds = user.role === "admin" ? [] : await listGroupIdsForUser(user.username);
  return {
    ...user,
    groupIds
  };
};

const applySecurityProfileToSettings = (
  securityProfile: SecurityProfile,
  input: { visibility: "all" | "restricted"; encrypted: boolean; sensitive: boolean }
): { securityProfile: SecurityProfile; visibility: "all" | "restricted"; encrypted: boolean; sensitive: boolean } => {
  if (securityProfile === "sensitive" || securityProfile === "confidential") {
    return {
      securityProfile,
      visibility: "restricted",
      encrypted: true,
      sensitive: true
    };
  }

  return {
    securityProfile: "standard",
    visibility: input.sensitive ? "restricted" : input.visibility,
    encrypted: input.encrypted,
    sensitive: input.sensitive
  };
};

const resolveSecurityProfileForUiMode = (input: {
  requested: SecurityProfile;
  uiMode: UiMode;
  existing?: SecurityProfile;
}): SecurityProfile => {
  if (input.uiMode === "advanced") return input.requested;
  if (input.requested !== "sensitive") return input.requested;
  if (input.existing === "sensitive") return "sensitive";
  return "confidential";
};

const renderSearchResultList = (
  pages: WikiPageSummary[],
  searchContext: {
    query: string;
    activeTag: string;
    selectedCategoryId: string;
    selectedAuthor: string;
    selectedTimeframe: string;
    selectedScope: string;
    hasAnyFilter: boolean;
  }
): string => {
  if (pages.length < 1) {
    if (searchContext.hasAnyFilter) {
      return '<p class="empty">Keine Treffer mit den aktiven Filtern. Filter anpassen oder zurücksetzen.</p>';
    }
    if (searchContext.query.trim().length > 0) {
      return '<p class="empty">Keine Treffer gefunden. Bitte Suchbegriff ändern.</p>';
    }
    return '<p class="empty">Bitte Suchbegriff eingeben oder einen Filter setzen.</p>';
  }

  const queryParamsForTag = new URLSearchParams();
  if (searchContext.query) queryParamsForTag.set("q", searchContext.query);
  if (searchContext.selectedCategoryId) queryParamsForTag.set("category", searchContext.selectedCategoryId);
  if (searchContext.selectedAuthor) queryParamsForTag.set("author", searchContext.selectedAuthor);
  if (searchContext.selectedTimeframe) queryParamsForTag.set("timeframe", searchContext.selectedTimeframe);
  if (searchContext.selectedScope) queryParamsForTag.set("scope", searchContext.selectedScope);

  return `
    <section class="search-results-list">
      ${pages
        .map((page) => {
          const metaBits = [
            formatDate(page.updatedAt),
            page.categoryName,
            page.updatedBy && page.updatedBy !== "unknown" ? `Autor: ${page.updatedBy}` : "",
            page.visibility === "restricted" ? "Eingeschränkter Zugriff" : "Öffentlich im Team",
            page.encrypted ? "Verschlüsselt" : ""
          ].filter((entry) => entry.length > 0);

          const tags = page.tags
            .slice(0, 8)
            .map((tag) => {
              const params = new URLSearchParams(queryParamsForTag);
              params.set("tag", tag);
              return `<a class="tag-chip" href="/search?${params.toString()}">#${escapeHtml(tag)}</a>`;
            })
            .join("");

          return `
            <article class="search-hit-card">
              <h3><a href="/wiki/${encodeURIComponent(page.slug)}">${escapeHtml(page.title)}</a></h3>
              <p class="card-excerpt">${escapeHtml(page.excerpt || "Keine Vorschau verfügbar.")}</p>
              <p class="search-hit-meta">${escapeHtml(metaBits.join(" • "))}</p>
              ${tags ? `<div class="card-tags">${tags}</div>` : ""}
            </article>
          `;
        })
        .join("")}
    </section>
  `;
};

const renderRecentPages = (pages: WikiPageSummary[]): string => {
  if (pages.length < 1) {
    return '<p class="empty">Keine Änderungen in den letzten 7 Tagen.</p>';
  }

  return `
    <ul class="dashboard-recent-list">
      ${pages
        .map((page) => {
          const updatedBy = page.updatedBy && page.updatedBy !== "unknown" ? `von ${page.updatedBy}` : "";
          const metaBits = [page.categoryName, formatDate(page.updatedAt), updatedBy].filter((entry) => entry.length > 0);
          return `
            <li>
              <a href="/wiki/${encodeURIComponent(page.slug)}">${escapeHtml(page.title)}</a>
              <span>${escapeHtml(metaBits.join(" • "))}</span>
            </li>
          `;
        })
        .join("")}
    </ul>
  `;
};

const renderTrendingTopics = (
  topics: Array<{ slug: string; title: string; categoryName: string; views: number; lastViewedAt: string }>
): string => {
  if (topics.length < 1) {
    return '<p class="empty">Noch keine Trends in den letzten 30 Tagen.</p>';
  }

  return `
    <ol class="dashboard-trending-list">
      ${topics
        .map(
          (topic, index) => `
            <li>
              <span class="dashboard-trending-rank">${index + 1}</span>
              <a href="/wiki/${encodeURIComponent(topic.slug)}">${escapeHtml(topic.title)}</a>
              <span class="dashboard-trending-count">${topic.views} Aufrufe</span>
              <span class="dashboard-trending-meta">${escapeHtml(topic.categoryName)} • zuletzt ${escapeHtml(
                formatDate(topic.lastViewedAt)
              )}</span>
            </li>
          `
        )
        .join("")}
    </ol>
  `;
};

const renderEditorForm = (params: {
  mode: "new" | "edit";
  action: string;
  slug: string;
  slugAuto?: boolean;
  title: string;
  tags: string;
  content: string;
  csrfToken: string;
  slugLocked?: boolean;
  categories: Array<{ id: string; name: string }>;
  selectedCategoryId: string;
  securityProfile: SecurityProfile;
  visibility: "all" | "restricted";
  allowedUsers: string[];
  allowedGroups: string[];
  availableUsers: Array<{ username: string; displayName: string }>;
  availableGroups: Array<{ id: string; name: string; description: string }>;
  pageTemplates: Array<{
    id: string;
    name: string;
    description: string;
    defaultTitle: string;
    defaultTags: string[];
    defaultContent: string;
    sensitivity: "normal" | "sensitive";
  }>;
  selectedTemplateId?: string;
  encrypted: boolean;
  encryptionAvailable: boolean;
  uiMode: UiMode;
  showSensitiveProfileOption: boolean;
  lastKnownUpdatedAt?: string | undefined;
  lastKnownConflictToken?: string | undefined;
}): string => `
  <section class="content-wrap editor-shell" data-preview-endpoint="/api/markdown/preview" data-csrf="${escapeHtml(
    params.csrfToken
  )}" data-page-slug="${escapeHtml(params.slug)}" data-editor-mode="${params.mode}" data-security-profile="${escapeHtml(
    params.securityProfile
  )}" data-ui-mode="${escapeHtml(params.uiMode)}" data-initial-template-id="${escapeHtml(params.selectedTemplateId ?? "")}">
    <h1>${params.mode === "new" ? "Neue Seite" : "Seite bearbeiten"}</h1>
    <div class="editor-grid">
      <form method="post" action="${escapeHtml(params.action)}" class="stack large">
        <input type="hidden" name="_csrf" value="${escapeHtml(params.csrfToken)}" />
        <input type="hidden" name="securityProfile" value="${escapeHtml(params.securityProfile)}" data-security-profile-input />
        ${params.lastKnownUpdatedAt ? `<input type="hidden" name="lastKnownUpdatedAt" value="${escapeHtml(params.lastKnownUpdatedAt)}" />` : ""}
        ${params.lastKnownConflictToken ? `<input type="hidden" name="lastKnownConflictToken" value="${escapeHtml(params.lastKnownConflictToken)}" />` : ""}
        ${
          params.mode === "new"
            ? `
              <section class="new-page-wizard stack" data-new-page-wizard data-encryption-available="${params.encryptionAvailable ? "1" : "0"}">
                <h2>Schnell-Assistent</h2>
                <p class="muted-note">In 3 Schritten zur neuen Seite: Inhaltstyp, Zugriff und Speichern.</p>
                <ol class="wizard-steps">
                  <li class="wizard-step" data-wizard-step="1">1. Inhaltstyp</li>
                  <li class="wizard-step" data-wizard-step="2">2. Zugriff</li>
                  <li class="wizard-step" data-wizard-step="3">3. Speichern</li>
                </ol>

                <div class="wizard-panel">
                  <label class="wizard-heading">Inhaltstyp auswählen</label>
                  <div class="wizard-template-grid">
                    ${
                      params.pageTemplates.length > 0
                        ? params.pageTemplates
                            .map(
                              (template) =>
                                `<button type="button" class="button secondary tiny wizard-template" data-template-id="${escapeHtml(
                                  template.id
                                )}" title="${escapeHtml(template.description || template.name)}">${escapeHtml(template.name)}</button>`
                            )
                            .join("")
                        : '<button type="button" class="button secondary tiny wizard-template" data-template-id="blank">Leer starten</button>'
                    }
                  </div>
                </div>

                <div class="wizard-panel">
                  <label class="wizard-heading">Sicherheitsprofil</label>
                  <div class="wizard-sensitivity-row" data-security-profile-picker>
                    <button type="button" class="button secondary tiny wizard-sensitivity" data-security-profile="standard">Standard</button>
                    ${
                      params.showSensitiveProfileOption
                        ? `<button type="button" class="button secondary tiny wizard-sensitivity" data-security-profile="sensitive" ${
                            params.encryptionAvailable ? "" : "disabled"
                          }>Sensibel</button>`
                        : ""
                    }
                    <button type="button" class="button secondary tiny wizard-sensitivity" data-security-profile="confidential" ${
                      params.encryptionAvailable ? "" : "disabled"
                    }>Vertraulich</button>
                  </div>
                  <p class="muted-note small" data-security-profile-note>
                    ${
                      params.showSensitiveProfileOption
                        ? "Standard: frei. Sensibel: eingeschränkt + verschlüsselt. Vertraulich: zusätzlich ohne Tags und ohne Live-Vorschläge."
                        : "Standard: frei. Vertraulich: eingeschränkt + verschlüsselt, ohne Tags und ohne Live-Vorschläge."
                    }
                  </p>
                </div>

                <div class="wizard-panel">
                  <label class="wizard-heading">Zugriff
                    <select data-wizard-visibility>
                      <option value="all" ${params.visibility === "all" ? "selected" : ""}>Alle angemeldeten Benutzer</option>
                      <option value="restricted" ${params.visibility === "restricted" ? "selected" : ""}>Nur ausgewählte Benutzer</option>
                    </select>
                  </label>
                  <p class="muted-note small">Bei eingeschränktem Zugriff wähle unten Benutzer oder Gruppen aus.</p>
                </div>

                <div class="wizard-panel">
                  <label class="wizard-heading">Speichern</label>
                  <p class="muted-note small">Titel und Inhalt prüfen, dann unten <strong>Seite erstellen</strong> klicken.</p>
                </div>
              </section>
              <script type="application/json" data-template-presets>${serializeJsonForHtmlScript(
                params.pageTemplates.map((template) => ({
                  id: template.id,
                  name: template.name,
                  description: template.description,
                  defaultTitle: template.defaultTitle,
                  defaultTags: template.defaultTags,
                  defaultContent: template.defaultContent,
                  securityProfile:
                    template.sensitivity === "sensitive"
                      ? params.showSensitiveProfileOption
                        ? "sensitive"
                        : "confidential"
                      : "standard"
                }))
              )}</script>
            `
            : ""
        }
        <label>Titel
          <input type="text" name="title" value="${escapeHtml(params.title)}" required minlength="2" maxlength="120" data-title-input />
        </label>
        ${
          params.mode === "edit"
            ? `
              <label>Sicherheitsprofil
                <div class="wizard-sensitivity-row" data-security-profile-picker>
                  <button type="button" class="button secondary tiny wizard-sensitivity" data-security-profile="standard">Standard</button>
                  ${
                    params.showSensitiveProfileOption
                      ? `<button type="button" class="button secondary tiny wizard-sensitivity" data-security-profile="sensitive" ${
                          params.encryptionAvailable ? "" : "disabled"
                        }>Sensibel</button>`
                      : ""
                  }
                  <button type="button" class="button secondary tiny wizard-sensitivity" data-security-profile="confidential" ${
                    params.encryptionAvailable ? "" : "disabled"
                  }>Vertraulich</button>
                </div>
              </label>
              <p class="muted-note small" data-security-profile-note>${
                params.showSensitiveProfileOption
                  ? "Standard: frei. Sensibel: eingeschränkt + verschlüsselt. Vertraulich: zusätzlich ohne Tags und ohne Live-Vorschläge."
                  : "Standard: frei. Vertraulich: eingeschränkt + verschlüsselt, ohne Tags und ohne Live-Vorschläge."
              }</p>
            `
            : ""
        }
        ${
          params.encryptionAvailable
            ? ""
            : '<p class="muted-note small">Hinweis: Sensibel/Vertraulich ist nur mit <code>CONTENT_ENCRYPTION_KEY</code> verfügbar.</p>'
        }
        <label class="${params.mode === "new" ? "sr-only" : ""}">Zugriff
          <select name="visibility" data-visibility-input>
            <option value="all" ${params.visibility === "all" ? "selected" : ""}>Alle angemeldeten Benutzer</option>
            <option value="restricted" ${params.visibility === "restricted" ? "selected" : ""}>Nur ausgewählte Benutzer</option>
          </select>
        </label>
        <fieldset class="stack access-user-picker" data-restricted-only ${params.visibility === "restricted" ? "" : "hidden"}>
          <legend>Freigegebene Benutzer (bei eingeschränktem Zugriff)</legend>
          <div class="picker-toolbar">
            <input
              type="search"
              class="tiny"
              placeholder="Benutzer filtern (Name oder Username)"
              data-picker-filter
              autocomplete="off"
            />
            <span class="muted-note small" data-picker-count></span>
          </div>
          <div class="stack allowed-users-list" data-picker-list>
            ${
              params.availableUsers.length > 0
                ? params.availableUsers
                    .map((user) => {
                      const checked = params.allowedUsers.includes(user.username) ? "checked" : "";
                      const searchData = `${user.displayName} ${user.username}`;
                      return `<label class="checkline user-checkline" data-search="${escapeHtml(searchData.toLowerCase())}"><input type="checkbox" name="allowedUsers" value="${escapeHtml(user.username)}" ${checked} /> <span>${escapeHtml(user.displayName)} (${escapeHtml(user.username)})</span></label>`;
                    })
                    .join("")
                : '<p class="muted-note">Keine Benutzer verfügbar.</p>'
            }
          </div>
        </fieldset>
        <fieldset class="stack access-user-picker" data-restricted-only ${params.visibility === "restricted" ? "" : "hidden"}>
          <legend>Freigegebene Gruppen (optional)</legend>
          <div class="picker-toolbar">
            <input type="search" class="tiny" placeholder="Gruppen filtern" data-picker-filter autocomplete="off" />
            <span class="muted-note small" data-picker-count></span>
          </div>
          <div class="stack allowed-users-list" data-picker-list>
            ${
              params.availableGroups.length > 0
                ? params.availableGroups
                    .map((group) => {
                      const checked = params.allowedGroups.includes(group.id) ? "checked" : "";
                      const searchData = `${group.name} ${group.description}`;
                      const description = group.description
                        ? `<span class="muted-note small">${escapeHtml(group.description)}</span>`
                        : "";
                      return `<label class="checkline user-checkline" data-search="${escapeHtml(searchData.toLowerCase())}"><input type="checkbox" name="allowedGroups" value="${escapeHtml(group.id)}" ${checked} /> <span>${escapeHtml(group.name)} ${description}</span></label>`;
                    })
                    .join("")
                : '<p class="muted-note">Keine Gruppen vorhanden.</p>'
            }
          </div>
        </fieldset>
        <details class="advanced-options" ${params.mode === "edit" ? "open" : ""}>
          <summary>Mehr Optionen</summary>
          <div class="stack">
            <label>Seitenadresse (URL)
              <input
                type="text"
                name="slug"
                value="${escapeHtml(params.slug)}"
                ${params.slugLocked ? "readonly" : ""}
                pattern="[a-z0-9-]{1,80}"
                placeholder="Wird automatisch aus dem Titel erstellt"
                data-slug-input
                data-slug-auto="${params.slugAuto === false ? "0" : "1"}"
              />
              <span class="muted-note small">Kannst du leer lassen. FlatWiki erzeugt die Seitenadresse automatisch.</span>
            </label>
            <label>Kategorie
              <select name="categoryId" required data-category-input>
                ${params.categories
                  .map(
                    (category) =>
                      `<option value="${escapeHtml(category.id)}" ${category.id === params.selectedCategoryId ? "selected" : ""}>${escapeHtml(
                        category.name
                      )}</option>`
                  )
                  .join("")}
              </select>
            </label>
            <label>Tags (kommagetrennt)
              <input type="text" name="tags" value="${escapeHtml(params.tags)}" data-tags-input />
              <span class="muted-note small" data-tags-note hidden>Bei Vertraulich werden Tags aus Datenschutzgründen nicht gespeichert.</span>
            </label>
            <label class="checkline standalone-checkline">
              <input type="checkbox" name="encrypted" value="1" data-encrypted-toggle ${params.encrypted ? "checked" : ""} ${
                params.encryptionAvailable ? "" : "disabled"
              } />
              <span>Inhalt im Dateisystem verschlüsseln (AES-256)</span>
            </label>
            ${
              params.encryptionAvailable
                ? '<p class="muted-note small">Bei Sensibel/Vertraulich wird Verschlüsselung automatisch erzwungen.</p>'
                : '<p class="muted-note small">Verschlüsselung ist derzeit nicht aktiv. Setze CONTENT_ENCRYPTION_KEY in config.env.</p>'
            }
          </div>
        </details>
        <label>Inhalt (Markdown)</label>
        <div class="editor-mode-row">
          <div class="editor-toggle-group" role="tablist" aria-label="Editor-Ansicht">
            <button type="button" class="tiny secondary is-active" data-editor-view-btn="write">Editor</button>
            <button type="button" class="tiny secondary" data-editor-view-btn="preview">Vorschau</button>
          </div>
          <span class="muted-note small">Toolbar fügt Markdown direkt ein.</span>
        </div>
        <div class="editor-toolbar" role="toolbar" aria-label="Markdown-Werkzeuge">
          <button type="button" class="tiny secondary" data-md-action="h2">H2</button>
          <button type="button" class="tiny secondary" data-md-action="h3">H3</button>
          <button type="button" class="tiny secondary" data-md-action="bold"><strong>B</strong></button>
          <button type="button" class="tiny secondary" data-md-action="italic"><em>I</em></button>
          <button type="button" class="tiny secondary" data-md-action="quote">Zitat</button>
          <button type="button" class="tiny secondary" data-md-action="ul">Liste</button>
          <button type="button" class="tiny secondary" data-md-action="ol">1.</button>
          <button type="button" class="tiny secondary" data-md-action="code">Code</button>
          <button type="button" class="tiny secondary" data-md-action="link">Link</button>
          <button type="button" class="tiny secondary" data-md-action="table">Tabelle</button>
        </div>
        <textarea name="content" rows="18" required data-editor-textarea>${escapeHtml(params.content)}</textarea>
        <section class="editor-preview" hidden aria-live="polite">
          <p class="muted-note">Live-Vorschau wird geladen...</p>
        </section>
        <button type="submit">${params.mode === "new" ? "Seite erstellen" : "Änderungen speichern"}</button>
      </form>

      <aside class="upload-panel">
        <h2>Bilder einfügen</h2>
        <p class="muted-note">Du kannst 1-x Bilder hochladen. Dateien werden automatisch sicher umbenannt.</p>
        ${
          params.encrypted
            ? '<p class="muted-note small">Bei verschlüsselten Artikeln ist Bild-Upload deaktiviert, damit keine Klartext-Dateien neben verschlüsseltem Inhalt entstehen.</p>'
            : ""
        }
        <form method="post" enctype="multipart/form-data" class="stack image-upload-form" data-upload-endpoint="/api/uploads" data-csrf="${escapeHtml(
          params.csrfToken
        )}" data-upload-hard-disabled="${params.mode === "edit" && params.encrypted ? "1" : "0"}">
          <label>Bilder auswählen
            <input type="file" name="images" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple required ${
              params.encrypted ? "disabled" : ""
            } />
          </label>
          <button type="submit" class="secondary" ${params.encrypted ? "disabled" : ""}>Bilder hochladen</button>
        </form>
        <p class="muted-note small">Nach dem Upload werden Markdown-Zeilen automatisch in den Inhalt eingefügt.</p>
        <textarea class="upload-markdown-output" rows="6" readonly placeholder="Upload-Ausgabe erscheint hier"></textarea>
      </aside>
    </div>
  </section>
`;

const buildEditorRedirectQuery = (params: {
  error: string;
  title: string;
  slug?: string;
  tags: string;
  content: string;
  categoryId: string;
  securityProfile: SecurityProfile;
  visibility: "all" | "restricted";
  allowedUsers: string[];
  allowedGroups: string[];
  encrypted: boolean;
}): string => {
  const query = new URLSearchParams();
  query.set("error", params.error);
  query.set("title", params.title);
  if (params.slug !== undefined) {
    query.set("slug", params.slug);
  }
  query.set("tags", params.tags);
  query.set("content", params.content);
  query.set("categoryId", params.categoryId);
  query.set("securityProfile", params.securityProfile);
  query.set("visibility", params.visibility);
  query.set("allowedUsers", params.allowedUsers.join(","));
  query.set("allowedGroups", params.allowedGroups.join(","));
  query.set("encrypted", params.encrypted ? "1" : "0");
  return query.toString();
};

const notifyWatchersForPageEvent = async (input: {
  slug: string;
  title: string;
  page: Awaited<ReturnType<typeof getPage>>;
  actorId?: string;
  actorUsername?: string;
  event: "page_update" | "comment" | "workflow";
  eventTitle: string;
  eventBody: string;
  url: string;
}): Promise<number> => {
  if (!input.page) return 0;

  const watcherUserIds = await listWatchersForPage(input.slug);
  if (watcherUserIds.length < 1) return 0;

  const users = (await listUsers()).filter((entry) => !entry.disabled);
  const userById = new Map(users.map((entry) => [entry.id, entry] as const));
  let created = 0;

  for (const userId of watcherUserIds) {
    if (userId === input.actorId) continue;
    const watcher = userById.get(userId);
    if (!watcher) continue;
    const accessUser = await buildAccessUser(watcher);
    if (!canUserAccessPage(input.page, accessUser)) continue;

    const result = await createNotification({
      userId: watcher.id,
      type: input.event,
      title: input.eventTitle,
      body: input.eventBody,
      url: input.url,
      sourceSlug: input.slug,
      actorId: input.actorId ?? "",
      dedupeKey: `${input.event}:${input.slug}:${watcher.id}:${Date.now()}`
    });

    if (result.ok && result.created) {
      created += 1;
      // E-Mail-Benachrichtigung (fire-and-forget, kein SMTP = silent skip)
      if (watcher.email) {
        const actorDisplayName = input.actorUsername ?? "Jemand";
        sendPageUpdateNotification({
          toEmail: watcher.email,
          toDisplayName: watcher.displayName,
          pageTitle: input.title,
          pageSlug: input.slug,
          actorDisplayName,
          eventType: input.event
        }).catch(() => {/* Mail-Fehler nie nach oben propagieren */});
      }
    }
  }

  return created;
};

const notifyMentionedUsersForComment = async (input: {
  page: Awaited<ReturnType<typeof getPage>>;
  commentId: string;
  mentionUsernames: string[];
  actorId: string;
  actorDisplayName: string;
}): Promise<number> => {
  if (!input.page || input.mentionUsernames.length < 1) return 0;

  let created = 0;
  for (const username of input.mentionUsernames) {
    const user = await findUserByUsername(username);
    if (!user || user.disabled) continue;
    if (user.id === input.actorId) continue;

    const accessUser = await buildAccessUser(user);
    if (!canUserAccessPage(input.page, accessUser)) continue;

    const result = await createNotification({
      userId: user.id,
      type: "mention",
      title: `${input.actorDisplayName} hat dich erwähnt`,
      body: `in ${input.page.title}`,
      url: `/wiki/${encodeURIComponent(input.page.slug)}#comment-${encodeURIComponent(input.commentId)}`,
      sourceSlug: input.page.slug,
      actorId: input.actorId,
      dedupeKey: `mention:${input.page.slug}:${input.commentId}:${user.id}`
    });

    if (result.ok && result.created) {
      created += 1;
      // E-Mail-Benachrichtigung bei Erwähnung (fire-and-forget)
      if (user.email) {
        sendMentionNotification({
          toEmail: user.email,
          toDisplayName: user.displayName,
          pageTitle: input.page.title,
          pageSlug: input.page.slug,
          commentId: input.commentId,
          actorDisplayName: input.actorDisplayName
        }).catch(() => {/* Mail-Fehler nie nach oben propagieren */});
      }
    }
  }

  return created;
};

export const registerWikiRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
    const query = asObject(request.query);
    const searchQuery = readSingle(query.q);
    const selectedCategoryId = readSingle(query.category);
    const activeTag = normalizeTagFilter(readSingle(query.tag));
    const selectedTimeframe = readSingle(query.timeframe).trim().toLowerCase();
    const selectedScope = readSingle(query.scope).trim().toLowerCase() || "all";
    const pages = await listPagesForUser(request.currentUser);
    const categories = await listCategories();
    const nowMs = Date.now();
    const recentCutoffMs = nowMs - 7 * 24 * 60 * 60 * 1000;
    const recentPages = sortPagesByUpdatedAtDesc([...pages])
      .filter((page) => {
        const updatedAtMs = Date.parse(page.updatedAt);
        return Number.isFinite(updatedAtMs) && updatedAtMs >= recentCutoffMs;
      })
      .slice(0, 6);
    const trendingRaw = await listTrendingTopics({ days: 30, limit: 6 });
    const pageBySlug = new Map(pages.map((page) => [page.slug, page] as const));
    const trendingTopics = trendingRaw
      .map((entry) => {
        const page = pageBySlug.get(entry.slug);
        if (!page) return null;
        return {
          slug: page.slug,
          title: page.title,
          categoryName: page.categoryName,
          views: entry.views,
          lastViewedAt: entry.lastViewedAt
        };
      })
      .filter(
        (entry): entry is { slug: string; title: string; categoryName: string; views: number; lastViewedAt: string } => entry !== null
      );

    const canWrite = Boolean(request.currentUser);
    const body = `
      <section class="dashboard-shell stack large">
        <section class="dashboard-hero">
          <h1>Finde Wissen in Sekunden</h1>
          <p>Durchsuche Inhalte direkt. Über das Plus kannst du die Filter aufklappen.</p>
          <form method="get" action="/search" class="dashboard-search-stack" data-home-search>
            <div class="dashboard-search-form dashboard-search-form-google">
              <button
                type="button"
                class="dashboard-search-plus"
                data-home-search-toggle
                aria-controls="home-search-advanced"
                aria-expanded="false"
                aria-label="Erweiterte Suche aufklappen"
              >+</button>
              <div class="search-box dashboard-search-box" data-search-suggest>
                <label class="sr-only" for="dashboard-main-search">Wiki durchsuchen</label>
                <input
                  id="dashboard-main-search"
                  type="search"
                  name="q"
                  value="${escapeHtml(searchQuery)}"
                  placeholder="Suche in Artikeln, Tags, Kategorien ..."
                  autocomplete="off"
                />
                <div class="search-suggest" hidden></div>
              </div>
              <button type="submit" class="dashboard-search-go">Suche</button>
            </div>
            <div class="dashboard-search-preview" data-home-search-preview aria-live="polite">
              <span class="muted-note small">Keine zusätzlichen Filter aktiv.</span>
            </div>
            <section id="home-search-advanced" class="dashboard-search-advanced" data-home-search-panel hidden>
              <div class="dashboard-search-advanced-grid">
                <label class="dashboard-advanced-field">Kategorie
                  <select name="category">
                    <option value="">Alle Kategorien</option>
                    ${categories
                      .map(
                        (category) =>
                          `<option value="${escapeHtml(category.id)}" ${category.id === selectedCategoryId ? "selected" : ""}>${escapeHtml(
                            category.name
                          )}</option>`
                      )
                      .join("")}
                  </select>
                </label>
                <label class="dashboard-advanced-field">Tag
                  <input type="text" name="tag" value="${escapeHtml(activeTag)}" placeholder="z. B. howto" />
                </label>
                <label class="dashboard-advanced-field">Zeitraum
                  <select name="timeframe">
                    <option value="">Beliebig</option>
                    <option value="24h" ${selectedTimeframe === "24h" ? "selected" : ""}>Letzte 24 Stunden</option>
                    <option value="7d" ${selectedTimeframe === "7d" ? "selected" : ""}>Letzte 7 Tage</option>
                    <option value="30d" ${selectedTimeframe === "30d" ? "selected" : ""}>Letzte 30 Tage</option>
                    <option value="365d" ${selectedTimeframe === "365d" ? "selected" : ""}>Letzte 12 Monate</option>
                  </select>
                </label>
                <label class="dashboard-advanced-field">Bereich
                  <select name="scope">
                    <option value="all" ${selectedScope === "all" ? "selected" : ""}>Alle</option>
                    <option value="public" ${selectedScope === "public" ? "selected" : ""}>Öffentlich</option>
                    <option value="restricted" ${selectedScope === "restricted" ? "selected" : ""}>Eingeschränkt</option>
                    <option value="encrypted" ${selectedScope === "encrypted" ? "selected" : ""}>Verschlüsselt</option>
                    <option value="unencrypted" ${selectedScope === "unencrypted" ? "selected" : ""}>Unverschlüsselt</option>
                  </select>
                </label>
              </div>
            </section>
          </form>
          <div class="dashboard-hero-links">
            <a href="/search">Erweiterte Suche</a>
            <a href="/toc">Inhaltsverzeichnis</a>
            ${canWrite ? '<a href="/new">Neue Seite</a>' : '<a href="/login">Anmelden</a>'}
          </div>
        </section>

        <section class="dashboard-panels-grid">
          <section class="content-wrap dashboard-recent-panel">
            <details class="dashboard-recent-disclosure" open>
              <summary>Letzte Änderungen (7 Tage)</summary>
              ${renderRecentPages(recentPages)}
            </details>
          </section>
          <section class="content-wrap dashboard-trending-panel">
            <h2>Trending-Themen</h2>
            <p class="muted-note small">Meistgelesen in den letzten 30 Tagen.</p>
            ${renderTrendingTopics(trendingTopics)}
          </section>
        </section>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Wiki",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: readSingle(query.notice),
        error: readSingle(query.error),
        hideHeaderSearch: true,
        scripts: ["/home-search.js?v=5"]
      })
    );
  });

  app.get("/toc", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
    const query = asObject(request.query);
    const selectedCategoryId = readSingle(query.category);
    const categoryFilter = selectedCategoryId ? { categoryId: selectedCategoryId } : undefined;
    const pages = await listPagesForUser(request.currentUser, categoryFilter);
    const pagesByTitle = sortPagesByTitle([...pages]);
    const pageNumber = parsePageNumber(readSingle(query.page));
    const paged = paginate(pagesByTitle, pageNumber, 90);
    const groupedPages = groupPagesByInitial(paged.slice);
    const categories = await listCategories();

    const canWrite = Boolean(request.currentUser);
    const body = `
      <section class="content-wrap toc-shell">
        <div class="page-header">
          <div>
            <h1>Inhaltsverzeichnis</h1>
            <p>${pages.length} Einträge im Wiki</p>
            ${renderCategoryFilter("/toc", categories, selectedCategoryId)}
            ${renderPager("/toc", paged.page, paged.totalPages, {
              category: selectedCategoryId
            })}
          </div>
          ${canWrite ? '<a class="button" href="/new">Neue Seite</a>' : ""}
        </div>
        <nav class="toc-index" aria-label="Alphabetischer Index">
          ${groupedPages.map((group) => `<a href="#toc-${escapeHtml(group.key)}">${escapeHtml(group.key)}</a>`).join("")}
        </nav>
        <section class="toc-group-grid">
          ${groupedPages
            .map(
              (group) => `
                <article class="toc-group" id="toc-${escapeHtml(group.key)}">
                  <h2>${escapeHtml(group.key)} <span>(${group.pages.length})</span></h2>
                  <ul class="toc-list">
                    ${group.pages
                      .map(
                        (page) => `
                          <li>
                            <a href="/wiki/${encodeURIComponent(page.slug)}">${escapeHtml(page.title)}</a>
                            <time datetime="${escapeHtml(page.updatedAt)}">${escapeHtml(formatDate(page.updatedAt))}</time>
                          </li>
                        `
                      )
                      .join("")}
                  </ul>
                </article>
              `
            )
            .join("")}
        </section>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Inhaltsverzeichnis",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken
      })
    );
  });

  app.get("/wiki/:slug", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
    const params = request.params as { slug: string };
    const query = asObject(request.query);
    let normalizedSlug = "";
    try {
      normalizedSlug = normalizeArticleSlug(params.slug);
    } catch {
      // Invalid slugs are client input errors, not "not found".
      return reply.code(400).type("text/plain").send("Ungültiger Slug");
    }
    const page = await getPage(normalizedSlug);

    if (!page) {
      return reply
        .code(404)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Nicht gefunden",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Seite nicht gefunden</h1><p>Die angeforderte Wiki-Seite existiert nicht.</p></section>`
          })
        );
    }

    if (normalizedSlug !== page.slug) {
      return reply.redirect(`/wiki/${encodeURIComponent(page.slug)}`);
    }

    if (!canUserAccessPage(page, request.currentUser)) {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Kein Zugriff",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Kein Zugriff</h1><p>Du hast keine Berechtigung für diesen Artikel.</p></section>`
          })
        );
    }

    const articleToc = renderArticleToc(page.slug, page.tableOfContents);
    const [backlinks, allPageComments, activeUsers] = await Promise.all([
      listPageBacklinks(page.slug, request.currentUser),
      listPageComments(page.slug),
      request.currentUser ? listUsers() : Promise.resolve([])
    ]);
    const mentionableUsernames = new Set(
      activeUsers
        .filter((user) => !user.disabled)
        .map((user) => user.username.toLowerCase())
    );
    const pageComments =
      request.currentUser?.role === "admin"
        ? allPageComments
        : allPageComments.filter(
            (comment) => comment.status === "approved" || (request.currentUser && comment.authorId === request.currentUser.id && comment.status === "pending")
          );
    const requestedCommentsPageRaw = Number.parseInt(readSingle(query.cp), 10);
    const totalCommentPages = Math.max(1, Math.ceil(pageComments.length / COMMENT_PAGE_SIZE));
    const currentCommentPage =
      Number.isFinite(requestedCommentsPageRaw) && requestedCommentsPageRaw >= 1
        ? Math.min(requestedCommentsPageRaw, totalCommentPages)
        : totalCommentPages;
    const commentsStart = (currentCommentPage - 1) * COMMENT_PAGE_SIZE;
    const visibleComments = pageComments.slice(commentsStart, commentsStart + COMMENT_PAGE_SIZE);
    const notice = readSingle(query.notice);
    const error = readSingle(query.error);

    // ── ETag / HTTP-Caching ───────────────────────────────────────────────────
    // Use conditional 304 responses for non-personalized guest pages only.
    // Authenticated responses include user-specific fragments (watch state, badges, actions).
    if (!request.currentUser) {
      const etag = buildGuestWikiPageEtag({
        slug: page.slug,
        title: page.title,
        categoryName: page.categoryName,
        securityProfile: page.securityProfile,
        visibility: page.visibility,
        encrypted: page.encrypted,
        sensitive: page.sensitive,
        integrityState: page.integrityState,
        updatedAt: page.updatedAt,
        updatedBy: page.updatedBy,
        html: page.html,
        tableOfContents: page.tableOfContents,
        backlinks,
        pageComments,
        currentCommentPage,
        totalCommentPages,
        notice,
        error
      });
      reply.header("ETag", etag);
      reply.header("Cache-Control", "public, max-age=0, must-revalidate");
      if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
        return reply.code(304).send();
      }
    } else {
      reply.header("Cache-Control", "private, no-store");
    }

    try {
      await recordPageView({
        slug: page.slug,
        ...(request.currentUser?.id ? { userId: request.currentUser.id } : {}),
        ...(request.currentSessionId ? { sessionId: request.currentSessionId } : {})
      });
    } catch (recordError) {
      request.log.warn({ error: recordError, slug: page.slug }, "Konnte Seitenaufruf nicht fuer Trending erfassen");
    }

    const commentPageUrl = (targetPage: number): string => {
      const target = Math.min(Math.max(targetPage, 1), totalCommentPages);
      const params = new URLSearchParams();
      if (target > 1) params.set("cp", String(target));
      const queryString = params.toString();
      return `/wiki/${encodeURIComponent(page.slug)}${queryString ? `?${queryString}` : ""}#comments`;
    };
    const isWatching = request.currentUser
      ? await isUserWatchingPage({
          userId: request.currentUser.id,
          slug: page.slug
        })
      : false;
    const integrityLabel =
      page.integrityState === "valid"
        ? "geprüft"
        : page.integrityState === "legacy"
          ? "legacy"
          : page.integrityState === "unverifiable"
            ? "nicht prüfbar"
            : "fehlerhaft";
    const visibilityLabel = page.visibility === "restricted" ? "eingeschränkt" : "alle";
    const breadcrumbs = renderSlugBreadcrumbs(page.slug);
    const body = `
      <article class="wiki-page article-page ${articleToc ? "article-layout" : ""}">
        ${articleToc}
        <div class="article-main">
          <header class="article-header">
            ${breadcrumbs}
            <h1>${escapeHtml(page.title)}</h1>
            <div class="card-meta article-meta-row">
              <span class="meta-pill">Kategorie: ${escapeHtml(page.categoryName)}</span>
              <span class="meta-pill">Profil: ${escapeHtml(formatSecurityProfileLabel(page.securityProfile))}</span>
              <span class="meta-pill">Zugriff: ${escapeHtml(visibilityLabel)}</span>
              <span class="meta-pill">${page.encrypted ? "Verschlüsselt" : "Unverschlüsselt"}</span>
              <span class="meta-pill">Integrität: ${escapeHtml(integrityLabel)}</span>
            </div>
            ${
              page.sensitive
                ? '<p class="muted-note">Sensibler Modus aktiv. Keine PIN/TAN, vollständige Kartendaten oder Geheimnisse im Klartext speichern.</p>'
                : ""
            }
            <p class="meta">Zuletzt geändert: <time datetime="${escapeHtml(page.updatedAt)}">${escapeHtml(
              formatDate(page.updatedAt)
            )}</time> | von ${escapeHtml(page.updatedBy)}</p>
            <div class="actions">
              ${
                request.currentUser
                  ? `<a class="button secondary" href="/wiki/${encodeURIComponent(page.slug)}/edit">Bearbeiten</a>
                     <form method="post" action="/wiki/${encodeURIComponent(page.slug)}/watch" class="inline-watch-form" data-watch-form>
                       <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
                       <input type="hidden" name="mode" value="toggle" />
                       <button
                         type="submit"
                         class="button secondary watch-toggle ${isWatching ? "is-watching" : ""}"
                         data-watch-button
                         aria-pressed="${isWatching ? "true" : "false"}"
                       >
                         <span data-watch-label>${isWatching ? "Beobachtet" : "Beobachten"}</span>
                       </button>
                       <span class="watch-feedback muted-note small" data-watch-feedback role="status" aria-live="polite"></span>
                     </form>`
                  : ""
              }
              <a class="button secondary" href="/wiki/${encodeURIComponent(page.slug)}/history">Historie</a>
              ${
                request.currentUser?.role === "admin"
                  ? `<form method="post" action="/wiki/${encodeURIComponent(page.slug)}/delete" onsubmit="return confirm('Seite wirklich löschen?')"><input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" /><button class="danger" type="submit">Löschen</button></form>`
                  : ""
              }
            </div>
          </header>
          <section class="wiki-content">${page.html}</section>
          <section class="wiki-backlinks">
            <h2>Verlinkt von</h2>
            ${
              backlinks.length < 1
                ? '<p class="muted-note">Keine eingehenden internen Links gefunden.</p>'
                : `<ul>${backlinks
                    .map(
                      (link) =>
                        `<li><a href="/wiki/${encodeURIComponent(link.slug)}">${escapeHtml(link.title)}</a> <span class="muted-note small">(${escapeHtml(
                          link.categoryName
                        )}, ${escapeHtml(formatDate(link.updatedAt))})</span></li>`
                    )
                    .join("")}</ul>`
            }
          </section>
          <section class="wiki-comments" id="comments">
            <h2>Kommentare ${pageComments.length > 0 ? `<span class="muted-note">(${pageComments.length})</span>` : ""}</h2>
            ${
              pageComments.length < 1
                ? '<p class="muted-note">Noch keine Kommentare.</p>'
                : visibleComments
                    .map(
                      (comment) => {
                        const canReplyMention = request.currentUser && mentionableUsernames.has(comment.authorUsername.toLowerCase());
                        const authorMarkup = canReplyMention
                          ? `<a href="#comments" class="comment-author comment-author-reply" data-comment-reply-mention="${escapeHtml(
                              comment.authorUsername
                            )}" title="@${escapeHtml(comment.authorUsername)} erwähnen">${escapeHtml(comment.authorDisplayName)}</a>`
                          : `<span class="comment-author">${escapeHtml(comment.authorDisplayName)}</span>`;
                        const commentMarkdown = request.currentUser
                          ? injectReplyMentionLinks(comment.body, mentionableUsernames)
                          : comment.body;
                        return `
                      <article class="comment-item" id="comment-${escapeHtml(comment.id)}">
                        <header class="comment-header">
                          ${authorMarkup}
                          ${
                            comment.status === "pending"
                              ? '<span class="tag-chip">wartet auf Freigabe</span>'
                              : comment.status === "rejected"
                                ? '<span class="tag-chip">abgelehnt</span>'
                                : ""
                          }
                          <time class="comment-date muted-note small" datetime="${escapeHtml(comment.createdAt)}">${escapeHtml(formatDate(comment.createdAt))}</time>
                          ${
                            request.currentUser && (request.currentUser.id === comment.authorId || request.currentUser.role === "admin")
                              ? `<form method="post" action="/wiki/${encodeURIComponent(page.slug)}/comment/${encodeURIComponent(comment.id)}/delete" class="comment-delete-form" onsubmit="return confirm('Kommentar wirklich löschen?')">
                                  <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
                                  <button class="button danger tiny" type="submit">Löschen</button>
                                </form>`
                              : ""
                          }
                        </header>
                        <div class="comment-body">${renderMarkdownPreview(commentMarkdown)}</div>
                      </article>`;
                      }
                    )
                    .join("")
            }
            ${
              pageComments.length > COMMENT_PAGE_SIZE
                ? `<div class="action-row">
                    <span class="muted-note small">Seite ${currentCommentPage} von ${totalCommentPages}</span>
                    ${
                      currentCommentPage > 1
                        ? `<a class="button secondary tiny" href="${commentPageUrl(currentCommentPage - 1)}">Neuere</a>`
                        : ""
                    }
                    ${
                      currentCommentPage < totalCommentPages
                        ? `<a class="button secondary tiny" href="${commentPageUrl(currentCommentPage + 1)}">Ältere</a>`
                        : ""
                    }
                  </div>`
                : ""
            }
            ${
              request.currentUser
                ? `<form method="post" action="/wiki/${encodeURIComponent(page.slug)}/comment" class="comment-form stack">
                    <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
                    <label for="comment-body">Kommentar schreiben <span class="muted-note small">(Markdown, @username für Erwähnungen)</span></label>
                    <div class="comment-mention-field">
                      <textarea id="comment-body" name="body" rows="4" maxlength="4000" placeholder="Kommentar …" required class="comment-textarea"></textarea>
                      <div class="comment-mention-suggest" hidden></div>
                    </div>
                    <div class="actions">
                      <button type="submit" class="button primary">Kommentar posten</button>
                    </div>
                  </form>`
                : '<p class="muted-note"><a href="/login">Anmelden</a>, um zu kommentieren.</p>'
            }
          </section>
        </div>
      </article>
    `;

    const scripts: string[] = [];
    if (articleToc) scripts.push("/article-toc.js?v=4");
    if (request.currentUser) scripts.push("/comment-mention.js?v=6");

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: page.title,
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice,
        error,
        scripts: scripts.length > 0 ? scripts : undefined
      })
    );
  });

  app.post("/wiki/:slug/watch", { preHandler: [requireAuth, requireFormCsrfToken] }, async (request, reply) => {
    const params = request.params as { slug: string };
    const body = asObject(request.body);
    const requestedJson = wantsJsonResponse(request);
    let normalizedSlug = "";
    try {
      normalizedSlug = normalizeArticleSlug(params.slug);
    } catch {
      const errorMessage = "Ungültiger Slug.";
      if (requestedJson) return reply.code(400).send({ ok: false, error: errorMessage });
      return reply.code(400).type("text/plain").send(errorMessage);
    }
    const currentUser = request.currentUser;

    const fail = (status: number, message: string) => {
      if (requestedJson) {
        return reply.code(status).send({ ok: false, error: message });
      }
      return reply.redirect(`/wiki/${encodeURIComponent(normalizedSlug)}?error=${encodeURIComponent(message)}`);
    };

    if (!currentUser) {
      return fail(401, "Anmeldung erforderlich.");
    }

    const page = await getPage(normalizedSlug);
    if (!page) {
      return fail(404, "Seite nicht gefunden.");
    }

    if (!canUserAccessPage(page, currentUser)) {
      return fail(403, "Kein Zugriff auf diesen Artikel.");
    }

    const targetSlug = page.slug;
    const mode = readSingle(body.mode).trim().toLowerCase();
    const currentWatching = await isUserWatchingPage({ userId: currentUser.id, slug: targetSlug });
    const shouldWatch = mode === "watch" ? true : mode === "unwatch" ? false : !currentWatching;

    const result = shouldWatch
      ? await watchPage({ userId: currentUser.id, slug: targetSlug })
      : await unwatchPage({ userId: currentUser.id, slug: targetSlug });

    if (!result.ok) {
      return fail(500, "Watch-Status konnte nicht gespeichert werden.");
    }

    const watching = await isUserWatchingPage({ userId: currentUser.id, slug: targetSlug });
    const message = watching ? "Seite wird jetzt beobachtet." : "Beobachtung wurde entfernt.";

    await writeAuditLog({
      action: watching ? "wiki_page_watch_enabled" : "wiki_page_watch_disabled",
      actorId: currentUser.id,
      targetId: targetSlug
    });

    if (requestedJson) {
      return reply.send({
        ok: true,
        slug: targetSlug,
        watching,
        changed: result.changed,
        message
      });
    }

    return reply.redirect(`/wiki/${encodeURIComponent(targetSlug)}?notice=${encodeURIComponent(message)}`);
  });

  // ─── Kommentare ──────────────────────────────────────────────────────────────

  app.post(
    "/wiki/:slug/comment",
    { preHandler: [requireAuth, requireFormCsrfToken], config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const params = request.params as { slug: string };
    const body = asObject(request.body);
    let normalizedSlug = "";
    try {
      normalizedSlug = normalizeArticleSlug(params.slug);
    } catch {
      return reply.code(400).type("text/plain").send("Ungültiger Slug.");
    }

    const currentUser = request.currentUser;
    if (!currentUser) {
      return reply.redirect(`/login?error=${encodeURIComponent("Anmeldung erforderlich.")}`);
    }

    const page = await getPage(normalizedSlug);
    if (!page) {
      return reply.redirect(`/?error=${encodeURIComponent("Seite nicht gefunden.")}`);
    }

    if (!canUserAccessPage(page, currentUser)) {
      return reply.redirect(`/?error=${encodeURIComponent("Kein Zugriff auf diesen Artikel.")}`);
    }

    const commentBody = readSingle(body.body).trim();
    const commentModeration = await getCommentModerationSettings();
    const currentUsername = currentUser.username.trim().toLowerCase();
    const autoApproveBySettings =
      commentModeration.moderationMode === "all_auto" ||
      (commentModeration.moderationMode === "trusted_auto" &&
        commentModeration.trustedAutoApproveUsernames.includes(currentUsername));
    const result = await createPageComment({
      slug: page.slug,
      body: commentBody,
      authorId: currentUser.id,
      authorUsername: currentUser.username,
      authorDisplayName: currentUser.displayName,
      authorRole: currentUser.role,
      autoApprove: currentUser.role === "admin" || autoApproveBySettings
    });

    if (!result.ok || !result.comment) {
      return reply.redirect(
        `/wiki/${encodeURIComponent(page.slug)}?error=${encodeURIComponent(result.error ?? "Kommentar konnte nicht gespeichert werden.")}`
      );
    }

      await writeAuditLog({
        action: "wiki_comment_created",
        actorId: currentUser.id,
        targetId: result.comment.id,
        details: {
          slug: page.slug,
          status: result.comment.status
        }
      });

      if (result.comment.status === "approved" && result.comment.mentions.length > 0) {
      await notifyMentionedUsersForComment({
        page,
        commentId: result.comment.id,
        mentionUsernames: result.comment.mentions,
        actorId: currentUser.id,
        actorDisplayName: currentUser.displayName
      });
      }

      if (result.comment.status === "approved") {
        await notifyWatchersForPageEvent({
          slug: page.slug,
          title: page.title,
          page,
          actorId: currentUser.id,
          actorUsername: currentUser.displayName,
          event: "comment",
          eventTitle: `Neuer Kommentar: ${page.title}`,
          eventBody: `${currentUser.displayName} hat einen Kommentar hinzugefügt.`,
          url: `/wiki/${encodeURIComponent(page.slug)}#comment-${encodeURIComponent(result.comment.id)}`
        });
        return reply.redirect(`/wiki/${encodeURIComponent(page.slug)}#comment-${encodeURIComponent(result.comment.id)}`);
      }

      return reply.redirect(`/wiki/${encodeURIComponent(page.slug)}?notice=${encodeURIComponent("Kommentar gespeichert und wartet auf Freigabe.")}#comments`);
    }
  );

  app.post(
    "/wiki/:slug/comment/:commentId/delete",
    { preHandler: [requireAuth, requireFormCsrfToken], config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const params = request.params as { slug: string; commentId: string };
      let normalizedSlug = "";
      try {
        normalizedSlug = normalizeArticleSlug(params.slug);
      } catch {
        return reply.code(400).type("text/plain").send("Ungültiger Slug.");
      }

      const currentUser = request.currentUser;
      if (!currentUser) {
        return reply.redirect(`/login?error=${encodeURIComponent("Anmeldung erforderlich.")}`);
      }

      const page = await getPage(normalizedSlug);
      if (!page) {
        return reply.redirect(`/?error=${encodeURIComponent("Seite nicht gefunden.")}`);
      }

      if (!canUserAccessPage(page, currentUser)) {
        return reply.redirect(`/?error=${encodeURIComponent("Kein Zugriff.")}`);
      }

      const result = await deletePageComment({
        slug: page.slug,
        commentId: params.commentId.trim(),
        actorId: currentUser.id,
        isAdmin: currentUser.role === "admin"
      });

      if (!result.ok) {
        return reply.redirect(
          `/wiki/${encodeURIComponent(page.slug)}?error=${encodeURIComponent(result.error ?? "Kommentar konnte nicht gelöscht werden.")}`
        );
      }

      if (result.deleted) {
        await writeAuditLog({
          action: "wiki_comment_deleted",
          actorId: currentUser.id,
          targetId: params.commentId.trim(),
          details: { slug: page.slug }
        });
      }

      return reply.redirect(`/wiki/${encodeURIComponent(page.slug)}#comments`);
    }
  );

  app.get("/new", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = asObject(request.query);
    const uiMode = getUiMode();
    const showSensitiveProfileOption = uiMode === "advanced";
    const categories = await listCategories();
    const pageTemplates = await listTemplates({ includeDisabled: false });
    const defaultCategory = await getDefaultCategory();
    const groups = await listGroups();
    const users = (await listUsers())
      .filter((user) => !user.disabled)
      .map((user) => ({ username: user.username, displayName: user.displayName }));

    const draftTitle = readSingle(query.title);
    const draftSlug = readSingle(query.slug) || slugifyTitle(draftTitle);
    const draftTags = readSingle(query.tags);
    const draftContent = readSingle(query.content);
    const selectedCategoryId = readSingle(query.categoryId) || defaultCategory.id;
    const selectedTemplateId = readSingle(query.template).trim();
    const legacySensitive = ["1", "true", "on", "yes"].includes(readSingle(query.sensitive).trim().toLowerCase());
    const requestedSecurityProfile = resolveSecurityProfileForUiMode({
      requested: normalizeSecurityProfileValue(readSingle(query.securityProfile)),
      uiMode
    });
    let visibility: "all" | "restricted" = readSingle(query.visibility) === "restricted" ? "restricted" : "all";
    const allowedUsers = normalizeUsernames(readMany(query.allowedUsers));
    const knownGroupIds = new Set(groups.map((group) => group.id));
    const allowedGroups = normalizeIds(readMany(query.allowedGroups)).filter((groupId) => knownGroupIds.has(groupId));
    const encrypted = readSingle(query.encrypted) === "1";
    const normalizedSettings = applySecurityProfileToSettings(
      resolveSecurityProfileForUiMode({
        requested: legacySensitive && requestedSecurityProfile === "standard" ? "sensitive" : requestedSecurityProfile,
        uiMode
      }),
      {
        visibility,
        encrypted,
        sensitive: legacySensitive
      }
    );
    visibility = normalizedSettings.visibility;

    const body = renderEditorForm({
      mode: "new",
      action: "/new",
      slug: draftSlug,
      slugAuto: readSingle(query.slug).trim().length === 0,
      title: draftTitle,
      tags: draftTags,
      content: draftContent,
      csrfToken: request.csrfToken ?? "",
      categories: categories.map((entry) => ({ id: entry.id, name: entry.name })),
      selectedCategoryId,
      securityProfile: normalizedSettings.securityProfile,
      visibility: normalizedSettings.visibility,
      allowedUsers,
      allowedGroups,
      availableUsers: users,
      availableGroups: groups.map((group) => ({ id: group.id, name: group.name, description: group.description })),
      pageTemplates: pageTemplates.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        defaultTitle: template.defaultTitle,
        defaultTags: template.defaultTags,
        defaultContent: template.defaultContent,
        sensitivity: template.sensitivity
      })),
      selectedTemplateId,
      encrypted: normalizedSettings.encrypted,
      encryptionAvailable: Boolean(config.contentEncryptionKey),
      uiMode,
      showSensitiveProfileOption
    });

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Neue Seite",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(query.error),
        scripts: ["/wiki-ui.js?v=13"]
      })
    );
  });

  app.post("/new", { preHandler: [requireAuth, requireFormCsrfToken] }, async (request, reply) => {
    const body = asObject(request.body);
    const uiMode = getUiMode();

    const title = readSingle(body.title).trim();
    const slug = (readSingle(body.slug).trim() || slugifyTitle(title)).toLowerCase();
    const tagsRaw = readSingle(body.tags);
    const tags = tagsRaw
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const content = readSingle(body.content);

    const securityProfile = resolveSecurityProfileForUiMode({
      requested: normalizeSecurityProfileValue(readSingle(body.securityProfile)),
      uiMode
    });
    let visibility: "all" | "restricted" = readSingle(body.visibility) === "restricted" ? "restricted" : "all";
    const selectedCategoryId = readSingle(body.categoryId);
    const encrypted = readSingle(body.encrypted) === "1" || readSingle(body.encrypted) === "on";
    const normalizedSettings = applySecurityProfileToSettings(securityProfile, {
      visibility,
      encrypted,
      sensitive: false
    });
    visibility = normalizedSettings.visibility;
    if (normalizedSettings.securityProfile !== "standard" && !config.contentEncryptionKey) {
      const query = buildEditorRedirectQuery({
        error: "Sensibel/Vertraulich benötigt CONTENT_ENCRYPTION_KEY.",
        title,
        slug,
        tags: tagsRaw,
        content,
        categoryId: selectedCategoryId,
        securityProfile: normalizedSettings.securityProfile,
        visibility,
        allowedUsers: normalizeUsernames(readMany(body.allowedUsers)),
        allowedGroups: normalizeIds(readMany(body.allowedGroups)),
        encrypted: normalizedSettings.encrypted
      });
      return reply.redirect(`/new?${query}`);
    }

    const knownUsernames = new Set((await listUsers()).filter((user) => !user.disabled).map((user) => user.username.toLowerCase()));
    const knownGroupIds = new Set((await listGroups()).map((group) => group.id));

    const allowedUsersInput = normalizeUsernames(readMany(body.allowedUsers));
    const allowedUsers = allowedUsersInput.filter((username) => knownUsernames.has(username));
    const allowedGroupsInput = normalizeIds(readMany(body.allowedGroups));
    const allowedGroups = allowedGroupsInput.filter((groupId) => knownGroupIds.has(groupId));

    if (visibility === "restricted" && request.currentUser?.username && request.currentUser.role !== "admin") {
      const own = request.currentUser.username.toLowerCase();
      if (!allowedUsers.includes(own)) {
        allowedUsers.push(own);
      }
    }

    if (!isValidSlug(slug)) {
      const query = buildEditorRedirectQuery({
        error: "Ungültige Seitenadresse",
        title,
        slug,
        tags: tagsRaw,
        content,
        categoryId: selectedCategoryId,
        securityProfile: normalizedSettings.securityProfile,
        visibility,
        allowedUsers,
        allowedGroups,
        encrypted: normalizedSettings.encrypted
      });
      return reply.redirect(`/new?${query}`);
    }

    const existing = await getPage(slug);
    if (existing) {
      const query = buildEditorRedirectQuery({
        error: "Seitenadresse existiert bereits",
        title,
        slug,
        tags: tagsRaw,
        content,
        categoryId: selectedCategoryId,
        securityProfile: normalizedSettings.securityProfile,
        visibility,
        allowedUsers,
        allowedGroups,
        encrypted: normalizedSettings.encrypted
      });
      return reply.redirect(`/new?${query}`);
    }

    const result = await savePage({
      slug,
      title,
      categoryId: selectedCategoryId,
      securityProfile: normalizedSettings.securityProfile,
      visibility,
      allowedUsers,
      allowedGroups,
      encrypted: normalizedSettings.encrypted,
      tags,
      content,
      updatedBy: request.currentUser?.username ?? "unknown"
    });

    if (!result.ok) {
      const query = buildEditorRedirectQuery({
        error: result.error ?? "Speichern fehlgeschlagen",
        title,
        slug,
        tags: tagsRaw,
        content,
        categoryId: selectedCategoryId,
        securityProfile: normalizedSettings.securityProfile,
        visibility,
        allowedUsers,
        allowedGroups,
        encrypted: normalizedSettings.encrypted
      });
      return reply.redirect(`/new?${query}`);
    }

    const createIndexResult = await upsertSearchIndexBySlug(slug);
    if (!createIndexResult.updated && createIndexResult.reason && createIndexResult.reason !== "rebuild_running") {
      request.log.warn({ slug, reason: createIndexResult.reason }, "Konnte Suchindex für neue Seite nicht inkrementell aktualisieren");
    }

    await writeAuditLog({
      action: "wiki_page_created",
      actorId: request.currentUser?.id,
      targetId: slug
    });

    return reply.redirect(`/wiki/${encodeURIComponent(slug)}`);
  });

  app.get("/wiki/:slug/edit", { preHandler: [requireAuth] }, async (request, reply) => {
    const params = request.params as { slug: string };
    let normalizedSlug = "";
    try {
      normalizedSlug = normalizeArticleSlug(params.slug);
    } catch {
      return reply.code(400).type("text/plain").send("Ungültiger Slug");
    }
    const page = await getPage(normalizedSlug);

    if (!page) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
    }

    if (normalizedSlug !== page.slug) {
      return reply.redirect(`/wiki/${encodeURIComponent(page.slug)}/edit`);
    }

    if (!canUserAccessPage(page, request.currentUser)) {
      return reply.redirect("/?error=Kein+Zugriff");
    }

    if (page.integrityState === "invalid") {
      return reply.redirect(`/wiki/${encodeURIComponent(page.slug)}?error=Integrit%C3%A4tspr%C3%BCfung+fehlgeschlagen`);
    }

    if (page.integrityState === "unverifiable") {
      return reply.redirect(`/wiki/${encodeURIComponent(page.slug)}?error=Integrit%C3%A4tspr%C3%BCfung+nicht+m%C3%B6glich`);
    }

    if (page.encrypted && page.encryptionState !== "ok") {
      return reply.redirect(`/wiki/${encodeURIComponent(page.slug)}?error=Verschl%C3%BCsselter+Inhalt+konnte+nicht+entschl%C3%BCsselt+werden`);
    }

    const uiMode = getUiMode();
    const showSensitiveProfileOption = uiMode === "advanced";
    const categories = await listCategories();
    const groups = await listGroups();
    const users = (await listUsers())
      .filter((user) => !user.disabled)
      .map((user) => ({ username: user.username, displayName: user.displayName }));

    const query = asObject(request.query);
    const title = readSingle(query.title) || page.title;
    const tags = readSingle(query.tags) || page.tags.join(", ");
    const content = readSingle(query.content) || page.content;
    const selectedCategoryId = readSingle(query.categoryId) || page.categoryId;
    const securityProfileRaw = readSingle(query.securityProfile).trim();
    const securityProfile = resolveSecurityProfileForUiMode({
      requested: securityProfileRaw ? normalizeSecurityProfileValue(securityProfileRaw) : page.securityProfile,
      uiMode,
      existing: page.securityProfile
    });
    let visibility: "all" | "restricted" = readSingle(query.visibility) === "restricted" ? "restricted" : page.visibility;
    const allowedUsers = normalizeUsernames(readMany(query.allowedUsers).length > 0 ? readMany(query.allowedUsers) : page.allowedUsers);
    const knownGroupIds = new Set(groups.map((group) => group.id));
    const allowedGroups = normalizeIds(readMany(query.allowedGroups).length > 0 ? readMany(query.allowedGroups) : page.allowedGroups).filter(
      (groupId) => knownGroupIds.has(groupId)
    );
    const encrypted = readSingle(query.encrypted) ? readSingle(query.encrypted) === "1" : page.encrypted;
    const normalizedSettings = applySecurityProfileToSettings(securityProfile, {
      visibility,
      encrypted,
      sensitive: page.sensitive
    });
    visibility = normalizedSettings.visibility;

    const body = renderEditorForm({
      mode: "edit",
      action: `/wiki/${encodeURIComponent(page.slug)}/edit`,
      slug: page.slug,
      slugAuto: false,
      title,
      tags,
      content,
      csrfToken: request.csrfToken ?? "",
      slugLocked: true,
      categories: categories.map((entry) => ({ id: entry.id, name: entry.name })),
      selectedCategoryId,
      securityProfile: normalizedSettings.securityProfile,
      visibility: normalizedSettings.visibility,
      allowedUsers,
      allowedGroups,
      availableUsers: users,
      availableGroups: groups.map((group) => ({ id: group.id, name: group.name, description: group.description })),
      pageTemplates: [],
      encrypted: normalizedSettings.encrypted,
      encryptionAvailable: Boolean(config.contentEncryptionKey),
      uiMode,
      showSensitiveProfileOption,
      lastKnownUpdatedAt: page.updatedAt,
      lastKnownConflictToken: buildEditConflictToken(page)
    });

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: `Bearbeiten: ${page.title}`,
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(query.error),
        scripts: ["/wiki-ui.js?v=13"]
      })
    );
  });

  app.post("/api/uploads", { preHandler: [requireAuth], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const csrfToken = request.headers["x-csrf-token"];
    const csrfValue = Array.isArray(csrfToken) ? csrfToken[0] ?? "" : csrfToken ?? "";
    const query = asObject(request.query);
    const selectedCategoryId = readSingle(query.categoryId);
    const pageSlug = readSingle(query.slug).trim().toLowerCase();
    const securityProfileContext = normalizeSecurityProfileValue(readSingle(query.securityProfile));
    const encryptedContext = ["1", "true", "on"].includes(readSingle(query.encrypted).trim().toLowerCase());
    const category = (await findCategoryById(selectedCategoryId)) ?? (await getDefaultCategory());
    const uploadSubDir = category.uploadFolder.trim() || "allgemein";
    const uploadTargetDir = safeResolve(config.uploadDir, uploadSubDir);

    if (!verifySessionCsrfToken(request, csrfValue)) {
      return reply.code(400).send({ ok: false, error: "Ungültiges CSRF-Token." });
    }

    if (securityProfileContext !== "standard" || encryptedContext) {
      return reply.code(400).send({
        ok: false,
        error: "Bei sensiblen oder verschlüsselten Artikeln ist Bild-Upload deaktiviert."
      });
    }

    if (isValidSlug(pageSlug)) {
      const existingPage = await getPage(pageSlug);
      if (existingPage?.encrypted) {
        return reply.code(400).send({
          ok: false,
          error: "Dieser Artikel ist verschlüsselt. Bild-Upload ist deaktiviert."
        });
      }
    }

    if (!request.isMultipart()) {
      return reply.code(400).send({ ok: false, error: "Erwarteter Multipart-Upload." });
    }

    await ensureDir(uploadTargetDir);

    const uploaded: Array<{ url: string; markdown: string; originalName: string; storedName: string }> = [];
    const rejected: string[] = [];

    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") {
          continue;
        }

        if (part.fieldname !== "images") {
          part.file.resume();
          continue;
        }

        const extension = normalizeUploadExtension(part.filename, part.mimetype);
        if (!extension || !part.mimetype.startsWith("image/")) {
          rejected.push(`${part.filename ?? "Datei"}: Nicht unterstütztes Bildformat.`);
          part.file.resume();
          continue;
        }

        const storedName = `${Date.now()}-${randomUUID().replaceAll("-", "")}.${extension}`;
        const targetPath = safeResolve(uploadTargetDir, storedName);

        await pipeline(part.file, createWriteStream(targetPath, { flags: "wx" }));

        const url = `/uploads/${encodeURIComponent(uploadSubDir)}/${storedName}`;
        const alt = escapeMarkdownText(sanitizeAltText(part.filename ?? "Bild"));

        uploaded.push({
          url,
          markdown: `![${alt}](${url})`,
          originalName: part.filename ?? storedName,
          storedName
        });
      }
    } catch (error) {
      request.log.warn({ error }, "Upload fehlgeschlagen");
      return reply.code(400).send({ ok: false, error: "Upload fehlgeschlagen. Bitte Dateigröße/Format prüfen." });
    }

    if (uploaded.length === 0) {
      return reply.code(400).send({ ok: false, error: rejected[0] ?? "Keine Bilder hochgeladen." });
    }

    await writeAuditLog({
      action: "wiki_image_upload",
      actorId: request.currentUser?.id,
      details: {
        count: uploaded.length
      }
    });

    return reply.send({
      ok: true,
      files: uploaded,
      markdown: uploaded.map((file) => file.markdown).join("\n"),
      rejected
    });
  });

  app.post("/api/markdown/preview", { preHandler: [requireAuth], config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const payload = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    const markdown = typeof payload.markdown === "string" ? payload.markdown : "";

    const csrfHeader = request.headers["x-csrf-token"];
    const csrfFromHeader = Array.isArray(csrfHeader) ? csrfHeader[0] ?? "" : csrfHeader ?? "";
    const csrfFromBody = typeof payload._csrf === "string" ? payload._csrf : "";
    const csrfValue = csrfFromHeader || csrfFromBody;

    if (!verifySessionCsrfToken(request, csrfValue)) {
      return reply.code(400).send({ ok: false, error: "Ungültiges CSRF-Token." });
    }

    return reply.send({
      ok: true,
      html: renderMarkdownPreview(markdown)
    });
  });

  app.post("/wiki/:slug/edit", { preHandler: [requireAuth, requireFormCsrfToken] }, async (request, reply) => {
    const params = request.params as { slug: string };
    const body = asObject(request.body);
    let normalizedSlug = "";
    try {
      normalizedSlug = normalizeArticleSlug(params.slug);
    } catch {
      return reply.code(400).type("text/plain").send("Ungültiger Slug");
    }
    const uiMode = getUiMode();

    const existing = await getPage(normalizedSlug);
    if (!existing) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
    }

    if (!canUserAccessPage(existing, request.currentUser)) {
      return reply.redirect("/?error=Kein+Zugriff");
    }

    if (existing.integrityState === "invalid") {
      return reply.redirect(`/wiki/${encodeURIComponent(normalizedSlug)}?error=Integrit%C3%A4tspr%C3%BCfung+fehlgeschlagen`);
    }

    if (existing.integrityState === "unverifiable") {
      return reply.redirect(`/wiki/${encodeURIComponent(normalizedSlug)}?error=Integrit%C3%A4tspr%C3%BCfung+nicht+m%C3%B6glich`);
    }

    if (existing.encrypted && existing.encryptionState !== "ok") {
      return reply.redirect(`/wiki/${encodeURIComponent(normalizedSlug)}?error=Verschl%C3%BCsselter+Inhalt+konnte+nicht+entschl%C3%BCsselt+werden`);
    }

    const title = readSingle(body.title).trim();
    const tagsRaw = readSingle(body.tags);
    const tags = tagsRaw
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const content = readSingle(body.content);

    // Konflikterkennung: Prüfen ob die Seite seit dem Öffnen des Editors verändert wurde.
    const lastKnownUpdatedAt = readSingle(body.lastKnownUpdatedAt).trim();
    const lastKnownConflictToken = readSingle(body.lastKnownConflictToken).trim();
    const currentConflictToken = buildEditConflictToken(existing);
    const hasConflictByToken = lastKnownConflictToken.length > 0 && lastKnownConflictToken !== currentConflictToken;
    const hasConflictByUpdatedAt = lastKnownUpdatedAt.length > 0 && lastKnownUpdatedAt !== existing.updatedAt;
    if (hasConflictByToken || hasConflictByUpdatedAt) {
      const [conflictCategories, conflictGroups, conflictUsers] = await Promise.all([
        listCategories(),
        listGroups(),
        listUsers()
      ]);
      const conflictBody = renderEditorForm({
        mode: "edit",
        action: `/wiki/${encodeURIComponent(normalizedSlug)}/edit`,
        slug: normalizedSlug,
        slugAuto: false,
        title,
        tags: tagsRaw,
        content,
        csrfToken: request.csrfToken ?? "",
        slugLocked: true,
        categories: conflictCategories.map((c) => ({ id: c.id, name: c.name })),
        selectedCategoryId: existing.categoryId,
        securityProfile: existing.securityProfile,
        visibility: existing.visibility,
        allowedUsers: existing.allowedUsers,
        allowedGroups: existing.allowedGroups,
        availableUsers: conflictUsers.filter((u) => !u.disabled).map((u) => ({ username: u.username, displayName: u.displayName })),
        availableGroups: conflictGroups.map((g) => ({ id: g.id, name: g.name, description: g.description })),
        pageTemplates: [],
        encrypted: existing.encrypted,
        encryptionAvailable: Boolean(config.contentEncryptionKey),
        uiMode,
        showSensitiveProfileOption: uiMode === "advanced",
        lastKnownUpdatedAt: existing.updatedAt,
        lastKnownConflictToken: currentConflictToken
      });
      return reply.type("text/html").send(
        renderLayout({
          title: `Bearbeiten: ${existing.title}`,
          body: conflictBody,
          user: request.currentUser,
          csrfToken: request.csrfToken,
          error: `Konflikt: Diese Seite wurde zwischenzeitlich von „${escapeHtml(existing.updatedBy)}" am ${formatDate(existing.updatedAt)} geändert. Deine Änderungen sind unten erhalten – bitte prüfen und erneut speichern.`,
          scripts: ["/wiki-ui.js?v=13"]
        })
      );
    }

    const selectedCategoryId = readSingle(body.categoryId);
    const securityProfile = resolveSecurityProfileForUiMode({
      requested: normalizeSecurityProfileValue(readSingle(body.securityProfile)),
      uiMode,
      existing: existing.securityProfile
    });
    let visibility: "all" | "restricted" = readSingle(body.visibility) === "restricted" ? "restricted" : "all";
    const encrypted = readSingle(body.encrypted) === "1" || readSingle(body.encrypted) === "on";
    const normalizedSettings = applySecurityProfileToSettings(securityProfile, {
      visibility,
      encrypted,
      sensitive: existing.sensitive
    });
    visibility = normalizedSettings.visibility;

    const knownUsernames = new Set((await listUsers()).filter((user) => !user.disabled).map((user) => user.username.toLowerCase()));
    const knownGroupIds = new Set((await listGroups()).map((group) => group.id));

    const allowedUsersInput = normalizeUsernames(readMany(body.allowedUsers));
    const allowedUsers = allowedUsersInput.filter((username) => knownUsernames.has(username));
    const allowedGroupsInput = normalizeIds(readMany(body.allowedGroups));
    const allowedGroups = allowedGroupsInput.filter((groupId) => knownGroupIds.has(groupId));

    if (visibility === "restricted" && request.currentUser?.username && request.currentUser.role !== "admin") {
      const own = request.currentUser.username.toLowerCase();
      if (!allowedUsers.includes(own)) {
        allowedUsers.push(own);
      }
    }

    if (normalizedSettings.securityProfile !== "standard" && !config.contentEncryptionKey) {
      const query = buildEditorRedirectQuery({
        error: "Sensibel/Vertraulich benötigt CONTENT_ENCRYPTION_KEY.",
        title,
        tags: tagsRaw,
        content,
        categoryId: selectedCategoryId,
        securityProfile: normalizedSettings.securityProfile,
        visibility,
        allowedUsers,
        allowedGroups,
        encrypted: normalizedSettings.encrypted
      });

      return reply.redirect(`/wiki/${encodeURIComponent(normalizedSlug)}/edit?${query}`);
    }

    const result = await savePage({
      slug: normalizedSlug,
      title,
      categoryId: selectedCategoryId,
      securityProfile: normalizedSettings.securityProfile,
      visibility,
      allowedUsers,
      allowedGroups,
      encrypted: normalizedSettings.encrypted,
      tags,
      content,
      updatedBy: request.currentUser?.username ?? "unknown"
    });

    if (!result.ok) {
      const query = buildEditorRedirectQuery({
        error: result.error ?? "Speichern fehlgeschlagen",
        title,
        tags: tagsRaw,
        content,
        categoryId: selectedCategoryId,
        securityProfile: normalizedSettings.securityProfile,
        visibility,
        allowedUsers,
        allowedGroups,
        encrypted: normalizedSettings.encrypted
      });

      return reply.redirect(`/wiki/${encodeURIComponent(normalizedSlug)}/edit?${query}`);
    }

    const updateIndexResult = await upsertSearchIndexBySlug(normalizedSlug);
    if (!updateIndexResult.updated && updateIndexResult.reason && updateIndexResult.reason !== "rebuild_running") {
      request.log.warn(
        { slug: normalizedSlug, reason: updateIndexResult.reason },
        "Konnte Suchindex für bearbeitete Seite nicht inkrementell aktualisieren"
      );
    }

    await writeAuditLog({
      action: "wiki_page_updated",
      actorId: request.currentUser?.id,
      targetId: normalizedSlug
    });

    await notifyWatchersForPageEvent({
      slug: normalizedSlug,
      title,
      page: await getPage(normalizedSlug),
      ...(request.currentUser?.id ? { actorId: request.currentUser.id } : {}),
      ...(request.currentUser?.displayName ? { actorUsername: request.currentUser.displayName } : {}),
      event: "page_update",
      eventTitle: `Seite aktualisiert: ${title}`,
      eventBody: `${request.currentUser?.displayName ?? "Jemand"} hat die Seite aktualisiert.`,
      url: `/wiki/${encodeURIComponent(normalizedSlug)}`
    });

    if (existing.createdBy && existing.createdBy.toLowerCase() !== request.currentUser?.username?.toLowerCase()) {
      const creator = await findUserByUsername(existing.createdBy);
      if (creator && !creator.disabled) {
        const creatorAccessUser = await buildAccessUser(creator);
        const updatedPage = await getPage(normalizedSlug);
        if (updatedPage && canUserAccessPage(updatedPage, creatorAccessUser)) {
          await createNotification({
            userId: creator.id,
            type: "page_update",
            title: `${request.currentUser?.displayName ?? "Jemand"} hat deinen Beitrag bearbeitet`,
            body: title,
            url: `/wiki/${encodeURIComponent(normalizedSlug)}`,
            sourceSlug: normalizedSlug,
            actorId: request.currentUser?.id ?? "",
            dedupeKey: `page_update:${normalizedSlug}:${creator.id}:${Date.now()}`
          });

          if (creator.email) {
            sendPageUpdateNotification({
              toEmail: creator.email,
              toDisplayName: creator.displayName,
              pageTitle: title,
              pageSlug: normalizedSlug,
              actorDisplayName: request.currentUser?.displayName ?? "Jemand",
              eventType: "page_update"
            }).catch(() => {/* Mail-Fehler nie nach oben propagieren */});
          }
        }
      }
    }

    return reply.redirect(`/wiki/${encodeURIComponent(normalizedSlug)}`);
  });

  app.get("/wiki/:slug/history", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
    const params = request.params as { slug: string };
    let normalizedSlug = "";
    try {
      normalizedSlug = normalizeArticleSlug(params.slug);
    } catch {
      return reply.code(400).type("text/plain").send("Ungültiger Slug");
    }
    const page = await getPage(normalizedSlug);
    const versions = await listPageHistory(normalizedSlug, 250);

    if (!page && versions.length < 1) {
      return reply
        .code(404)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Historie nicht gefunden",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Keine Historie gefunden</h1><p>Für diesen Artikel sind keine Versionen vorhanden.</p></section>`
          })
        );
    }

    if (page && !canUserAccessPage(page, request.currentUser)) {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Kein Zugriff",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Kein Zugriff</h1><p>Du hast keine Berechtigung für diesen Artikel.</p></section>`
          })
        );
    }

    if (!page && request.currentUser?.role !== "admin") {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Kein Zugriff",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Kein Zugriff</h1><p>Historie gelöschter Seiten ist nur für Admins sichtbar.</p></section>`
          })
        );
    }

    const body = `
      <section class="content-wrap stack large">
        <div class="page-header">
          <div>
            <h1>Versionshistorie</h1>
            <p>${escapeHtml(page?.title ?? normalizedSlug)} (${escapeHtml(normalizedSlug)})</p>
          </div>
          <div class="action-row">
            ${
              page
                ? `<a class="button secondary" href="/wiki/${encodeURIComponent(normalizedSlug)}">Zur Seite</a>`
                : '<a class="button secondary" href="/">Zur Übersicht</a>'
            }
          </div>
        </div>
        ${
          versions.length < 1
            ? '<p class="empty">Noch keine Versionen vorhanden.</p>'
            : `
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Zeitpunkt</th>
                      <th>Typ</th>
                      <th>Aktion von</th>
                      <th>Stand vorher</th>
                      <th>Größe</th>
                      <th>Aktion</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${versions
                      .map(
                        (version) => `
                          <tr>
                            <td>${escapeHtml(formatDate(version.createdAt))}</td>
                            <td>${escapeHtml(formatHistoryReason(version.reason))}</td>
                            <td>${escapeHtml(version.createdBy)}</td>
                            <td>${
                              version.sourceUpdatedAt
                                ? `${escapeHtml(formatDate(version.sourceUpdatedAt))} / ${escapeHtml(version.sourceUpdatedBy ?? "-")}`
                                : "-"
                            }</td>
                            <td>${Math.max(1, Math.round(version.sizeBytes / 1024))} KB</td>
                            <td>
                              <div class="action-row">
                                <a class="button tiny secondary" href="/wiki/${encodeURIComponent(normalizedSlug)}/history/${encodeURIComponent(
                                  version.id
                                )}">Ansehen</a>
                                <a class="button tiny secondary" href="/wiki/${encodeURIComponent(normalizedSlug)}/history/${encodeURIComponent(
                                  version.id
                                )}/diff">Diff</a>
                              </div>
                            </td>
                          </tr>
                        `
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>
            `
        }
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Versionshistorie",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(asObject(request.query).error),
        notice: readSingle(asObject(request.query).notice)
      })
    );
  });

  app.get("/wiki/:slug/history/:versionId", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
    const params = request.params as { slug: string; versionId: string };
    let normalizedSlug = "";
    try {
      normalizedSlug = normalizeArticleSlug(params.slug);
    } catch {
      return reply.code(400).type("text/plain").send("Ungültiger Slug");
    }
    const page = await getPage(normalizedSlug);

    if (page && !canUserAccessPage(page, request.currentUser)) {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Kein Zugriff",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Kein Zugriff</h1><p>Du hast keine Berechtigung für diesen Artikel.</p></section>`
          })
        );
    }

    if (!page && request.currentUser?.role !== "admin") {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Kein Zugriff",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Kein Zugriff</h1><p>Historie gelöschter Seiten ist nur für Admins sichtbar.</p></section>`
          })
        );
    }

    const versions = await listPageHistory(normalizedSlug, 250);
    const version = versions.find((entry) => entry.id === params.versionId);
    const rawContent = await getPageVersionRawContent(normalizedSlug, params.versionId);
    if (!version || rawContent === null) {
      return reply
        .code(404)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Version nicht gefunden",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Version nicht gefunden</h1><p>Diese Version existiert nicht.</p></section>`
          })
        );
    }

    const body = `
      <section class="content-wrap stack large">
        <div class="page-header">
          <div>
            <h1>Version ansehen</h1>
            <p>${escapeHtml(page?.title ?? normalizedSlug)} (${escapeHtml(normalizedSlug)})</p>
          </div>
          <div class="action-row">
            <a class="button secondary" href="/wiki/${encodeURIComponent(normalizedSlug)}/history">Zur Historie</a>
            <a class="button secondary" href="/wiki/${encodeURIComponent(normalizedSlug)}/history/${encodeURIComponent(params.versionId)}/diff">Diff anzeigen</a>
            ${
              page
                ? `<a class="button secondary" href="/wiki/${encodeURIComponent(normalizedSlug)}">Zur Seite</a>`
                : '<a class="button secondary" href="/">Zur Übersicht</a>'
            }
          </div>
        </div>

        <div class="history-meta-grid">
          <div><strong>Zeitpunkt:</strong> ${escapeHtml(formatDate(version.createdAt))}</div>
          <div><strong>Typ:</strong> ${escapeHtml(formatHistoryReason(version.reason))}</div>
          <div><strong>Von:</strong> ${escapeHtml(version.createdBy)}</div>
          <div><strong>Vorheriger Stand:</strong> ${
            version.sourceUpdatedAt
              ? `${escapeHtml(formatDate(version.sourceUpdatedAt))} / ${escapeHtml(version.sourceUpdatedBy ?? "-")}`
              : "-"
          }</div>
        </div>

        ${
          request.currentUser?.role === "admin"
            ? `
              <form method="post" action="/wiki/${encodeURIComponent(normalizedSlug)}/history/${encodeURIComponent(
                version.id
              )}/restore" onsubmit="return confirm('Version wirklich wiederherstellen? Aktueller Stand wird zuvor gesichert.')" class="action-row">
                <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
                <button type="submit">Diese Version wiederherstellen</button>
              </form>
            `
            : ""
        }

        <pre class="history-raw">${escapeHtml(rawContent)}</pre>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Version ansehen",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(asObject(request.query).error),
        notice: readSingle(asObject(request.query).notice)
      })
    );
  });

  app.get("/wiki/:slug/history/:versionId/diff", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
    const params = request.params as { slug: string; versionId: string };
    const query = asObject(request.query);
    let normalizedSlug = "";
    try {
      normalizedSlug = normalizeArticleSlug(params.slug);
    } catch {
      return reply.code(400).type("text/plain").send("Ungültiger Slug");
    }
    const page = await getPage(normalizedSlug);

    if (page && !canUserAccessPage(page, request.currentUser)) {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Kein Zugriff",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Kein Zugriff</h1><p>Du hast keine Berechtigung für diesen Artikel.</p></section>`
          })
        );
    }

    if (!page && request.currentUser?.role !== "admin") {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Kein Zugriff",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Kein Zugriff</h1><p>Historie gelöschter Seiten ist nur für Admins sichtbar.</p></section>`
          })
        );
    }

    const versions = await listPageHistory(normalizedSlug, 250);
    const versionIndex = versions.findIndex((entry) => entry.id === params.versionId);
    const fromVersion = versionIndex >= 0 ? versions[versionIndex] : null;
    const fromRawContent = await getPageVersionRawContent(normalizedSlug, params.versionId);

    if (!fromVersion || fromRawContent === null) {
      return reply
        .code(404)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Version nicht gefunden",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Version nicht gefunden</h1><p>Diese Version existiert nicht.</p></section>`
          })
        );
    }

    const selectableVersions = versions.filter((entry) => entry.id !== fromVersion.id);
    const selectableVersionIds = new Set(selectableVersions.map((entry) => entry.id));
    const requestedCompareTo = readSingle(query.compareTo).trim();

    let compareTo = requestedCompareTo;
    if (compareTo === "current" && !page) {
      compareTo = "";
    }
    if (compareTo && compareTo !== "current" && !selectableVersionIds.has(compareTo)) {
      compareTo = "";
    }

    if (!compareTo) {
      const newerVersion = versionIndex > 0 ? versions[versionIndex - 1] : null;
      if (newerVersion) {
        compareTo = newerVersion.id;
      } else if (page) {
        compareTo = "current";
      } else {
        const olderVersion = versions[versionIndex + 1];
        compareTo = olderVersion?.id ?? "";
      }
    }

    let compareLabel = "";
    let compareMeta = "";
    let compareRawContent: string | null = null;

    if (compareTo === "current") {
      compareLabel = "Aktueller Stand";
      compareMeta = page ? `${formatDate(page.updatedAt)} / ${page.updatedBy}` : "-";
      compareRawContent = await getCurrentPageRawContent(normalizedSlug);
      if (compareRawContent === null && page) {
        compareRawContent = page.content;
      }
    } else if (compareTo) {
      const compareVersion = selectableVersions.find((entry) => entry.id === compareTo) ?? null;
      if (compareVersion) {
        compareLabel = `Version ${formatDate(compareVersion.createdAt)}`;
        compareMeta = `${formatHistoryReason(compareVersion.reason)} / ${compareVersion.createdBy}`;
        compareRawContent = await getPageVersionRawContent(normalizedSlug, compareVersion.id);
      }
    }

    if (compareRawContent === null) {
      return reply
        .code(404)
        .type("text/html")
        .send(
          renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
            title: "Vergleich nicht möglich",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Vergleich nicht möglich</h1><p>Die gewählte Vergleichsversion konnte nicht geladen werden.</p></section>`
          })
        );
    }

    const diff = renderHistoryDiff(fromRawContent, compareRawContent);
    const compareOptions = [
      ...(page
        ? [
            `<option value="current" ${compareTo === "current" ? "selected" : ""}>Aktueller Stand${page ? ` (${escapeHtml(formatDate(page.updatedAt))})` : ""}</option>`
          ]
        : []),
      ...selectableVersions.map(
        (entry) =>
          `<option value="${escapeHtml(entry.id)}" ${compareTo === entry.id ? "selected" : ""}>${escapeHtml(formatDate(entry.createdAt))} - ${escapeHtml(
            formatHistoryReason(entry.reason)
          )} (${escapeHtml(entry.createdBy)})</option>`
      )
    ].join("");

    const body = `
      <section class="content-wrap stack large">
        <div class="page-header">
          <div>
            <h1>Versions-Diff</h1>
            <p>${escapeHtml(page?.title ?? normalizedSlug)} (${escapeHtml(normalizedSlug)})</p>
          </div>
          <div class="action-row">
            <a class="button secondary" href="/wiki/${encodeURIComponent(normalizedSlug)}/history/${encodeURIComponent(fromVersion.id)}">Version ansehen</a>
            <a class="button secondary" href="/wiki/${encodeURIComponent(normalizedSlug)}/history">Zur Historie</a>
            ${
              page
                ? `<a class="button secondary" href="/wiki/${encodeURIComponent(normalizedSlug)}">Zur Seite</a>`
                : '<a class="button secondary" href="/">Zur Übersicht</a>'
            }
          </div>
        </div>

        <div class="history-meta-grid">
          <div><strong>Von:</strong> ${escapeHtml(formatDate(fromVersion.createdAt))}</div>
          <div><strong>Typ:</strong> ${escapeHtml(formatHistoryReason(fromVersion.reason))}</div>
          <div><strong>Autor:</strong> ${escapeHtml(fromVersion.createdBy)}</div>
          <div><strong>Nach:</strong> ${escapeHtml(compareLabel)}</div>
          <div><strong>Nach-Meta:</strong> ${escapeHtml(compareMeta || "-")}</div>
        </div>

        <form method="get" action="/wiki/${encodeURIComponent(normalizedSlug)}/history/${encodeURIComponent(fromVersion.id)}/diff" class="action-row">
          <label>Vergleichen mit
            <select name="compareTo" class="tiny">
              ${compareOptions}
            </select>
          </label>
          <button type="submit" class="tiny secondary">Diff aktualisieren</button>
        </form>

        <div class="card-meta">
          <span class="meta-pill">+${diff.addedLines} Zeilen</span>
          <span class="meta-pill">-${diff.removedLines} Zeilen</span>
          <span class="meta-pill">${diff.changed ? "Änderungen gefunden" : "Keine Änderungen"}</span>
        </div>

        ${diff.html}
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Versions-Diff",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(query.error),
        notice: readSingle(query.notice)
      })
    );
  });

  app.post("/wiki/:slug/history/:versionId/restore", { preHandler: [requireAdmin, requireFormCsrfToken] }, async (request, reply) => {
    const params = request.params as { slug: string; versionId: string };
    let normalizedSlug = "";
    try {
      normalizedSlug = normalizeArticleSlug(params.slug);
    } catch {
      return reply.code(400).type("text/plain").send("Ungültiger Slug");
    }

    const restoreResult = await restorePageVersion({
      slug: normalizedSlug,
      versionId: params.versionId,
      restoredBy: request.currentUser?.username ?? "unknown"
    });
    if (!restoreResult.ok) {
      return reply.redirect(
        `/wiki/${encodeURIComponent(normalizedSlug)}/history?error=${encodeURIComponent(restoreResult.error ?? "Restore fehlgeschlagen")}`
      );
    }

    const updateIndexResult = await upsertSearchIndexBySlug(normalizedSlug);
    if (!updateIndexResult.updated && updateIndexResult.reason && updateIndexResult.reason !== "rebuild_running") {
      request.log.warn(
        { slug: normalizedSlug, reason: updateIndexResult.reason },
        "Konnte Suchindex nach Restore nicht inkrementell aktualisieren"
      );
    }

    await writeAuditLog({
      action: "wiki_page_restored",
      actorId: request.currentUser?.id,
      targetId: normalizedSlug,
      details: {
        versionId: params.versionId
      }
    });

    return reply.redirect(`/wiki/${encodeURIComponent(normalizedSlug)}?notice=${encodeURIComponent("Version wiederhergestellt")}`);
  });

  app.post("/wiki/:slug/delete", { preHandler: [requireAdmin, requireFormCsrfToken] }, async (request, reply) => {
    const params = request.params as { slug: string };
    let normalizedSlug = "";
    try {
      normalizedSlug = normalizeArticleSlug(params.slug);
    } catch {
      return reply.code(400).type("text/plain").send("Ungültiger Slug");
    }

    const page = await getPage(normalizedSlug);
    if (!page) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
    }

    const candidateUploads = extractUploadReferencesFromMarkdown(page.content);
    const deleteResult = await deletePage(normalizedSlug, {
      deletedBy: request.currentUser?.username ?? "unknown"
    });
    if (!deleteResult.ok) {
      return reply.redirect(`/?error=${encodeURIComponent(deleteResult.error ?? "Löschen fehlgeschlagen")}`);
    }

    if (!deleteResult.deleted) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
    }

    const deleteIndexResult = await removeSearchIndexBySlug(normalizedSlug);
    if (!deleteIndexResult.updated && deleteIndexResult.reason && deleteIndexResult.reason !== "index_missing") {
      request.log.warn(
        { slug: normalizedSlug, reason: deleteIndexResult.reason },
        "Konnte Suchindex-Eintrag nach Löschung nicht inkrementell entfernen"
      );
    }

    let removedUploadsCount = 0;
    if (candidateUploads.length > 0) {
      try {
        const cleanupResult = await cleanupUnusedUploads({
          candidateFileNames: candidateUploads
        });
        removedUploadsCount = cleanupResult.deleted.length;
      } catch (error) {
        request.log.warn({ error, slug: normalizedSlug }, "Upload-Cleanup nach Seitenlöschung fehlgeschlagen");
      }
    }

    await writeAuditLog({
      action: "wiki_page_deleted",
      actorId: request.currentUser?.id,
      targetId: normalizedSlug,
      details: {
        removedUploadsCount
      }
    });

    const notice =
      removedUploadsCount > 0
        ? `Seite gelöscht, ${removedUploadsCount} ungenutzte Bilddatei(en) entfernt`
        : "Seite gelöscht";

    return reply.redirect(`/?notice=${encodeURIComponent(notice)}`);
  });

  app.get("/search", { preHandler: [requireAuthOrPublicRead], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const query = asObject(request.query);
    const q = readSingle(query.q).trim();
    const activeTag = normalizeTagFilter(readSingle(query.tag));
    const selectedCategoryId = readSingle(query.category);
    const selectedAuthor = readSingle(query.author).trim().toLowerCase();
    const selectedTimeframe = readSingle(query.timeframe).trim().toLowerCase();
    const selectedScope = readSingle(query.scope).trim().toLowerCase() || "all";
    const pageNumber = parsePageNumber(readSingle(query.page));
    const categories = await listCategories();

    // Query-Parser: Suchoperatoren (AND, OR, NOT, -, tag:) auflösen
    const parsedQuery = q.length >= 2 ? parseSearchQuery(q) : null;
    // Inline-Tags aus dem Query (tag:xxx) zusätzlich zu activeTag
    const inlineTags = parsedQuery?.tags ?? [];
    const allActiveTags = [...new Set([...(activeTag ? [activeTag] : []), ...inlineTags])];

    const hasTextSearch = q.length >= 2;
    const hasTagFilter = allActiveTags.length > 0;
    const hasAuthorFilter = selectedAuthor.length > 0;
    const hasScopeFilter = selectedScope !== "all";
    const hasTimeframeFilter = ["24h", "7d", "30d", "365d"].includes(selectedTimeframe);
    const hasCategoryFilter = selectedCategoryId.length > 0;
    const hasAnyFilter = hasTagFilter || hasAuthorFilter || hasScopeFilter || hasTimeframeFilter || hasCategoryFilter;

    const rawResults = hasTextSearch
      ? await searchPages(q, {
          ...(hasCategoryFilter ? { categoryId: selectedCategoryId } : {}),
          ...(parsedQuery ? { parsedQuery } : {})
        })
      : hasAnyFilter
        ? await listPagesForUser(request.currentUser, hasCategoryFilter ? { categoryId: selectedCategoryId } : undefined)
        : [];

    const accessibleResults = hasTextSearch ? await filterAccessiblePageSummaries(rawResults, request.currentUser) : rawResults;
    let results = hasTagFilter
      ? accessibleResults.filter((page) =>
          allActiveTags.every((tag) => page.tags.some((pageTag) => pageTag.toLowerCase() === tag))
        )
      : accessibleResults;

    if (hasAuthorFilter) {
      results = results.filter((page) => page.updatedBy.toLowerCase().includes(selectedAuthor));
    }

    if (hasScopeFilter) {
      results = results.filter((page) => {
        if (selectedScope === "public") return page.visibility === "all" && !page.encrypted;
        if (selectedScope === "restricted") return page.visibility === "restricted";
        if (selectedScope === "encrypted") return page.encrypted;
        if (selectedScope === "unencrypted") return !page.encrypted;
        return true;
      });
    }

    if (hasTimeframeFilter) {
      const now = Date.now();
      const ranges: Record<string, number> = {
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "30d": 30 * 24 * 60 * 60 * 1000,
        "365d": 365 * 24 * 60 * 60 * 1000
      };
      const rangeMs = ranges[selectedTimeframe] ?? 0;
      if (rangeMs > 0) {
        const cutoff = now - rangeMs;
        results = results.filter((page) => {
          const updatedAt = Date.parse(page.updatedAt);
          return Number.isFinite(updatedAt) && updatedAt >= cutoff;
        });
      }
    }

    const paged = paginate(results, pageNumber, 20);

    const baseParams = new URLSearchParams();
    if (q) baseParams.set("q", q);
    if (selectedCategoryId) baseParams.set("category", selectedCategoryId);
    if (activeTag) baseParams.set("tag", activeTag);
    if (selectedAuthor) baseParams.set("author", selectedAuthor);
    if (selectedTimeframe) baseParams.set("timeframe", selectedTimeframe);
    if (selectedScope && selectedScope !== "all") baseParams.set("scope", selectedScope);

    const headline = hasTextSearch
      ? hasTagFilter
        ? `Ergebnisse für <strong>${escapeHtml(q)}</strong> mit Tag <strong>#${escapeHtml(activeTag)}</strong>`
        : `Ergebnisse für <strong>${escapeHtml(q)}</strong>`
      : hasAnyFilter
        ? "Filterergebnisse"
        : q.length > 0
          ? "Bitte mindestens 2 Zeichen eingeben oder einen Filter ergänzen."
          : "Bitte Suchbegriff eingeben oder Filter auswählen.";

    const buildFilterRemovalUrl = (key: string): string => {
      const params = new URLSearchParams(baseParams);
      params.delete(key);
      return params.size > 0 ? `/search?${params.toString()}` : "/search";
    };

    const activeFilterBadges = [
      activeTag ? `<a class="tag-chip active-filter-badge" href="${escapeHtml(buildFilterRemovalUrl("tag"))}">#${escapeHtml(activeTag)} ×</a>` : "",
      selectedCategoryId
        ? `<a class="tag-chip active-filter-badge" href="${escapeHtml(buildFilterRemovalUrl("category"))}">Kategorie: ${escapeHtml(
            categories.find((entry) => entry.id === selectedCategoryId)?.name ?? selectedCategoryId
          )} ×</a>`
        : "",
      selectedAuthor ? `<a class="tag-chip active-filter-badge" href="${escapeHtml(buildFilterRemovalUrl("author"))}">Autor: ${escapeHtml(selectedAuthor)} ×</a>` : "",
      hasTimeframeFilter
        ? `<a class="tag-chip active-filter-badge" href="${escapeHtml(buildFilterRemovalUrl("timeframe"))}">Zeitraum: ${escapeHtml(
            selectedTimeframe
          )} ×</a>`
        : "",
      hasScopeFilter
        ? `<a class="tag-chip active-filter-badge" href="${escapeHtml(buildFilterRemovalUrl("scope"))}">Bereich: ${escapeHtml(selectedScope)} ×</a>`
        : ""
    ]
      .filter((entry) => entry.length > 0)
      .join("");

    const body = `
      <section class="content-wrap search-page-shell">
        <h1>Suche</h1>
        <form method="get" action="/search" class="dashboard-search-stack search-page-form" data-home-search>
          <div class="dashboard-search-form dashboard-search-form-google">
            <button
              type="button"
              class="dashboard-search-plus"
              data-home-search-toggle
              aria-controls="search-page-advanced"
              aria-expanded="false"
              aria-label="Erweiterte Filter aufklappen"
            >+</button>
            <div class="search-box dashboard-search-box" data-search-suggest>
              <label class="sr-only" for="search-main-q">Suchbegriff</label>
              <input
                id="search-main-q"
                type="search"
                name="q"
                value="${escapeHtml(q)}"
                placeholder="Suche in Artikeln, Tags, Autoren ..."
                autocomplete="off"
              />
              <div class="search-suggest" hidden></div>
            </div>
            <button type="submit" class="dashboard-search-go">Suchen</button>
          </div>
          <div class="dashboard-search-preview" data-home-search-preview aria-live="polite">
            <span class="muted-note small">Keine zusätzlichen Filter aktiv.</span>
          </div>
          <section id="search-page-advanced" class="dashboard-search-advanced" data-home-search-panel hidden>
            <div class="dashboard-search-advanced-grid">
              <label class="dashboard-advanced-field">Kategorie
                <select name="category">
                  <option value="">Alle Kategorien</option>
                  ${categories
                    .map(
                      (category) =>
                        `<option value="${escapeHtml(category.id)}" ${category.id === selectedCategoryId ? "selected" : ""}>${escapeHtml(
                          category.name
                        )}</option>`
                    )
                    .join("")}
                </select>
              </label>
              <label class="dashboard-advanced-field">Tag
                <input type="text" name="tag" value="${escapeHtml(activeTag)}" placeholder="z. B. howto" />
              </label>
              <label class="dashboard-advanced-field">Autor
                <input type="text" name="author" value="${escapeHtml(selectedAuthor)}" placeholder="Benutzername" />
              </label>
              <label class="dashboard-advanced-field">Zeitraum
                <select name="timeframe">
                  <option value="">Beliebig</option>
                  <option value="24h" ${selectedTimeframe === "24h" ? "selected" : ""}>Letzte 24 Stunden</option>
                  <option value="7d" ${selectedTimeframe === "7d" ? "selected" : ""}>Letzte 7 Tage</option>
                  <option value="30d" ${selectedTimeframe === "30d" ? "selected" : ""}>Letzte 30 Tage</option>
                  <option value="365d" ${selectedTimeframe === "365d" ? "selected" : ""}>Letzte 12 Monate</option>
                </select>
              </label>
              <label class="dashboard-advanced-field">Bereich
                <select name="scope">
                  <option value="all" ${selectedScope === "all" ? "selected" : ""}>Alle</option>
                  <option value="public" ${selectedScope === "public" ? "selected" : ""}>Öffentlich</option>
                  <option value="restricted" ${selectedScope === "restricted" ? "selected" : ""}>Eingeschränkt</option>
                  <option value="encrypted" ${selectedScope === "encrypted" ? "selected" : ""}>Verschlüsselt</option>
                  <option value="unencrypted" ${selectedScope === "unencrypted" ? "selected" : ""}>Unverschlüsselt</option>
                </select>
              </label>
            </div>
            <div class="action-row search-page-reset-row">
              <a class="button tiny ghost" href="/search">Zurücksetzen</a>
            </div>
          </section>
        </form>
        ${activeFilterBadges ? `<div class="search-active-filters">${activeFilterBadges}</div>` : ""}
        <p>${headline}</p>
        ${renderSearchResultList(paged.slice, {
          query: q,
          activeTag,
          selectedCategoryId,
          selectedAuthor,
          selectedTimeframe,
          selectedScope,
          hasAnyFilter
        })}
        ${renderPager("/search", paged.page, paged.totalPages, {
          q,
          category: selectedCategoryId,
          tag: activeTag,
          author: selectedAuthor,
          timeframe: selectedTimeframe,
          scope: selectedScope === "all" ? "" : selectedScope
        })}
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Suche",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        searchQuery: q,
        scripts: ["/home-search.js?v=5"]
      })
    );
  });

  app.get("/api/search/suggest", { preHandler: [requireAuthOrPublicRead], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const query = asObject(request.query);
    const q = readSingle(query.q).trim();
    const requestedLimit = Number.parseInt(readSingle(query.limit) || "8", 10);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 8;
    const categoryId = readSingle(query.category);

    if (q.length < 2) {
      return reply.send({ ok: true, suggestions: [] });
    }

    const suggestions = await suggestPages(q, limit, categoryId ? { categoryId } : undefined);
    const visibleSuggestions = (await filterAccessiblePageSummaries(suggestions, request.currentUser)).filter(
      (page) => page.securityProfile !== "confidential"
    );

    return reply.send({
      ok: true,
      suggestions: visibleSuggestions.map((page) => ({
        slug: page.slug,
        title: page.title,
        tags: page.tags,
        categoryName: page.categoryName,
        updatedAt: page.updatedAt,
        url: `/wiki/${encodeURIComponent(page.slug)}`
      }))
    });
  });

  app.get("/api/users/suggest", { preHandler: [requireAuth], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const query = asObject(request.query);
    const q = readSingle(query.q).trim().toLowerCase();
    const requestedLimit = Number.parseInt(readSingle(query.limit) || "6", 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 20) : 6;

    if (q.length < 2) {
      return reply.send({ ok: true, users: [] });
    }

    const users = (await listUsers())
      .filter((user) => !user.disabled)
      .filter((user) => user.username.toLowerCase().startsWith(q) || user.displayName.toLowerCase().startsWith(q))
      .slice(0, limit)
      .map((user) => ({
        username: user.username,
        displayName: user.displayName
      }));

    return reply.send({
      ok: true,
      users
    });
  });
};
