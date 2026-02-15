import { config } from "../config.js";
import type { PublicUser, WikiPageSummary } from "../types.js";

const siteTitle = config.wikiTitle;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const formatDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
};

interface LayoutOptions {
  title: string;
  body: string;
  user?: PublicUser | undefined;
  csrfToken?: string | undefined;
  notice?: string | undefined;
  error?: string | undefined;
  searchQuery?: string | undefined;
  scripts?: string[] | undefined;
}

export const renderLayout = (options: LayoutOptions): string => {
  const title = `${escapeHtml(options.title)} | ${escapeHtml(siteTitle)}`;
  const user = options.user;

  const navRight = user
    ? `
      <div class="nav-right">
        <span class="welcome">${escapeHtml(user.displayName)}</span>
        <a href="/toc">Inhaltsverzeichnis</a>
        <a href="/account">Konto</a>
        ${
          user.role === "admin"
            ? `<a class="admin-link" href="/admin/users">Admin</a>`
            : ""
        }
        <form method="post" action="/logout" class="inline-form">
          <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken ?? "")}" />
          <button type="submit" class="ghost">Abmelden</button>
        </form>
      </div>
    `
    : `<a href="/login">Anmelden</a>`;

  const search = user
    ? `
      <form method="get" action="/search" class="search-form">
        <div class="search-box" data-search-suggest>
          <input type="search" name="q" value="${escapeHtml(options.searchQuery ?? "")}" placeholder="Wiki durchsuchen" autocomplete="off" required />
          <div class="search-suggest" hidden></div>
        </div>
        <button type="submit">Suchen</button>
      </form>
    `
    : "";

  const flash = [
    options.notice ? `<div class="flash success">${escapeHtml(options.notice)}</div>` : "",
    options.error ? `<div class="flash error">${escapeHtml(options.error)}</div>` : ""
  ].join("\n");

  const scripts = [...(user ? ["/search-suggest.js?v=2"] : []), ...(options.scripts ?? [])]
    .filter((scriptPath) => scriptPath.startsWith("/"))
    .map((scriptPath) => `<script src="${escapeHtml(scriptPath)}" defer></script>`)
    .join("\n");

  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="same-origin" />
    <title>${title}</title>
    <link rel="stylesheet" href="/styles.css?v=7" />
  </head>
  <body>
    <div class="bg-shape bg-shape-1"></div>
    <div class="bg-shape bg-shape-2"></div>
    <header class="site-header">
      <div>
        <a href="/" class="brand">${escapeHtml(siteTitle)}</a>
        <p class="subtitle">Sicheres Flat-File Wiki</p>
      </div>
      ${search}
      ${navRight}
    </header>

    <main class="container">
      ${flash}
      ${options.body}
    </main>

    <footer class="site-footer">
      <a href="/privacy">Datenschutz</a>
      <a href="/impressum">Impressum</a>
    </footer>
    ${scripts}
  </body>
</html>`;
};

export const renderPageList = (pages: WikiPageSummary[]): string => {
  if (pages.length === 0) {
    return '<p class="empty">Noch keine Wiki-Seiten vorhanden.</p>';
  }

  return `
    <section class="card-grid">
      ${pages
        .map(
          (page) => `
          <article class="card">
            <h3><a href="/wiki/${encodeURIComponent(page.slug)}">${escapeHtml(page.title)}</a></h3>
            <p class="card-excerpt">${escapeHtml(page.excerpt || "Keine Vorschau verfügbar.")}</p>
            <div class="card-meta">
              <span class="meta-pill">${formatDate(page.updatedAt)}</span>
              <span class="meta-pill">Kategorie: ${escapeHtml(page.categoryName)}</span>
              <span class="meta-pill">${page.visibility === "restricted" ? "Zugriff: eingeschränkt" : "Zugriff: alle"}</span>
              <span class="meta-pill">${page.encrypted ? "Verschlüsselt" : "Unverschlüsselt"}</span>
            </div>
            ${
              page.tags.length > 0
                ? `<div class="card-tags">${page.tags.map((tag) => `<span class="tag-chip">#${escapeHtml(tag)}</span>`).join("")}</div>`
                : ""
            }
          </article>
        `
        )
        .join("\n")}
    </section>
  `;
};
