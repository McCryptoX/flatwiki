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

const normalizePathname = (value: string): string => {
  const [rawPath] = value.split("?");
  if (!rawPath) return "/";
  const withLeadingSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")) return withLeadingSlash.slice(0, -1);
  return withLeadingSlash;
};

const formatPathSegment = (segment: string): string =>
  segment
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

const breadcrumbLabelMap: Record<string, string> = {
  wiki: "Artikel",
  admin: "Admin",
  toc: "Inhaltsverzeichnis",
  search: "Suche",
  new: "Neue Seite",
  account: "Konto",
  notifications: "Benachrichtigungen",
  users: "Benutzer",
  groups: "Gruppen",
  categories: "Kategorien",
  templates: "Vorlagen",
  media: "Uploads",
  links: "Links",
  versions: "Versionen",
  backups: "Backups",
  ssl: "TLS/SSL",
  index: "Index",
  history: "Historie",
  edit: "Bearbeiten",
  login: "Anmelden"
};

const getBreadcrumbLabel = (segment: string): string => breadcrumbLabelMap[segment.toLowerCase()] ?? formatPathSegment(segment);

const isPathActive = (pathname: string, href: string): boolean => {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
};

interface AppNavItem {
  key: "dashboard" | "search" | "toc" | "new" | "notifications" | "account" | "admin" | "uploads";
  href: string;
  label: string;
  requiresAuth?: boolean;
  requiresAdmin?: boolean;
}

const renderSidebarIcon = (key: AppNavItem["key"]): string => {
  const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"';
  if (key === "dashboard") {
    return `<svg ${common}><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25A2.25 2.25 0 0 1 8.25 10.5H6A2.25 2.25 0 0 1 3.75 8.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"/></svg>`;
  }
  if (key === "search") {
    return `<svg ${common}><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>`;
  }
  if (key === "toc") {
    return `<svg ${common}><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>`;
  }
  if (key === "new") {
    return `<svg ${common}><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25M10.5 13.5v6m3-3h-6M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>`;
  }
  if (key === "notifications") {
    return `<svg ${common}><path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75v-.7V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"/></svg>`;
  }
  if (key === "account") {
    return `<svg ${common}><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"/></svg>`;
  }
  if (key === "admin") {
    return `<svg ${common}><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>`;
  }
  return `<svg ${common}><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"/></svg>`;
};

