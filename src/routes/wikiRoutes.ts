import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { requireAdmin, requireAuth, requireAuthOrPublicRead, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import { findCategoryById, getDefaultCategory, listCategories } from "../lib/categoryStore.js";
import { listGroups } from "../lib/groupStore.js";
import { listTemplates } from "../lib/templateStore.js";
import { config } from "../config.js";
import { ensureDir } from "../lib/fileStore.js";
import { cleanupUnusedUploads, extractUploadReferencesFromMarkdown } from "../lib/mediaStore.js";
import { escapeHtml, formatDate, renderLayout, renderPageList } from "../lib/render.js";
import { getUiMode, type UiMode } from "../lib/runtimeSettingsStore.js";
import { removeSearchIndexBySlug, upsertSearchIndexBySlug } from "../lib/searchIndexStore.js";
import { buildUnifiedDiff } from "../lib/textDiff.js";
import { listUsers } from "../lib/userStore.js";
import type { SecurityProfile, WikiPageSummary } from "../types.js";
import {
  canUserAccessPage,
  deletePage,
  filterAccessiblePageSummaries,
  getCurrentPageRawContent,
  getPage,
  getPageVersionRawContent,
  isValidSlug,
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

const renderDashboardCategoryFilter = (
  categories: Array<{ id: string; name: string }>,
  selectedCategoryId: string
): string => `
  <form method="get" action="/" class="dashboard-filter-row">
    <label class="sr-only" for="dashboard-category-filter">Kategorie</label>
    <select id="dashboard-category-filter" name="category" class="tiny" onchange="this.form.submit()">
      <option value="">Alle Kategorien</option>
      ${categories
        .map(
          (category) =>
            `<option value="${escapeHtml(category.id)}" ${category.id === selectedCategoryId ? "selected" : ""}>${escapeHtml(category.name)}</option>`
        )
        .join("")}
    </select>
    ${selectedCategoryId ? '<a class="dashboard-reset-link" href="/">Zurücksetzen</a>' : ""}
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
  }
): string => {
  if (pages.length < 1) {
    return '<p class="empty">Keine passenden Ergebnisse gefunden.</p>';
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
    return '<p class="empty">Noch keine Artikel vorhanden.</p>';
  }

  return `
    <div class="dashboard-recent-list">
      ${pages
        .map(
          (page) => `
            <a class="dashboard-recent-item" href="/wiki/${encodeURIComponent(page.slug)}">
              <strong>${escapeHtml(page.title)}</strong>
              <span>${escapeHtml(page.categoryName)} • ${escapeHtml(formatDate(page.updatedAt))}</span>
            </a>
          `
        )
        .join("")}
    </div>
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

export const registerWikiRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
    const query = asObject(request.query);
    const selectedCategoryId = readSingle(query.category);
    const categoryFilter = selectedCategoryId ? { categoryId: selectedCategoryId } : undefined;
    const pages = await listPagesForUser(request.currentUser, categoryFilter);
    const templates = await listTemplates({ includeDisabled: false });
    const categories = await listCategories();
    const quickTemplateIds = ["idea", "documentation", "travel", "finance"];
    const templateMap = new Map(templates.map((template) => [template.id, template]));
    const quickTemplates = quickTemplateIds
      .map((id) => templateMap.get(id))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const recentPages = sortPagesByUpdatedAtDesc([...pages]).slice(0, 4);
    const showRecentOpen = selectedCategoryId.length > 0;

    const canWrite = Boolean(request.currentUser);
    const body = `
      <section class="dashboard-shell stack large">
        <section class="page-header">
          <div>
            <h1>Startseite</h1>
            <p>Schnell starten und aktuelle Inhalte direkt sehen.</p>
            ${renderDashboardCategoryFilter(categories, selectedCategoryId)}
          </div>
          <div class="action-row dashboard-primary-actions">
            <a class="button dashboard-toc-button" href="/toc">Inhaltsverzeichnis</a>
            ${canWrite ? '<a class="button secondary" href="/new">Neue Seite</a>' : '<a class="button secondary" href="/login">Anmelden zum Schreiben</a>'}
          </div>
        </section>

        ${
          canWrite
            ? `
              <section class="content-wrap stack">
                <h2>Schnellstart</h2>
                <div class="dashboard-quick-grid">
                  ${
                    quickTemplates.length > 0
                      ? quickTemplates
                          .map(
                            (template) => `
                              <a class="dashboard-tile" href="/new?template=${encodeURIComponent(template.id)}">
                                <strong>${escapeHtml(template.name)}</strong>
                                <span>${escapeHtml(template.description || "Direkt mit Vorlage starten.")}</span>
                              </a>
                            `
                          )
                          .join("")
                      : `
                        <a class="dashboard-tile" href="/new?template=idea"><strong>Idee</strong><span>Neue Ideen festhalten.</span></a>
                        <a class="dashboard-tile" href="/new?template=documentation"><strong>Dokumentation</strong><span>Anleitungen und Wissen strukturieren.</span></a>
                        <a class="dashboard-tile" href="/new?template=travel"><strong>Reisebericht</strong><span>Erlebnisse und Bilder sammeln.</span></a>
                        <a class="dashboard-tile" href="/new?template=finance"><strong>Finanznotiz</strong><span>Kritische Inhalte geschützt erfassen.</span></a>
                      `
                  }
                  <a class="dashboard-tile dashboard-tile-ghost" href="/new?template=blank">
                    <strong>Leer starten</strong>
                    <span>Freie Seite ohne Vorlage.</span>
                  </a>
                </div>
                <div class="action-row dashboard-link-actions">
                  <a class="button secondary" href="/toc">Vollständige Übersicht öffnen</a>
                </div>
              </section>
            `
            : ""
        }

        <section class="content-wrap stack">
          <details class="dashboard-activity-panel" ${showRecentOpen ? "open" : ""}>
            <summary>Letzte Änderungen (${recentPages.length})</summary>
            <div class="stack">
              ${renderRecentPages(recentPages)}
            </div>
          </details>
        </section>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Wiki",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: readSingle(query.notice),
        error: readSingle(query.error)
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
        title: "Inhaltsverzeichnis",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken
      })
    );
  });

  app.get("/wiki/:slug", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
    const params = request.params as { slug: string };
    const page = await getPage(params.slug);

    if (!page) {
      return reply
        .code(404)
        .type("text/html")
        .send(
          renderLayout({
            title: "Nicht gefunden",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Seite nicht gefunden</h1><p>Die angeforderte Wiki-Seite existiert nicht.</p></section>`
          })
        );
    }

    if (params.slug !== page.slug) {
      return reply.redirect(`/wiki/${encodeURIComponent(page.slug)}`);
    }

    if (!canUserAccessPage(page, request.currentUser)) {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderLayout({
            title: "Kein Zugriff",
            user: request.currentUser,
            csrfToken: request.csrfToken,
            body: `<section class="content-wrap"><h1>Kein Zugriff</h1><p>Du hast keine Berechtigung für diesen Artikel.</p></section>`
          })
        );
    }

    const articleToc = renderArticleToc(page.slug, page.tableOfContents);
    const backlinks = await listPageBacklinks(page.slug, request.currentUser);
    const body = `
      <article class="wiki-page ${articleToc ? "article-layout" : ""}">
        ${articleToc}
        <div class="article-main">
          <header>
            <h1>${escapeHtml(page.title)}</h1>
            <p class="meta">Kategorie: ${escapeHtml(page.categoryName)} | Profil: ${escapeHtml(
              formatSecurityProfileLabel(page.securityProfile)
            )} | Zugriff: ${
              page.visibility === "restricted" ? "eingeschränkt" : "alle"
            } | ${page.encrypted ? "Verschlüsselt" : "Unverschlüsselt"} | Integrität: ${
              page.integrityState === "valid"
                ? "geprüft"
                : page.integrityState === "legacy"
                  ? "legacy"
                  : page.integrityState === "unverifiable"
                    ? "nicht prüfbar"
                    : "fehlerhaft"
            }</p>
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
                  ? `<a class="button secondary" href="/wiki/${encodeURIComponent(page.slug)}/edit">Bearbeiten</a>`
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
        </div>
      </article>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: page.title,
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(asObject(request.query).error),
        scripts: articleToc ? ["/article-toc.js?v=1"] : undefined
      })
    );
  });

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
        title: "Neue Seite",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(query.error),
        scripts: ["/wiki-ui.js?v=13"]
      })
    );
  });

  app.post("/new", { preHandler: [requireAuth] }, async (request, reply) => {
    const body = asObject(request.body);
    const uiMode = getUiMode();
    const token = readSingle(body._csrf);
    if (!verifySessionCsrfToken(request, token)) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

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
    const page = await getPage(params.slug);

    if (!page) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
    }

    if (params.slug !== page.slug) {
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
      showSensitiveProfileOption
    });

    return reply.type("text/html").send(
      renderLayout({
        title: `Bearbeiten: ${page.title}`,
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(query.error),
        scripts: ["/wiki-ui.js?v=13"]
      })
    );
  });

  app.post("/api/uploads", { preHandler: [requireAuth] }, async (request, reply) => {
    const csrfToken = request.headers["x-csrf-token"];
    const csrfValue = Array.isArray(csrfToken) ? csrfToken[0] ?? "" : csrfToken ?? "";
    const query = asObject(request.query);
    const selectedCategoryId = readSingle(query.categoryId);
    const pageSlug = readSingle(query.slug).trim().toLowerCase();
    const securityProfileContext = normalizeSecurityProfileValue(readSingle(query.securityProfile));
    const encryptedContext = ["1", "true", "on"].includes(readSingle(query.encrypted).trim().toLowerCase());
    const category = (await findCategoryById(selectedCategoryId)) ?? (await getDefaultCategory());
    const uploadSubDir = category.uploadFolder.trim() || "allgemein";
    const uploadTargetDir = path.join(config.uploadDir, uploadSubDir);

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
        const targetPath = path.join(uploadTargetDir, storedName);

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

  app.post("/api/markdown/preview", { preHandler: [requireAuth] }, async (request, reply) => {
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

  app.post("/wiki/:slug/edit", { preHandler: [requireAuth] }, async (request, reply) => {
    const params = request.params as { slug: string };
    const body = asObject(request.body);
    const uiMode = getUiMode();

    if (!verifySessionCsrfToken(request, readSingle(body._csrf))) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const existing = await getPage(params.slug);
    if (!existing) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
    }

    if (!canUserAccessPage(existing, request.currentUser)) {
      return reply.redirect("/?error=Kein+Zugriff");
    }

    if (existing.integrityState === "invalid") {
      return reply.redirect(`/wiki/${encodeURIComponent(params.slug)}?error=Integrit%C3%A4tspr%C3%BCfung+fehlgeschlagen`);
    }

    if (existing.integrityState === "unverifiable") {
      return reply.redirect(`/wiki/${encodeURIComponent(params.slug)}?error=Integrit%C3%A4tspr%C3%BCfung+nicht+m%C3%B6glich`);
    }

    if (existing.encrypted && existing.encryptionState !== "ok") {
      return reply.redirect(`/wiki/${encodeURIComponent(params.slug)}?error=Verschl%C3%BCsselter+Inhalt+konnte+nicht+entschl%C3%BCsselt+werden`);
    }

    const title = readSingle(body.title).trim();
    const tagsRaw = readSingle(body.tags);
    const tags = tagsRaw
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const content = readSingle(body.content);

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

      return reply.redirect(`/wiki/${encodeURIComponent(params.slug)}/edit?${query}`);
    }

    const result = await savePage({
      slug: params.slug,
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

      return reply.redirect(`/wiki/${encodeURIComponent(params.slug)}/edit?${query}`);
    }

    const updateIndexResult = await upsertSearchIndexBySlug(params.slug);
    if (!updateIndexResult.updated && updateIndexResult.reason && updateIndexResult.reason !== "rebuild_running") {
      request.log.warn(
        { slug: params.slug, reason: updateIndexResult.reason },
        "Konnte Suchindex für bearbeitete Seite nicht inkrementell aktualisieren"
      );
    }

    await writeAuditLog({
      action: "wiki_page_updated",
      actorId: request.currentUser?.id,
      targetId: params.slug
    });

    return reply.redirect(`/wiki/${encodeURIComponent(params.slug)}`);
  });

  app.get("/wiki/:slug/history", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
    const params = request.params as { slug: string };
    const normalizedSlug = params.slug.trim().toLowerCase();
    const page = await getPage(normalizedSlug);
    const versions = await listPageHistory(normalizedSlug, 250);

    if (!page && versions.length < 1) {
      return reply
        .code(404)
        .type("text/html")
        .send(
          renderLayout({
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
    const normalizedSlug = params.slug.trim().toLowerCase();
    const page = await getPage(normalizedSlug);

    if (page && !canUserAccessPage(page, request.currentUser)) {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderLayout({
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
    const normalizedSlug = params.slug.trim().toLowerCase();
    const page = await getPage(normalizedSlug);

    if (page && !canUserAccessPage(page, request.currentUser)) {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderLayout({
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
        title: "Versions-Diff",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(query.error),
        notice: readSingle(query.notice)
      })
    );
  });

  app.post("/wiki/:slug/history/:versionId/restore", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { slug: string; versionId: string };
    const body = asObject(request.body);

    if (!verifySessionCsrfToken(request, readSingle(body._csrf))) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const restoreResult = await restorePageVersion({
      slug: params.slug,
      versionId: params.versionId,
      restoredBy: request.currentUser?.username ?? "unknown"
    });
    if (!restoreResult.ok) {
      return reply.redirect(
        `/wiki/${encodeURIComponent(params.slug)}/history?error=${encodeURIComponent(restoreResult.error ?? "Restore fehlgeschlagen")}`
      );
    }

    const updateIndexResult = await upsertSearchIndexBySlug(params.slug);
    if (!updateIndexResult.updated && updateIndexResult.reason && updateIndexResult.reason !== "rebuild_running") {
      request.log.warn(
        { slug: params.slug, reason: updateIndexResult.reason },
        "Konnte Suchindex nach Restore nicht inkrementell aktualisieren"
      );
    }

    await writeAuditLog({
      action: "wiki_page_restored",
      actorId: request.currentUser?.id,
      targetId: params.slug,
      details: {
        versionId: params.versionId
      }
    });

    return reply.redirect(`/wiki/${encodeURIComponent(params.slug)}?notice=${encodeURIComponent("Version wiederhergestellt")}`);
  });

  app.post("/wiki/:slug/delete", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { slug: string };
    const body = asObject(request.body);

    if (!verifySessionCsrfToken(request, readSingle(body._csrf))) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const page = await getPage(params.slug);
    if (!page) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
    }

    const candidateUploads = extractUploadReferencesFromMarkdown(page.content);
    const deleteResult = await deletePage(params.slug, {
      deletedBy: request.currentUser?.username ?? "unknown"
    });
    if (!deleteResult.ok) {
      return reply.redirect(`/?error=${encodeURIComponent(deleteResult.error ?? "Löschen fehlgeschlagen")}`);
    }

    if (!deleteResult.deleted) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
    }

    const deleteIndexResult = await removeSearchIndexBySlug(params.slug);
    if (!deleteIndexResult.updated && deleteIndexResult.reason && deleteIndexResult.reason !== "index_missing") {
      request.log.warn(
        { slug: params.slug, reason: deleteIndexResult.reason },
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
        request.log.warn({ error, slug: params.slug }, "Upload-Cleanup nach Seitenlöschung fehlgeschlagen");
      }
    }

    await writeAuditLog({
      action: "wiki_page_deleted",
      actorId: request.currentUser?.id,
      targetId: params.slug,
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

  app.get("/search", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
    const query = asObject(request.query);
    const q = readSingle(query.q).trim();
    const activeTag = normalizeTagFilter(readSingle(query.tag));
    const selectedCategoryId = readSingle(query.category);
    const selectedAuthor = readSingle(query.author).trim().toLowerCase();
    const selectedTimeframe = readSingle(query.timeframe).trim().toLowerCase();
    const selectedScope = readSingle(query.scope).trim().toLowerCase() || "all";
    const pageNumber = parsePageNumber(readSingle(query.page));
    const categories = await listCategories();

    const hasTextSearch = q.length >= 2;
    const hasTagFilter = activeTag.length > 0;
    const hasAuthorFilter = selectedAuthor.length > 0;
    const hasScopeFilter = selectedScope !== "all";
    const hasTimeframeFilter = ["24h", "7d", "30d", "365d"].includes(selectedTimeframe);
    const hasCategoryFilter = selectedCategoryId.length > 0;
    const hasAnyFilter = hasTagFilter || hasAuthorFilter || hasScopeFilter || hasTimeframeFilter || hasCategoryFilter;

    const rawResults = hasTextSearch
      ? await searchPages(q, hasCategoryFilter ? { categoryId: selectedCategoryId } : undefined)
      : hasAnyFilter
        ? await listPagesForUser(request.currentUser, hasCategoryFilter ? { categoryId: selectedCategoryId } : undefined)
        : [];

    const accessibleResults = hasTextSearch ? await filterAccessiblePageSummaries(rawResults, request.currentUser) : rawResults;
    let results = hasTagFilter
      ? accessibleResults.filter((page) => page.tags.some((tag) => tag.toLowerCase() === activeTag))
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
      <section class="content-wrap">
        <h1>Suche</h1>
        <form method="get" action="/search" class="stack search-filter-form">
          <div class="action-row">
            <label class="sr-only" for="search-main-q">Suchbegriff</label>
            <input id="search-main-q" type="search" name="q" value="${escapeHtml(q)}" placeholder="Suchbegriff" />
            <button type="submit">Suchen</button>
          </div>
          <div class="search-filter-grid">
            <label>Kategorie
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
            <label>Tag
              <input type="text" name="tag" value="${escapeHtml(activeTag)}" placeholder="z. B. howto" />
            </label>
            <label>Autor
              <input type="text" name="author" value="${escapeHtml(selectedAuthor)}" placeholder="Benutzername" />
            </label>
            <label>Zeitraum
              <select name="timeframe">
                <option value="">Beliebig</option>
                <option value="24h" ${selectedTimeframe === "24h" ? "selected" : ""}>Letzte 24 Stunden</option>
                <option value="7d" ${selectedTimeframe === "7d" ? "selected" : ""}>Letzte 7 Tage</option>
                <option value="30d" ${selectedTimeframe === "30d" ? "selected" : ""}>Letzte 30 Tage</option>
                <option value="365d" ${selectedTimeframe === "365d" ? "selected" : ""}>Letzte 12 Monate</option>
              </select>
            </label>
            <label>Bereich
              <select name="scope">
                <option value="all" ${selectedScope === "all" ? "selected" : ""}>Alle</option>
                <option value="public" ${selectedScope === "public" ? "selected" : ""}>Öffentlich</option>
                <option value="restricted" ${selectedScope === "restricted" ? "selected" : ""}>Eingeschränkt</option>
                <option value="encrypted" ${selectedScope === "encrypted" ? "selected" : ""}>Verschlüsselt</option>
                <option value="unencrypted" ${selectedScope === "unencrypted" ? "selected" : ""}>Unverschlüsselt</option>
              </select>
            </label>
          </div>
          <div class="action-row">
            <button type="submit" class="secondary">Filter anwenden</button>
            <a class="button tiny ghost" href="/search">Zurücksetzen</a>
          </div>
        </form>
        ${activeFilterBadges ? `<div class="search-active-filters">${activeFilterBadges}</div>` : ""}
        <p>${headline}</p>
        ${renderSearchResultList(paged.slice, {
          query: q,
          activeTag,
          selectedCategoryId,
          selectedAuthor,
          selectedTimeframe,
          selectedScope
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
        title: "Suche",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        searchQuery: q
      })
    );
  });

  app.get("/api/search/suggest", { preHandler: [requireAuthOrPublicRead] }, async (request, reply) => {
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
};
