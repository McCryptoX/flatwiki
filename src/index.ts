import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { attachCurrentUser } from "./lib/auth.js";
import { themeInitCspHash, themeCssCspHash } from "./lib/render.js";
import { ensureDefaultCategory } from "./lib/categoryStore.js";
import { initBackupAutomation } from "./lib/backupStore.js";
import { ensureDir, ensureFile } from "./lib/fileStore.js";
import { ensureDefaultTemplates } from "./lib/templateStore.js";
import { getPublicReadEnabled, getUploadDerivativesEnabled, initRuntimeSettings } from "./lib/runtimeSettingsStore.js";
import { ensureSearchIndexConsistency } from "./lib/searchIndexStore.js";
import { purgeExpiredSessions } from "./lib/sessionStore.js";
import { resolveUploadAccess } from "./lib/uploadAccessPolicy.js";
import { normalizeUploadFileName } from "./lib/mediaStore.js";
import { resolveNegotiatedUploadPath } from "./lib/uploadDerivatives.js";
import { getUploadCacheControl } from "./lib/uploadResponsePolicy.js";
import { ensureInitialAdmin, migrateUserSecretStorage } from "./lib/userStore.js";
import { registerAccountRoutes } from "./routes/accountRoutes.js";
import { registerAdminRoutes } from "./routes/adminRoutes.js";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { registerPublicRoutes } from "./routes/publicRoutes.js";
import { registerSetupRoutes } from "./routes/setupRoutes.js";
import { registerSeoRoutes } from "./routes/seoRoutes.js";
import { registerUserRoutes } from "./routes/userRoutes.js";
import { registerWikiRoutes } from "./routes/wikiRoutes.js";

const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024,
  trustProxy: config.trustProxy
});

const bootstrapDataStorage = async (): Promise<void> => {
  await ensureDir(config.dataDir);
  await ensureDir(config.indexDir);
  await ensureDir(config.wikiDir);
  await ensureDir(config.uploadDir);
  await ensureDir(config.versionsDir);
  await ensureDir(config.backupDir);
  await ensureDir(config.attachmentsRootDir);
  await ensureDir(config.attachmentsFileDir);
  await ensureDir(config.attachmentsQuarantineDir);
  await ensureFile(config.categoriesFile, "[]\n");
  await ensureFile(config.templatesFile, "[]\n");
  await ensureFile(config.groupsFile, "[]\n");
  await ensureFile(config.usersFile, "[]\n");
  await ensureFile(config.sessionsFile, "[]\n");
  await ensureFile(config.commentsFile, '{"comments":[]}\n');
  await ensureFile(config.watchFile, '{"watches":[]}\n');
  await ensureFile(config.notificationsFile, '{"notifications":[]}\n');
  await ensureFile(config.workflowFile, '{"pages":[]}\n');
  await ensureFile(config.attachmentsFile, '{"attachments":[]}\n');
  await ensureFile(config.auditFile, "");
  await ensureFile(config.runtimeSettingsFile, "{}\n");
};

const registerPlugins = async (): Promise<void> => {
  await app.register(cookie, {
    secret: config.cookieSecret,
    hook: "onRequest"
  });

  await app.register(formbody);

  await app.register(multipart, {
    limits: {
      files: 12,
      fileSize: 8 * 1024 * 1024
    }
  });

  await app.register(helmet, {
    hsts: config.isProduction
      ? {
          maxAge: 31536000,
          includeSubDomains: true
        }
      : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", themeInitCspHash],
        styleSrc: ["'self'", "https://fonts.googleapis.com", themeCssCspHash],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.isProduction ? [] : null
      }
    }
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute"
  });

  app.addHook("preHandler", attachCurrentUser);

  // Uploads have a dedicated gate:
  // - private mode: authenticated users only (401 otherwise)
  // - public-read mode: readable without auth
  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/uploads/")) {
      const decision = resolveUploadAccess({
        isAuthenticated: Boolean(request.currentUser),
        publicReadEnabled: getPublicReadEnabled()
      });
      if (!decision.allowed) {
        return reply.code(decision.statusCode ?? 401).type("text/plain; charset=utf-8").send("Nicht angemeldet.");
      }
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.url.startsWith("/uploads/")) {
      return payload;
    }

    reply.header("Cache-Control", getUploadCacheControl(getPublicReadEnabled()));
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    return payload;
  });

  await app.register(fastifyStatic, {
    root: path.join(config.rootDir, "public"),
    prefix: "/",
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 Jahr für versionierte Assets (?v=X)
    immutable: true
  });
};

