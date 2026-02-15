import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { requireAdmin, requireAuth, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import { findCategoryById, getDefaultCategory, listCategories } from "../lib/categoryStore.js";
import { config } from "../config.js";
import { ensureDir } from "../lib/fileStore.js";
import { cleanupUnusedUploads, extractUploadReferencesFromMarkdown } from "../lib/mediaStore.js";
import { escapeHtml, formatDate, renderLayout, renderPageList } from "../lib/render.js";
import { listUsers } from "../lib/userStore.js";
import {
  canUserAccessPage,
  deletePage,
  filterAccessiblePageSummaries,
  getPage,
  isValidSlug,
  listPagesForUser,
  renderMarkdownPreview,
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

const sortPagesByTitle = <T extends { title: string }>(pages: T[]): T[] =>
  pages.sort((a, b) => a.title.localeCompare(b.title, "de", { sensitivity: "base" }));

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
  queryText?: string
): string => `
  <form method="get" action="${escapeHtml(actionPath)}" class="action-row">
    ${
      queryText !== undefined
        ? `<input type="search" name="q" value="${escapeHtml(queryText)}" placeholder="Suchbegriff" class="tiny" />`
        : ""
    }
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

const renderEditorForm = (params: {
  mode: "new" | "edit";
  action: string;
  slug: string;
  title: string;
  tags: string;
  content: string;
  csrfToken: string;
  slugLocked?: boolean;
  categories: Array<{ id: string; name: string }>;
  selectedCategoryId: string;
  visibility: "all" | "restricted";
  allowedUsers: string[];
  availableUsers: Array<{ username: string; displayName: string }>;
  encrypted: boolean;
  encryptionAvailable: boolean;
}): string => `
  <section class="content-wrap editor-shell" data-preview-endpoint="/api/markdown/preview" data-csrf="${escapeHtml(params.csrfToken)}">
    <h1>${params.mode === "new" ? "Neue Seite" : "Seite bearbeiten"}</h1>
    <div class="editor-grid">
      <form method="post" action="${escapeHtml(params.action)}" class="stack large">
        <input type="hidden" name="_csrf" value="${escapeHtml(params.csrfToken)}" />
        <label>Titel
          <input type="text" name="title" value="${escapeHtml(params.title)}" required minlength="2" maxlength="120" />
        </label>
        <label>Slug
          <input type="text" name="slug" value="${escapeHtml(params.slug)}" ${params.slugLocked ? "readonly" : ""} required pattern="[a-z0-9-]{1,80}" />
        </label>
        <label>Kategorie
          <select name="categoryId" required>
            ${params.categories
              .map(
                (category) =>
                  `<option value="${escapeHtml(category.id)}" ${category.id === params.selectedCategoryId ? "selected" : ""}>${escapeHtml(category.name)}</option>`
              )
              .join("")}
          </select>
        </label>
        <label>Zugriff
          <select name="visibility">
            <option value="all" ${params.visibility === "all" ? "selected" : ""}>Alle angemeldeten Benutzer</option>
            <option value="restricted" ${params.visibility === "restricted" ? "selected" : ""}>Nur ausgewählte Benutzer</option>
          </select>
        </label>
        <fieldset class="stack access-user-picker" data-allowed-users-box ${params.visibility === "restricted" ? "" : "hidden"}>
          <legend>Freigegebene Benutzer (bei eingeschränktem Zugriff)</legend>
          <div class="picker-toolbar">
            <input
              type="search"
              class="tiny"
              placeholder="Benutzer filtern (Name oder Username)"
              data-allowed-users-filter
              autocomplete="off"
            />
            <span class="muted-note small" data-allowed-users-count></span>
          </div>
          <div class="stack allowed-users-list" data-allowed-users-list>
            ${
              params.availableUsers.length > 0
                ? params.availableUsers
                    .map((user) => {
                      const checked = params.allowedUsers.includes(user.username) ? "checked" : "";
                      const searchData = `${user.displayName} ${user.username}`;
                      return `<label class="checkline user-checkline" data-user-search="${escapeHtml(searchData.toLowerCase())}"><input type="checkbox" name="allowedUsers" value="${escapeHtml(user.username)}" ${checked} /> <span>${escapeHtml(user.displayName)} (${escapeHtml(user.username)})</span></label>`;
                    })
                    .join("")
                : '<p class="muted-note">Keine Benutzer verfügbar.</p>'
            }
          </div>
        </fieldset>
        <label class="checkline"><input type="checkbox" name="encrypted" value="1" ${params.encrypted ? "checked" : ""} ${
          params.encryptionAvailable ? "" : "disabled"
        } /> <span>Inhalt im Dateisystem verschlüsseln (AES-256)</span></label>
        ${
          params.encryptionAvailable
            ? ""
            : '<p class="muted-note small">Verschlüsselung ist derzeit nicht aktiv. Setze CONTENT_ENCRYPTION_KEY in config.env.</p>'
        }
        <label>Tags (kommagetrennt)
          <input type="text" name="tags" value="${escapeHtml(params.tags)}" />
        </label>
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
        <form method="post" enctype="multipart/form-data" class="stack image-upload-form" data-upload-endpoint="/api/uploads" data-csrf="${escapeHtml(
          params.csrfToken
        )}">
          <label>Bilder auswählen
            <input type="file" name="images" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple required />
          </label>
          <button type="submit" class="secondary">Bilder hochladen</button>
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
  visibility: "all" | "restricted";
  allowedUsers: string[];
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
  query.set("visibility", params.visibility);
  query.set("allowedUsers", params.allowedUsers.join(","));
  query.set("encrypted", params.encrypted ? "1" : "0");
  return query.toString();
};

