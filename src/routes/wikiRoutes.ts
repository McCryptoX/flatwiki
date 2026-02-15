import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { requireAdmin, requireAuth, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import { config } from "../config.js";
import { cleanupUnusedUploads, extractUploadReferencesFromMarkdown } from "../lib/mediaStore.js";
import { escapeHtml, formatDate, renderLayout, renderPageList } from "../lib/render.js";
import {
  deletePage,
  getPage,
  isValidSlug,
  listPages,
  renderMarkdownPreview,
  savePage,
  searchPages,
  slugifyTitle,
  suggestPages
} from "../lib/wikiStore.js";

const asRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, string>;
};

const sortPagesByTitle = <T extends { title: string }>(pages: T[]): T[] =>
  pages.sort((a, b) => a.title.localeCompare(b.title, "de", { sensitivity: "base" }));

const groupPagesByInitial = (pages: Awaited<ReturnType<typeof listPages>>): Array<{ key: string; pages: typeof pages }> => {
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
                <a href="/wiki/${escapeHtml(slug)}#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>
              </li>
            `
          )
          .join("")}
      </ul>
    </aside>
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

export const registerWikiRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/", { preHandler: [requireAuth] }, async (request, reply) => {
    const pages = await listPages();
    const query = asRecord(request.query);

    const body = `
      <section class="page-header">
        <div>
          <h1>Wiki-Übersicht</h1>
          <p>Alle Inhalte sind als Markdown-Dateien gespeichert.</p>
        </div>
        <div class="action-row">
          <a class="button secondary" href="/toc">Inhaltsverzeichnis</a>
          <a class="button" href="/new">Neue Seite</a>
        </div>
      </section>
      ${renderPageList(pages)}
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Wiki",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.get("/toc", { preHandler: [requireAuth] }, async (request, reply) => {
    const pages = await listPages();
    const groupedPages = groupPagesByInitial(pages);

    const body = `
      <section class="content-wrap toc-shell">
        <div class="page-header">
          <div>
            <h1>Inhaltsverzeichnis</h1>
            <p>${pages.length} Einträge im Wiki</p>
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
                            <a href="/wiki/${escapeHtml(page.slug)}">${escapeHtml(page.title)}</a>
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

    const articleToc = renderArticleToc(page.slug, page.tableOfContents);
    const body = `
      <article class="wiki-page ${articleToc ? "article-layout" : ""}">
        ${articleToc}
        <div class="article-main">
          <header>
            <h1>${escapeHtml(page.title)}</h1>
            <p class="meta">Zuletzt geändert: ${escapeHtml(page.updatedAt)} | von ${escapeHtml(page.updatedBy)}</p>
            <div class="actions">
              <a class="button secondary" href="/wiki/${escapeHtml(page.slug)}/edit">Bearbeiten</a>
              ${
                request.currentUser?.role === "admin"
                  ? `<form method="post" action="/wiki/${escapeHtml(page.slug)}/delete" onsubmit="return confirm('Seite wirklich löschen?')"><input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" /><button class="danger" type="submit">Löschen</button></form>`
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
        csrfToken: request.csrfToken
      })
    );
  });

  app.get("/new", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = asRecord(request.query);
    const draftTitle = query.title ?? "";
    const draftSlug = query.slug ?? slugifyTitle(draftTitle);
    const draftTags = query.tags ?? "";
    const draftContent = query.content ?? "";

    const body = renderEditorForm({
      mode: "new",
      action: "/new",
      slug: draftSlug,
      title: draftTitle,
      tags: draftTags,
      content: draftContent,
      csrfToken: request.csrfToken ?? ""
    });

    return reply.type("text/html").send(
      renderLayout({
        title: "Neue Seite",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: query.error,
        scripts: ["/wiki-ui.js?v=3"]
      })
    );
  });

  app.post("/new", { preHandler: [requireAuth] }, async (request, reply) => {
    const body = asRecord(request.body);
    const token = body._csrf ?? "";
    if (!verifySessionCsrfToken(request, token)) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const title = (body.title ?? "").trim();
    const slug = ((body.slug ?? "").trim() || slugifyTitle(title)).toLowerCase();
    const tags = (body.tags ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);

    const content = body.content ?? "";

    if (!isValidSlug(slug)) {
      return reply.redirect(`/new?error=${encodeURIComponent("Ungültiger Slug")}&title=${encodeURIComponent(title)}&slug=${encodeURIComponent(slug)}&tags=${encodeURIComponent(body.tags ?? "")}&content=${encodeURIComponent(content)}`);
    }

    const existing = await getPage(slug);
    if (existing) {
      return reply.redirect(`/new?error=${encodeURIComponent("Slug existiert bereits")}&title=${encodeURIComponent(title)}&slug=${encodeURIComponent(slug)}&tags=${encodeURIComponent(body.tags ?? "")}&content=${encodeURIComponent(content)}`);
    }

    const result = await savePage({
      slug,
      title,
      tags,
      content,
      updatedBy: request.currentUser?.username ?? "unknown"
    });

    if (!result.ok) {
      return reply.redirect(`/new?error=${encodeURIComponent(result.error ?? "Speichern fehlgeschlagen")}`);
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

    const query = asRecord(request.query);
    const title = query.title ?? page.title;
    const tags = query.tags ?? page.tags.join(", ");
    const content = query.content ?? page.content;

    const body = renderEditorForm({
      mode: "edit",
      action: `/wiki/${encodeURIComponent(page.slug)}/edit`,
      slug: page.slug,
      title,
      tags,
      content,
      csrfToken: request.csrfToken ?? "",
      slugLocked: true
    });

    return reply.type("text/html").send(
      renderLayout({
        title: `Bearbeiten: ${page.title}`,
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: query.error,
        scripts: ["/wiki-ui.js?v=3"]
      })
    );
  });

  app.post("/api/uploads", { preHandler: [requireAuth] }, async (request, reply) => {
    const csrfToken = request.headers["x-csrf-token"];
    const csrfValue = Array.isArray(csrfToken) ? csrfToken[0] ?? "" : csrfToken ?? "";

    if (!verifySessionCsrfToken(request, csrfValue)) {
      return reply.code(400).send({ ok: false, error: "Ungültiges CSRF-Token." });
    }

    if (!request.isMultipart()) {
      return reply.code(400).send({ ok: false, error: "Erwarteter Multipart-Upload." });
    }

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
        const targetPath = path.join(config.uploadDir, storedName);

        await pipeline(part.file, createWriteStream(targetPath, { flags: "wx" }));

        const url = `/uploads/${storedName}`;
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
    const body = asRecord(request.body);

    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const existing = await getPage(params.slug);
    if (!existing) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
    }

    const title = (body.title ?? "").trim();
    const tags = (body.tags ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const content = body.content ?? "";

    const result = await savePage({
      slug: params.slug,
      title,
      tags,
      content,
      updatedBy: request.currentUser?.username ?? "unknown"
    });

    if (!result.ok) {
      return reply.redirect(
        `/wiki/${encodeURIComponent(params.slug)}/edit?error=${encodeURIComponent(
          result.error ?? "Speichern fehlgeschlagen"
        )}&title=${encodeURIComponent(title)}&tags=${encodeURIComponent(body.tags ?? "")}&content=${encodeURIComponent(content)}`
      );
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
    const body = asRecord(request.body);

    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
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
    const query = asRecord(request.query);
    const q = (query.q ?? "").trim();
    const results = q.length >= 2 ? await searchPages(q) : [];

    const body = `
      <section class="content-wrap">
        <h1>Suche</h1>
        <p>${q ? `Ergebnisse für <strong>${escapeHtml(q)}</strong>` : "Bitte Suchbegriff eingeben."}</p>
        ${renderPageList(results)}
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
    const query = asRecord(request.query);
    const q = (query.q ?? "").trim();
    const requestedLimit = Number.parseInt(query.limit ?? "8", 10);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 8;

    if (q.length < 2) {
      return reply.send({ ok: true, suggestions: [] });
    }

    const suggestions = await suggestPages(q, limit);

    return reply.send({
      ok: true,
      suggestions: suggestions.map((page) => ({
        slug: page.slug,
        title: page.title,
        tags: page.tags,
        updatedAt: page.updatedAt,
        url: `/wiki/${page.slug}`
      }))
    });
  });
};
