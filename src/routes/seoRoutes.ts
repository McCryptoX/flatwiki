import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAdmin, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import { config } from "../config.js";
import { ensureDir, removeFile, safeResolve } from "../lib/fileStore.js";
import { escapeHtml, renderLayout } from "../lib/render.js";
import { getPublicReadEnabled } from "../lib/runtimeSettingsStore.js";
import { listPages } from "../lib/wikiStore.js";

const ROBOTS_MAX_BYTES = 32 * 1024;

const DEFAULT_ROBOTS_TEMPLATE = `# FlatWiki crawl policy: indexing explicitly allowed for all crawlers and AI bots.

User-agent: *
Allow: /

# OpenAI
User-agent: GPTBot
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ChatGPT-User
Allow: /

# Anthropic
User-agent: ClaudeBot
Allow: /
User-agent: Claude-Web
Allow: /

# Perplexity
User-agent: PerplexityBot
Allow: /

# Google
User-agent: Google-Extended
Allow: /

# Common Crawl / ByteDance
User-agent: CCBot
Allow: /
User-agent: Bytespider
Allow: /

# xAI / Grok (observed variants)
User-agent: Grok
Allow: /
User-agent: GrokBot
Allow: /
User-agent: xAI-Grok
Allow: /
User-agent: Grok-DeepSearch
Allow: /
`;

const asRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, string>;
};

const normalizeLineEndings = (value: string): string => value.replace(/\r\n?/g, "\n");

const normalizeBaseUrl = (raw: string): string | null => {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
};

const resolvePublicBaseUrl = (request: FastifyRequest): string => {
  const configured = normalizeBaseUrl(config.publicBaseUrl);
  if (configured) return configured;

  const protoHeader = request.headers["x-forwarded-proto"];
  const protoRaw = Array.isArray(protoHeader) ? protoHeader[0] ?? "" : protoHeader ?? "";
  const proto = (protoRaw.split(",")[0] ?? "").trim().toLowerCase() || "http";

  const hostHeader = request.headers["x-forwarded-host"] ?? request.headers.host;
  const hostRaw = Array.isArray(hostHeader) ? hostHeader[0] ?? "" : hostHeader ?? "";
  const host = (hostRaw.split(",")[0] ?? "").trim() || `127.0.0.1:${config.port}`;

  return normalizeBaseUrl(`${proto}://${host}`) ?? `http://127.0.0.1:${config.port}`;
};

const enforceSitemapLine = (rawContent: string, publicBaseUrl: string): string => {
  const normalized = normalizeLineEndings(rawContent);
  const lines = normalized
    .split("\n")
    .filter((line) => !/^sitemap\s*:/i.test(line.trim()));
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  lines.push("", `Sitemap: ${publicBaseUrl}/sitemap.xml`);
  return `${lines.join("\n")}\n`;
};

const getDefaultRobotsTxt = (publicBaseUrl: string): string => enforceSitemapLine(DEFAULT_ROBOTS_TEMPLATE, publicBaseUrl);

const resolveRobotsFilePath = (): string => safeResolve(config.dataDir, path.basename(config.robotsFile));

const loadCustomRobotsTxt = async (): Promise<string | null> => {
  const robotsPath = resolveRobotsFilePath();
  try {
    return await fs.readFile(robotsPath, "utf8");
  } catch {
    return null;
  }
};

const loadEffectiveRobotsTxt = async (publicBaseUrl: string): Promise<string> => {
  const custom = await loadCustomRobotsTxt();
  if (!custom) return getDefaultRobotsTxt(publicBaseUrl);
  return enforceSitemapLine(custom, publicBaseUrl);
};

const createEtag = (content: string): string => `"${createHash("sha256").update(content, "utf8").digest("hex")}"`;

const isNotModified = (request: FastifyRequest, etag: string): boolean => {
  const incoming = request.headers["if-none-match"];
  const value = Array.isArray(incoming) ? incoming.join(",") : incoming ?? "";
  return value.split(",").map((entry) => entry.trim()).includes(etag);
};