export const registerWikiRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = asObject(request.query);
    const selectedCategoryId = readSingle(query.category);
    const categoryFilter = selectedCategoryId ? { categoryId: selectedCategoryId } : undefined;
    const pages = await listPagesForUser(request.currentUser, categoryFilter);
    const pageNumber = parsePageNumber(readSingle(query.page));
    const paged = paginate(pages, pageNumber, 24);
    const categories = await listCategories();

    const body = `
      <section class="page-header">
        <div>
          <h1>Wiki-Übersicht</h1>
          <p>Alle Inhalte sind als Markdown-Dateien gespeichert.</p>
          ${renderCategoryFilter("/", categories, selectedCategoryId)}
        </div>
        <div class="action-row">
          <a class="button secondary" href="/toc">Inhaltsverzeichnis</a>
          <a class="button" href="/new">Neue Seite</a>
        </div>
      </section>
      ${renderPageList(paged.slice)}
      ${renderPager("/", paged.page, paged.totalPages, {
        category: selectedCategoryId
      })}
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

  app.get("/toc", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = asObject(request.query);
    const selectedCategoryId = readSingle(query.category);
    const categoryFilter = selectedCategoryId ? { categoryId: selectedCategoryId } : undefined;
    const pages = await listPagesForUser(request.currentUser, categoryFilter);
    const pageNumber = parsePageNumber(readSingle(query.page));
    const paged = paginate(pages, pageNumber, 90);
    const groupedPages = groupPagesByInitial(paged.slice);
    const categories = await listCategories();

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
          <a class="button" href="/new">Neue Seite</a>
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

  app.get("/wiki/:slug", { preHandler: [requireAuth] }, async (request, reply) => {
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
    const body = `
      <article class="wiki-page ${articleToc ? "article-layout" : ""}">
        ${articleToc}
        <div class="article-main">
          <header>
            <h1>${escapeHtml(page.title)}</h1>
            <p class="meta">Kategorie: ${escapeHtml(page.categoryName)} | Zugriff: ${
              page.visibility === "restricted" ? "eingeschränkt" : "alle"
            } | ${page.encrypted ? "Verschlüsselt" : "Unverschlüsselt"}</p>
            <p class="meta">Zuletzt geändert: ${escapeHtml(page.updatedAt)} | von ${escapeHtml(page.updatedBy)}</p>
            <div class="actions">
              <a class="button secondary" href="/wiki/${encodeURIComponent(page.slug)}/edit">Bearbeiten</a>
              ${
                request.currentUser?.role === "admin"
                  ? `<form method="post" action="/wiki/${encodeURIComponent(page.slug)}/delete" onsubmit="return confirm('Seite wirklich löschen?')"><input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" /><button class="danger" type="submit">Löschen</button></form>`
                  : ""
              }
            </div>
          </header>
          <section class="wiki-content">${page.html}</section>
        </div>
      </article>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: page.title,
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(asObject(request.query).error)
      })
    );
  });

  app.get("/new", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = asObject(request.query);
    const categories = await listCategories();
    const defaultCategory = await getDefaultCategory();
    const users = (await listUsers())
      .filter((user) => !user.disabled)
      .map((user) => ({ username: user.username, displayName: user.displayName }));

    const draftTitle = readSingle(query.title);
    const draftSlug = readSingle(query.slug) || slugifyTitle(draftTitle);
    const draftTags = readSingle(query.tags);
    const draftContent = readSingle(query.content);
    const selectedCategoryId = readSingle(query.categoryId) || defaultCategory.id;
    const visibility = readSingle(query.visibility) === "restricted" ? "restricted" : "all";
    const allowedUsers = normalizeUsernames(readMany(query.allowedUsers));
    const encrypted = readSingle(query.encrypted) === "1";

    const body = renderEditorForm({
      mode: "new",
      action: "/new",
      slug: draftSlug,
      title: draftTitle,
      tags: draftTags,
      content: draftContent,
      csrfToken: request.csrfToken ?? "",
      categories: categories.map((entry) => ({ id: entry.id, name: entry.name })),
      selectedCategoryId,
      visibility,
      allowedUsers,
      availableUsers: users,
      encrypted,
      encryptionAvailable: Boolean(config.contentEncryptionKey)
    });

    return reply.type("text/html").send(
      renderLayout({
        title: "Neue Seite",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(query.error),
        scripts: ["/wiki-ui.js?v=6"]
      })
    );
  });

  app.post("/new", { preHandler: [requireAuth] }, async (request, reply) => {
    const body = asObject(request.body);
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

    const visibility = readSingle(body.visibility) === "restricted" ? "restricted" : "all";
    const selectedCategoryId = readSingle(body.categoryId);
    const encrypted = readSingle(body.encrypted) === "1" || readSingle(body.encrypted) === "on";

    const knownUsernames = new Set((await listUsers()).filter((user) => !user.disabled).map((user) => user.username.toLowerCase()));

    const allowedUsersInput = normalizeUsernames(readMany(body.allowedUsers));
    const allowedUsers = allowedUsersInput.filter((username) => knownUsernames.has(username));

    if (visibility === "restricted" && request.currentUser?.username) {
      const own = request.currentUser.username.toLowerCase();
      if (!allowedUsers.includes(own)) {
        allowedUsers.push(own);
      }
    }

    if (!isValidSlug(slug)) {
      const query = buildEditorRedirectQuery({
        error: "Ungültiger Slug",
        title,
        slug,
        tags: tagsRaw,
        content,
        categoryId: selectedCategoryId,
        visibility,
        allowedUsers,
        encrypted
      });
      return reply.redirect(`/new?${query}`);
    }

    const existing = await getPage(slug);
    if (existing) {
      const query = buildEditorRedirectQuery({
        error: "Slug existiert bereits",
        title,
        slug,
        tags: tagsRaw,
        content,
        categoryId: selectedCategoryId,
        visibility,
        allowedUsers,
        encrypted
      });
      return reply.redirect(`/new?${query}`);
    }

    const result = await savePage({
      slug,
      title,
      categoryId: selectedCategoryId,
      visibility,
      allowedUsers,
      encrypted,
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
        visibility,
        allowedUsers,
        encrypted
      });
      return reply.redirect(`/new?${query}`);
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

    if (page.encrypted && page.encryptionState !== "ok") {
      return reply.redirect(`/wiki/${encodeURIComponent(page.slug)}?error=Verschl%C3%BCsselter+Inhalt+konnte+nicht+entschl%C3%BCsselt+werden`);
    }

    const categories = await listCategories();
    const users = (await listUsers())
      .filter((user) => !user.disabled)
      .map((user) => ({ username: user.username, displayName: user.displayName }));

    const query = asObject(request.query);
    const title = readSingle(query.title) || page.title;
    const tags = readSingle(query.tags) || page.tags.join(", ");
    const content = readSingle(query.content) || page.content;
    const selectedCategoryId = readSingle(query.categoryId) || page.categoryId;
    const visibility = readSingle(query.visibility) === "restricted" ? "restricted" : page.visibility;
    const allowedUsers = normalizeUsernames(readMany(query.allowedUsers).length > 0 ? readMany(query.allowedUsers) : page.allowedUsers);
    const encrypted = readSingle(query.encrypted) ? readSingle(query.encrypted) === "1" : page.encrypted;

    const body = renderEditorForm({
      mode: "edit",
      action: `/wiki/${encodeURIComponent(page.slug)}/edit`,
      slug: page.slug,
      title,
      tags,
      content,
      csrfToken: request.csrfToken ?? "",
      slugLocked: true,
      categories: categories.map((entry) => ({ id: entry.id, name: entry.name })),
      selectedCategoryId,
      visibility,
      allowedUsers,
      availableUsers: users,
      encrypted,
      encryptionAvailable: Boolean(config.contentEncryptionKey)
    });

    return reply.type("text/html").send(
      renderLayout({
        title: `Bearbeiten: ${page.title}`,
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: readSingle(query.error),
        scripts: ["/wiki-ui.js?v=6"]
      })
    );
  });

  app.post("/api/uploads", { preHandler: [requireAuth] }, async (request, reply) => {
    const csrfToken = request.headers["x-csrf-token"];
    const csrfValue = Array.isArray(csrfToken) ? csrfToken[0] ?? "" : csrfToken ?? "";
    const query = asObject(request.query);
    const selectedCategoryId = readSingle(query.categoryId);
    const category = (await findCategoryById(selectedCategoryId)) ?? (await getDefaultCategory());
    const uploadSubDir = category.uploadFolder.trim() || "allgemein";
    const uploadTargetDir = path.join(config.uploadDir, uploadSubDir);

    if (!verifySessionCsrfToken(request, csrfValue)) {
      return reply.code(400).send({ ok: false, error: "Ungültiges CSRF-Token." });
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
    const visibility = readSingle(body.visibility) === "restricted" ? "restricted" : "all";
    const encrypted = readSingle(body.encrypted) === "1" || readSingle(body.encrypted) === "on";

    const knownUsernames = new Set((await listUsers()).filter((user) => !user.disabled).map((user) => user.username.toLowerCase()));

    const allowedUsersInput = normalizeUsernames(readMany(body.allowedUsers));
    const allowedUsers = allowedUsersInput.filter((username) => knownUsernames.has(username));

    if (visibility === "restricted" && request.currentUser?.username) {
      const own = request.currentUser.username.toLowerCase();
      if (!allowedUsers.includes(own)) {
        allowedUsers.push(own);
      }
    }

    const result = await savePage({
      slug: params.slug,
      title,
      categoryId: selectedCategoryId,
      visibility,
      allowedUsers,
      encrypted,
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
        visibility,
        allowedUsers,
        encrypted
      });

      return reply.redirect(`/wiki/${encodeURIComponent(params.slug)}/edit?${query}`);
    }

    await writeAuditLog({
      action: "wiki_page_updated",
      actorId: request.currentUser?.id,
      targetId: params.slug
    });

    return reply.redirect(`/wiki/${encodeURIComponent(params.slug)}`);
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
    const deleted = await deletePage(params.slug);
    if (!deleted) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
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

  app.get("/search", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = asObject(request.query);
    const q = readSingle(query.q).trim();
    const selectedCategoryId = readSingle(query.category);
    const pageNumber = parsePageNumber(readSingle(query.page));
    const categories = await listCategories();

    const rawResults =
      q.length >= 2 ? await searchPages(q, selectedCategoryId ? { categoryId: selectedCategoryId } : undefined) : [];
    const results = await filterAccessiblePageSummaries(rawResults, request.currentUser);
    const paged = paginate(results, pageNumber, 20);

    const body = `
      <section class="content-wrap">
        <h1>Suche</h1>
        ${renderCategoryFilter("/search", categories, selectedCategoryId, q)}
        <p>${q ? `Ergebnisse für <strong>${escapeHtml(q)}</strong>` : "Bitte Suchbegriff eingeben."}</p>
        ${renderPageList(paged.slice)}
        ${renderPager("/search", paged.page, paged.totalPages, {
          q,
          category: selectedCategoryId
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

  app.get("/api/search/suggest", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = asObject(request.query);
    const q = readSingle(query.q).trim();
    const requestedLimit = Number.parseInt(readSingle(query.limit) || "8", 10);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 8;
    const categoryId = readSingle(query.category);

    if (q.length < 2) {
      return reply.send({ ok: true, suggestions: [] });
    }

    const suggestions = await suggestPages(q, limit, categoryId ? { categoryId } : undefined);
    const visibleSuggestions = await filterAccessiblePageSummaries(suggestions, request.currentUser);

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
