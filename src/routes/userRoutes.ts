import type { FastifyInstance } from "fastify";
import { requireApiAuth, verifySessionCsrfToken } from "../lib/auth.js";
import type { Theme } from "../types.js";
import { updateUserTheme } from "../lib/userStore.js";

const VALID_THEMES: ReadonlySet<string> = new Set(["light", "dark", "system"]);

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
};

export const registerUserRoutes = async (app: FastifyInstance): Promise<void> => {
  // GET /api/user/me — returns public user data including theme; 401 if not logged in
  app.get("/api/user/me", { preHandler: [requireApiAuth] }, async (request, reply) => {
    const user = request.currentUser;
    if (!user) {
      return reply.code(401).send({ error: "Nicht angemeldet." });
    }

    return reply.send({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      theme: user.theme ?? "system",
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt ?? null
    });
  });

  // POST /api/user/theme — persists theme for logged-in user
  app.post(
    "/api/user/theme",
    {
      preHandler: [requireApiAuth],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      const user = request.currentUser;
      if (!user) {
        return reply.code(401).send({ error: "Nicht angemeldet." });
      }

      const body = asRecord(request.body);

      // CSRF check via X-CSRF-Token header or body field
      const csrfFromHeader = request.headers["x-csrf-token"];
      const csrfToken = typeof csrfFromHeader === "string" ? csrfFromHeader : (body["_csrf"] as string | undefined) ?? "";
      if (!verifySessionCsrfToken(request, csrfToken)) {
        return reply.code(403).send({ error: "Ungültiges CSRF-Token." });
      }

      const theme = body["theme"];
      if (typeof theme !== "string" || !VALID_THEMES.has(theme)) {
        return reply.code(400).send({ error: "Ungültiges Theme. Erlaubt: light, dark, system." });
      }

      await updateUserTheme(user.id, theme as Theme);

      return reply.send({ ok: true, theme });
    }
  );
};
