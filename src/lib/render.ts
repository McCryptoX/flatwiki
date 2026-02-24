import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { getPublicReadEnabled } from "./runtimeSettingsStore.js";
import type { PublicUser, WikiPageSummary } from "../types.js";

// theme-init.js einmal beim Modulstart lesen und CSP-Hash berechnen.
// So kann das Script inline eingebettet werden (kein extra Netzwerk-Roundtrip),
// ohne 'unsafe-inline' in der CSP zu benötigen.
const _themeInitPath = path.join(config.rootDir, "public", "theme-init.js");
const _themeInitScript = readFileSync(_themeInitPath, "utf-8").trim();
export const themeInitCspHash = `'sha256-${createHash("sha256").update(_themeInitScript).digest("base64")}'`;

// theme.css einmal beim Modulstart lesen und CSP-Hash berechnen.
// Inline als <style> eingebettet – eliminiert den render-blockierenden Roundtrip.
const _themeCssPath = path.join(config.rootDir, "public", "css", "theme.css");
const _themeCss = readFileSync(_themeCssPath, "utf-8").trim();
export const themeCssCspHash = `'sha256-${createHash("sha256").update(_themeCss).digest("base64")}'`;

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
  pageTitle?: string | undefined;
  pageDescription?: string | undefined;
  canonicalPath?: string | undefined;
  user?: PublicUser | undefined;
  csrfToken?: string | undefined;
  notice?: string | undefined;
  error?: string | undefined;
  searchQuery?: string | undefined;
  scripts?: string[] | undefined;
  hideHeaderSearch?: boolean | undefined;
  hideHeader?: boolean | undefined;
  hideFooter?: boolean | undefined;
  mainClassName?: string | undefined;
}

export const renderLayout = (options: LayoutOptions): string => {
  const resolvedTitle = (options.pageTitle ?? options.title).trim();
  const title = resolvedTitle.length > 0 ? `${escapeHtml(resolvedTitle)} | ${escapeHtml(siteTitle)}` : escapeHtml(siteTitle);
  const description = escapeHtml(
    (options.pageDescription ?? `${resolvedTitle || siteTitle} – ${siteTitle}`).trim().slice(0, 160)
  );
  const rawCanonicalPath = ((options.canonicalPath ?? "/").split("?")[0] ?? "/").trim();
  const canonicalPath = rawCanonicalPath.startsWith("/") ? rawCanonicalPath : `/${rawCanonicalPath}`;
  const canonicalHref = `${(config.publicBaseUrl || "").replace(/\/+$/, "")}${canonicalPath}`;
  const user = options.user;
  const publicReadEnabled = getPublicReadEnabled();
  const userInitials = user
    ? user.displayName
        .split(/\s+/)
        .filter((part) => part.length > 0)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("") || "FW"
    : "FW";

  const themeToggle = `<button type="button" class="theme-toggle ghost tiny" aria-label="Farbschema wechseln" title="Farbschema wechseln" data-theme-toggle><span class="theme-toggle-icon" aria-hidden="true"></span></button>`;

  const navRight = user
    ? `
      <nav class="nav-right" aria-label="Hauptnavigation">
        ${themeToggle}
        <span class="user-pill"><span class="user-avatar">${escapeHtml(userInitials)}</span><span class="welcome">${escapeHtml(user.displayName)}</span></span>
        <a href="/toc">Inhaltsverzeichnis</a>
        <a href="/notifications">Benachrichtigungen${
          user.unreadNotificationsCount && user.unreadNotificationsCount > 0
            ? ` <span class="notif-badge" aria-label="${Math.min(user.unreadNotificationsCount, 99)} ungelesen">${Math.min(user.unreadNotificationsCount, 99)}</span>`
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
      </nav>
    `
    : `<nav class="nav-right" aria-label="Hauptnavigation">${themeToggle} <a href="/login">Anmelden</a></nav>`;

  const mobileSidebarNav = user
    ? `
      <div class="mobile-sidebar-meta">
        <span class="user-avatar">${escapeHtml(userInitials)}</span>
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
          <label for="global-search" class="sr-only">Wiki durchsuchen</label>
          <input id="global-search" type="search" name="q" value="${escapeHtml(options.searchQuery ?? "")}" placeholder="Wiki durchsuchen" autocomplete="off" required />
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
  const scripts = [...(user || publicReadEnabled ? ["/search-suggest.js?v=3", "/cmd-palette.js?v=2"] : []), "/js/main.js?v=3", ...optionScripts]
    .filter((scriptPath) => scriptPath.startsWith("/"))
    .map((scriptPath) => `<script src="${escapeHtml(scriptPath)}" defer></script>`)
    .join("\n");

  const htmlTheme = user?.theme && user.theme !== "system" ? ` data-theme="${escapeHtml(user.theme)}"` : "";

  const mainClass = ["container", options.mainClassName ?? ""].filter((entry) => entry.trim().length > 0).join(" ");

  return `<!doctype html>
<html lang="de"${htmlTheme}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="same-origin" />
    <meta name="color-scheme" content="light dark" />
    <script>${_themeInitScript}</script>
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${escapeHtml(canonicalHref)}" />
    <meta property="og:title" content="${escapeHtml(resolvedTitle || siteTitle)}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeHtml(canonicalHref)}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <style>${_themeCss}</style>
    <link rel="preload" href="/css/components.css?v=15" as="style" />
    <link rel="stylesheet" href="/css/components.css?v=15" />
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"${escapeHtml(siteTitle)}","url":"${escapeHtml((config.publicBaseUrl || "").replace(/\/+$/, "") || "/")}"}</script>
  </head>
  <body>
    <a href="#main-content" class="skip-to-main">Zum Hauptinhalt springen</a>
    ${
      options.hideHeader
        ? ""
        : `<header class="site-header ${showHeaderSearch ? "" : "site-header-no-search"}">
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
        title="Navigation öffnen"
        aria-controls="mobile-sidebar"
        aria-expanded="false"
      >☰</button>
      ${navRight}
    </header>
    <div class="mobile-overlay" data-mobile-overlay hidden></div>
    <aside class="mobile-sidebar" id="mobile-sidebar" data-mobile-sidebar aria-hidden="true" inert>
      <div class="mobile-sidebar-head">
        <strong>${escapeHtml(siteTitle)}</strong>
        <button type="button" class="ghost tiny" data-mobile-menu-close aria-label="Navigation schließen" title="Navigation schließen">✕</button>
      </div>
      <div class="mobile-sidebar-theme">${themeToggle}</div>
      <nav class="mobile-sidebar-nav" aria-label="Mobile Navigation">
        ${mobileSidebarNav}
      </nav>
    </aside>`
    }

    <main class="${escapeHtml(mainClass)}" id="main-content">
      ${flash}
      ${options.body}
    </main>

    ${
      options.hideFooter
        ? ""
        : `<footer class="site-footer">
      <a href="/privacy">Datenschutz</a>
      <a href="/impressum">Impressum</a>
      <a href="https://flatwiki.de/" target="_blank" rel="noopener noreferrer" class="footer-powered">Powered by FlatWiki</a>
    </footer>`
    }
    <script src="/utils.js?v=1" defer></script>
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
