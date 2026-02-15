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
import { ensureDefaultCategory } from "./lib/categoryStore.js";
import { ensureDir, ensureFile } from "./lib/fileStore.js";
import { purgeExpiredSessions } from "./lib/sessionStore.js";
import { ensureInitialAdmin } from "./lib/userStore.js";
import { registerAccountRoutes } from "./routes/accountRoutes.js";
import { registerAdminRoutes } from "./routes/adminRoutes.js";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { registerPublicRoutes } from "./routes/publicRoutes.js";
import { registerSetupRoutes } from "./routes/setupRoutes.js";
import { registerWikiRoutes } from "./routes/wikiRoutes.js";

const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024
});

const bootstrapDataStorage = async (): Promise<void> => {
  await ensureDir(config.dataDir);
  await ensureDir(config.indexDir);
  await ensureDir(config.wikiDir);
  await ensureDir(config.uploadDir);
  await ensureFile(config.categoriesFile, "[]\n");
  await ensureFile(config.usersFile, "[]\n");
  await ensureFile(config.sessionsFile, "[]\n");
  await ensureFile(config.auditFile, "");
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
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
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

  await app.register(fastifyStatic, {
    root: path.join(config.rootDir, "public"),
    prefix: "/"
  });

  await app.register(fastifyStatic, {
    root: config.uploadDir,
    prefix: "/uploads/",
    decorateReply: false
  });
};

const registerRoutes = async (): Promise<void> => {
  app.get("/health", async () => ({ status: "ok", at: new Date().toISOString() }));

  await registerSetupRoutes(app);
  await registerAuthRoutes(app);
  await registerWikiRoutes(app);
  await registerAdminRoutes(app);
  await registerAccountRoutes(app);
  await registerPublicRoutes(app);
};

const start = async (): Promise<void> => {
  try {
    await bootstrapDataStorage();
    await ensureDefaultCategory();
    await registerPlugins();

    app.addHook("preHandler", attachCurrentUser);

    const adminResult = await ensureInitialAdmin();
    if (adminResult.created) {
      app.log.warn("Es wurde automatisch ein erster Admin angelegt.");
      app.log.warn(`Admin-Login: ${adminResult.username}`);
      app.log.warn("Admin-Passwort wurde aus BOOTSTRAP_ADMIN_PASSWORD übernommen.");
      app.log.warn("Bitte Passwort sofort nach dem ersten Login ändern.");
    } else if (adminResult.pendingSetup) {
      app.log.warn("Keine Benutzer vorhanden. Bitte Ersteinrichtung unter /setup durchführen.");
    }

    await purgeExpiredSessions();
    setInterval(() => {
      void purgeExpiredSessions();
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
