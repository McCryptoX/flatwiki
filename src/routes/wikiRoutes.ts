import type { FastifyInstance } from "fastify";
import { requireAdmin, requireAuth, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import { escapeHtml, formatDate, renderLayout, renderPageList } from "../lib/render.js";
import { deletePage, getPage, isValidSlug, listPages, savePage, searchPages, slugifyTitle } from "../lib/wikiStore.js";

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
  <section class="content-wrap">
    <h1>${params.mode === "new" ? "Neue Seite" : "Seite bearbeiten"}</h1>
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
      <label>Inhalt (Markdown)
        <textarea name="content" rows="18" required>${escapeHtml(params.content)}</textarea>
      </label>
      <button type="submit">${params.mode === "new" ? "Seite erstellen" : "Änderungen speichern"}</button>
    </form>
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

    const body = `
      <article class="wiki-page">
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
        error: query.error
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
        error: query.error
      })
    );
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

    const deleted = await deletePage(params.slug);
    if (!deleted) {
      return reply.redirect("/?error=Seite+nicht+gefunden");
    }

    await writeAuditLog({
      action: "wiki_page_deleted",
      actorId: request.currentUser?.id,
      targetId: params.slug
    });

    return reply.redirect("/?notice=Seite+gel%C3%B6scht");
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
};