const registerRoutes = async (): Promise<void> => {
  app.get("/health", async () => ({ status: "ok", at: new Date().toISOString() }));
  app.route({
    method: ["GET", "HEAD"],
    url: "/uploads/*",
    async handler(request, reply) {
      const params = request.params as { "*": string };
      const query = request.query as { format?: string };
      const normalized = normalizeUploadFileName(String(params["*"] ?? ""));
      if (!normalized) {
        return reply.code(404).type("text/plain; charset=utf-8").send("Nicht gefunden.");
      }

      const rawFormat = String(query.format ?? "").trim().toLowerCase();
      const requestedFormat: "auto" | "avif" | "webp" | "original" =
        rawFormat === "avif" || rawFormat === "webp" || rawFormat === "original" ? rawFormat : "auto";

      const resolvedPath = await resolveNegotiatedUploadPath({
        originalRelativePath: normalized,
        uploadRootDir: config.uploadDir,
        acceptHeader: Array.isArray(request.headers.accept) ? request.headers.accept.join(",") : request.headers.accept,
        enabled: getUploadDerivativesEnabled(),
        requestedFormat
      });
      reply.header("Vary", "Accept");
      const lowerResolved = resolvedPath.toLowerCase();
      const variant = lowerResolved.endsWith(".avif") ? "avif" : lowerResolved.endsWith(".webp") ? "webp" : "original";
      reply.header("X-FlatWiki-Upload-Variant", variant);

      try {
        return reply.sendFile(resolvedPath, config.uploadDir);
      } catch {
        return reply.code(404).type("text/plain; charset=utf-8").send("Nicht gefunden.");
      }
    }
  });

  await registerSetupRoutes(app);
  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerWikiRoutes(app);
  await registerAdminRoutes(app);
  await registerAccountRoutes(app);
  await registerSeoRoutes(app);
  await registerPublicRoutes(app);
};

const registerErrorHandler = (): void => {
  app.setErrorHandler((error, request, reply) => {
    request.log.error(
      {
        err: error,
        route: request.url,
        method: request.method
      },
      "Unhandled request error"
    );

    if (reply.sent) return;

    const errorLike = error as Error & { statusCode?: number };
    const statusCode = typeof errorLike.statusCode === "number" && errorLike.statusCode >= 400 ? errorLike.statusCode : 500;
    const isApiRequest = request.url.startsWith("/api/");
    const safeMessage = statusCode >= 500 ? "Interner Serverfehler." : errorLike.message || "Anfrage fehlgeschlagen.";

    if (isApiRequest) {
      void reply.code(statusCode).send({ ok: false, error: safeMessage });
      return;
    }

    void reply.code(statusCode).type("text/plain; charset=utf-8").send(safeMessage);
  });
};

const start = async (): Promise<void> => {
  try {
    await bootstrapDataStorage();
    await initRuntimeSettings();
    await migrateUserSecretStorage();
    await ensureDefaultCategory();
    await ensureDefaultTemplates();
    initBackupAutomation({
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg)
    });
    const indexCheck = await ensureSearchIndexConsistency();
    if (indexCheck.rebuilt) {
      app.log.info({ reason: indexCheck.reason }, "Suchindex wurde beim Start automatisch neu aufgebaut.");
    } else {
      app.log.info({ reason: indexCheck.reason }, "Suchindex-Konsistenz beim Start geprüft.");
    }
    await registerPlugins();
    registerErrorHandler();

    const adminResult = await ensureInitialAdmin();
    if (adminResult.created) {
      app.log.warn("Es wurde automatisch ein erster Admin angelegt.");
      app.log.warn(`Admin-Login: ${adminResult.username}`);
      // Never log bootstrap password material; only emit an operational warning.
      app.log.warn("Ein initiales Admin-Passwort wurde gesetzt. Bitte Passwort sofort nach dem ersten Login ändern.");
    } else if (adminResult.pendingSetup) {
      app.log.warn("Keine Benutzer vorhanden. Bitte Ersteinrichtung unter /setup durchführen.");
    }

    await purgeExpiredSessions();
    setInterval(() => {
      void purgeExpiredSessions().catch((error) => app.log.error(error, "Fehler beim Bereinigen abgelaufener Sessions"));
    }, 10 * 60 * 1000).unref();

    await registerRoutes();

    await app.listen({
      port: config.port,
      host: config.host
    });

    app.log.info(`FlatWiki läuft auf http://${config.host}:${config.port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
