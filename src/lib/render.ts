import { config } from "../config.js";
import { getPublicReadEnabled } from "./runtimeSettingsStore.js";
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
  hideHeaderSearch?: boolean | undefined;
}

export const renderLayout = (options: LayoutOptions): string => {
  const title = `${escapeHtml(options.title)} | ${escapeHtml(siteTitle)}`;
  const user = options.user;
  const publicReadEnabled = getPublicReadEnabled();

  const themeToggle = `<button type="button" class="theme-toggle ghost tiny" aria-label="Farbschema wechseln" data-theme-toggle><span class="theme-toggle-icon" aria-hidden="true"></span></button>`;

  const navRight = user
    ? `
      <div class="nav-right">
        ${themeToggle}
        <span class="welcome">${escapeHtml(user.displayName)}</span>
        <a href="/toc">Inhaltsverzeichnis</a>
        <a href="/notifications">Benachrichtigungen${
          user.unreadNotificationsCount && user.unreadNotificationsCount > 0
            ? ` <span class="notif-badge">${Math.min(user.unreadNotificationsCount, 99)}</span>`
            : ""
        }</a>
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
    : `<div class="nav-right">${themeToggle} <a href="/login">Anmelden</a></div>`;

  const mobileSidebarNav = user
    ? `
      <div class="mobile-sidebar-meta">
        <strong>${escapeHtml(user.displayName)}</strong>
      </div>
      <a href="/toc">Inhaltsverzeichnis</a>
      <a href="/notifications">Benachrichtigungen${
        user.unreadNotificationsCount && user.unreadNotificationsCount > 0
          ? ` <span class="notif-badge">${Math.min(user.unreadNotificationsCount, 99)}</span>`
          : ""
      }</a>
      <a href="/account">Konto</a>
      ${user.role === "admin" ? `<a href="/admin/users">Admin</a>` : ""}
      <form method="post" action="/logout">
        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken ?? "")}" />
        <button type="submit" class="ghost">Abmelden</button>
      </form>
    `
    : `
      <a href="/login">Anmelden</a>
    `;

  const showHeaderSearch = !options.hideHeaderSearch && (user || publicReadEnabled);
  const search = showHeaderSearch
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

  const optionScripts = options.scripts ?? [];
  const hasArticlePage = options.body.includes('class="wiki-page article-page');
  const hasArticleTocScript = optionScripts.some((path) => path.startsWith("/article-toc.js"));
  const autoArticleScripts = hasArticlePage && !hasArticleTocScript ? ["/article-toc.js?v=4"] : [];
  const scripts = [...(user || publicReadEnabled ? ["/search-suggest.js?v=2", "/cmd-palette.js?v=1"] : []), "/js/main.js?v=2", ...optionScripts, ...autoArticleScripts]
    .filter((scriptPath) => scriptPath.startsWith("/"))
    .map((scriptPath) => `<script src="${escapeHtml(scriptPath)}" defer></script>`)
    .join("\n");

  const htmlTheme = user?.theme && user.theme !== "system" ? ` data-theme="${escapeHtml(user.theme)}"` : "";

  return `<!doctype html>
<html lang="de"${htmlTheme}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="same-origin" />
    <meta name="color-scheme" content="light dark" />
    <script src="/theme-init.js?v=3"></script>
    <title>${title}</title>
    <link rel="stylesheet" href="/styles.css?v=33" />
  </head>
  <body>
    <header class="site-header ${showHeaderSearch ? "" : "site-header-no-search"}">
      <div>
        <a href="/" class="brand">${escapeHtml(siteTitle)}</a>
        <p class="subtitle">Sicheres Flat-File Wiki</p>
      </div>
      ${search}
      <button
        type="button"
        class="mobile-menu-toggle"
        data-mobile-menu-toggle
        aria-label="Navigation öffnen"
        aria-controls="mobile-sidebar"
        aria-expanded="false"
      >☰</button>
      ${navRight}
    </header>
    <div class="mobile-overlay" data-mobile-overlay hidden></div>
    <aside class="mobile-sidebar" id="mobile-sidebar" data-mobile-sidebar aria-hidden="true">
      <div class="mobile-sidebar-head">
        <strong>${escapeHtml(siteTitle)}</strong>
        <button type="button" class="ghost tiny" data-mobile-menu-close aria-label="Navigation schließen">✕</button>
      </div>
      <div class="mobile-sidebar-theme">${themeToggle}</div>
      <nav class="mobile-sidebar-nav" aria-label="Mobile Navigation">
        ${mobileSidebarNav}
      </nav>
    </aside>

    <main class="container">
      ${flash}
      ${options.body}
    </main>

    <footer class="site-footer">
      <a href="/privacy">Datenschutz</a>
      <a href="/impressum">Impressum</a>
    </footer>
    <script src="/utils.js?v=1"></script>
    <script src="/theme-toggle.js?v=3" defer></script>
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
          (page) => {
            const visibleTags = page.tags.slice(0, 2);
            const hiddenTagCount = Math.max(0, page.tags.length - visibleTags.length);
            return `
          <article class="card">
            <h3><a href="/wiki/${encodeURIComponent(page.slug)}">${escapeHtml(page.title)}</a></h3>
            <p class="card-excerpt">${escapeHtml(page.excerpt || "Keine Vorschau verfügbar.")}</p>
            <div class="card-meta">
              <span class="meta-pill">${formatDate(page.updatedAt)}</span>
              <span class="meta-pill">Kategorie: ${escapeHtml(page.categoryName)}</span>
            </div>
            ${
              visibleTags.length > 0 || hiddenTagCount > 0
                ? `<div class="card-tags">${visibleTags
                    .map(
                      (tag) =>
                        `<a class="tag-chip" href="/search?tag=${encodeURIComponent(tag)}" title="Nach Tag filtern: ${escapeHtml(tag)}">#${escapeHtml(
                          tag
                        )}</a>`
                    )
                    .join("")}${hiddenTagCount > 0 ? `<span class="tag-chip tag-chip-muted">+${hiddenTagCount}</span>` : ""}</div>`
                : ""
            }
          </article>
        `
          }
        )
        .join("\n")}
    </section>
  `;
};