const withCachingHeaders = (
  reply: { header: (name: string, value: string) => unknown },
  etag: string
): void => {
  reply.header("ETag", etag);
  reply.header("Cache-Control", "public, max-age=300, must-revalidate");
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const toAbsoluteUrl = (baseUrl: string, pathname: string): string => `${baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;

const buildSitemapXml = async (publicBaseUrl: string): Promise<string> => {
  const entries: Array<{ loc: string; lastmod?: string }> = [];

  if (getPublicReadEnabled()) {
    entries.push({
      loc: toAbsoluteUrl(publicBaseUrl, "/")
    });

    const pages = await listPages();
    for (const page of pages) {
      // Conservative sitemap policy: never include restricted, sensitive or encrypted pages.
      if (page.visibility !== "all" || page.sensitive || page.encrypted || page.securityProfile !== "standard") continue;
      const updatedAt = Date.parse(page.updatedAt);
      entries.push({
        loc: toAbsoluteUrl(publicBaseUrl, `/wiki/${encodeURIComponent(page.slug)}`),
        ...(Number.isFinite(updatedAt) ? { lastmod: new Date(updatedAt).toISOString().slice(0, 10) } : {})
      });
    }
  }

  const body = entries
    .map((entry) => {
      const lastMod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : "";
      return `  <url><loc>${escapeXml(entry.loc)}</loc>${lastMod}</url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
};

const atomicWriteTextFile = async (filePath: string, content: string): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmpPath, "w");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
};

export const registerSeoRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/robots.txt", async (request, reply) => {
    const publicBaseUrl = resolvePublicBaseUrl(request);
    const robotsTxt = await loadEffectiveRobotsTxt(publicBaseUrl);
    const etag = createEtag(robotsTxt);
    withCachingHeaders(reply, etag);
    if (isNotModified(request, etag)) {
      return reply.code(304).send();
    }
    return reply.type("text/plain; charset=utf-8").send(robotsTxt);
  });

  app.get("/sitemap.xml", async (request, reply) => {
    const publicBaseUrl = resolvePublicBaseUrl(request);
    const xml = await buildSitemapXml(publicBaseUrl);
    const etag = createEtag(xml);
    withCachingHeaders(reply, etag);
    if (isNotModified(request, etag)) {
      return reply.code(304).send();
    }
    return reply.type("application/xml; charset=utf-8").send(xml);
  });

  app.get("/admin/seo", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const publicBaseUrl = resolvePublicBaseUrl(request);
    const current = (await loadCustomRobotsTxt()) ?? getDefaultRobotsTxt(publicBaseUrl);
    const body = `
      <section class="page-header under-title">
        <div>
          <h1>SEO / robots.txt</h1>
          <p>Bearbeite die robots.txt für Suchmaschinen. Die Sitemap-Zeile wird automatisch gesetzt.</p>
        </div>
        <nav class="action-row admin-nav" aria-label="Admin Navigation">
          <a class="button secondary" href="/admin/users">Benutzerverwaltung</a>
          <a class="button secondary" href="/admin/ui">Bedienmodus</a>
          <a class="button secondary is-active-nav" aria-current="page" href="/admin/seo">SEO / robots.txt</a>
        </nav>
      </section>
      <section class="stack">
        <form method="post" action="/admin/seo/robots" class="stack">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <label for="robots-content">robots.txt Inhalt</label>
          <textarea id="robots-content" name="content" rows="24" maxlength="${ROBOTS_MAX_BYTES}" spellcheck="false">${escapeHtml(
            normalizeLineEndings(current)
          )}</textarea>
          <p class="muted-note">Hinweis: <code>Sitemap: ${escapeHtml(publicBaseUrl)}/sitemap.xml</code> wird beim Speichern und Ausliefern erzwungen.</p>
          <div class="action-row">
            <button type="submit">Speichern</button>
          </div>
        </form>
        <form method="post" action="/admin/seo/robots/reset" class="action-row">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <button type="submit" class="secondary" onclick="return confirm('Custom robots.txt wirklich zurücksetzen?')">Auf Default zurücksetzen</button>
        </form>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "SEO / robots.txt",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/admin/seo/robots", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const rawContent = String(body.content ?? "");
    const normalizedContent = normalizeLineEndings(rawContent);
    const sizeBytes = Buffer.byteLength(normalizedContent, "utf8");
    if (sizeBytes > ROBOTS_MAX_BYTES) {
      return reply.redirect(`/admin/seo?error=${encodeURIComponent("robots.txt ist zu groß (max. 32 KB).")}`);
    }

    const robotsPath = resolveRobotsFilePath();
    await atomicWriteTextFile(robotsPath, normalizedContent.endsWith("\n") ? normalizedContent : `${normalizedContent}\n`);

    await writeAuditLog({
      action: "admin_robots_updated",
      actorId: request.currentUser?.id
    });

    return reply.redirect(`/admin/seo?notice=${encodeURIComponent("robots.txt gespeichert.")}`);
  });

  app.post("/admin/seo/robots/reset", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    await removeFile(resolveRobotsFilePath());
    await writeAuditLog({
      action: "admin_robots_reset",
      actorId: request.currentUser?.id
    });

    return reply.redirect(`/admin/seo?notice=${encodeURIComponent("robots.txt auf Default zurückgesetzt.")}`);
  });
};