const appNavItems: AppNavItem[] = [
  { key: "dashboard", href: "/", label: "Dashboard" },
  { key: "search", href: "/search", label: "Suche" },
  { key: "toc", href: "/toc", label: "Inhaltsverzeichnis" },
  { key: "new", href: "/new", label: "Neue Seite", requiresAuth: true },
  { key: "notifications", href: "/notifications", label: "Benachrichtigungen", requiresAuth: true },
  { key: "account", href: "/account", label: "Konto", requiresAuth: true },
  { key: "admin", href: "/admin/users", label: "Admin", requiresAdmin: true }
];

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
  const pathname = normalizePathname(canonicalPath);
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

  const breadcrumbParts = pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .slice(0, 4);
  const breadcrumbLinks: string[] = ['<a href="/">Dashboard</a>'];
  if (breadcrumbParts.length > 0) {
    let rollingPath = "";
    for (const segment of breadcrumbParts) {
      rollingPath += `/${segment}`;
      breadcrumbLinks.push(`<a href="${escapeHtml(rollingPath)}">${escapeHtml(getBreadcrumbLabel(segment))}</a>`);
    }
  }
  const breadcrumbs = `<nav class="app-breadcrumbs" aria-label="Breadcrumb">${breadcrumbLinks.join(
    '<span aria-hidden="true">/</span>'
  )}</nav>`;

  const sidebarNav = appNavItems
    .filter((item) => {
      if (item.requiresAdmin) return user?.role === "admin";
      if (item.requiresAuth) return Boolean(user);
      return true;
    })
    .map((item) => {
      const active = isPathActive(pathname, item.href);
      return `<a href="${item.href}" class="${active ? "is-active" : ""}" ${active ? 'aria-current="page"' : ""}>
        <span class="sidebar-item-icon">${renderSidebarIcon(item.key)}</span>
        <span class="sidebar-item-label">${escapeHtml(item.label)}</span>
      </a>`;
    })
    .join("");

  const primaryAction = user
    ? pathname === "/new"
      ? ""
      : '<a href="/new" class="button">Neue Seite</a>'
    : pathname === "/login"
      ? ""
      : '<a href="/login" class="button tiny secondary">Anmelden</a>';
  const sidebarMeta = user
    ? `<div class="app-sidebar-meta">
        <div class="user-pill"><span class="user-avatar">${escapeHtml(userInitials)}</span><span class="welcome">${escapeHtml(user.displayName)}</span></div>
        <div class="app-sidebar-meta-actions">
          <a href="/notifications">Hinweise${
            user.unreadNotificationsCount && user.unreadNotificationsCount > 0
              ? ` <span class="notif-badge" aria-label="${Math.min(user.unreadNotificationsCount, 99)} ungelesen">${Math.min(user.unreadNotificationsCount, 99)}</span>`
              : ""
          }</a>
          <form method="post" action="/logout" class="inline-form">
            <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken ?? "")}" />
            <button type="submit" class="ghost tiny">Abmelden</button>
          </form>
        </div>
      </div>`
    : '<div class="app-sidebar-meta"><a href="/login" class="button tiny secondary">Anmelden</a></div>';

  const allowSearchShortcut = user || publicReadEnabled;
  const isSearchPage = pathname === "/search";
  const showSearchShortcut = !options.hideHeaderSearch && allowSearchShortcut;
  const searchShortcut = showSearchShortcut
    ? `<a href="/search" class="search-shortcut${isSearchPage ? " is-active" : ""}" aria-label="Suche öffnen" title="Suche öffnen" ${
        isSearchPage ? 'aria-current="page"' : ""
      }>
        <svg class="search-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 4a7 7 0 1 0 4.9 12l4.4 4.4a1 1 0 0 0 1.4-1.4l-4.4-4.4A7 7 0 0 0 11 4Z" />
        </svg>
      </a>`
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
        : `<div class="mobile-overlay" data-mobile-overlay hidden></div>
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

    <div class="app-shell ${options.hideHeader ? "app-shell--plain" : ""}">
      ${
        options.hideHeader
          ? ""
          : `<aside class="app-sidebar" aria-label="Seitenleiste">
        <div class="app-sidebar-top">
          <a href="/" class="brand">${escapeHtml(siteTitle)}</a>
          <p class="subtitle">Sicheres Flat-File Wiki</p>
        </div>
        <nav class="app-sidebar-nav" aria-label="Bereiche">
          ${sidebarNav}
        </nav>
        ${sidebarMeta}
      </aside>`
      }
      <div class="app-main-shell">
        ${
          options.hideHeader
            ? ""
            : `<header class="app-main-header">
          <div class="app-main-header-row">
            <button
              type="button"
              class="mobile-menu-toggle"
              data-mobile-menu-toggle
              aria-label="Navigation öffnen"
              title="Navigation öffnen"
              aria-controls="mobile-sidebar"
              aria-expanded="false"
            >☰</button>
            <span class="app-mobile-title">${escapeHtml(getBreadcrumbLabel(breadcrumbParts[breadcrumbParts.length - 1] ?? "dashboard"))}</span>
            ${breadcrumbs}
            <div class="app-main-header-actions">
              ${searchShortcut}
              ${primaryAction}
              ${themeToggle}
            </div>
          </div>
        </header>`
        }
        <main class="${escapeHtml(mainClass)}" id="main-content">
          ${flash}
          ${options.body}
        </main>
      </div>
    </div>

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
