import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { requireApiAuth, verifySessionCsrfToken } from "../lib/auth.js";
import type { PublicUser, Theme } from "../types.js";
import { findUserById, updateUserTheme } from "../lib/userStore.js";

const VALID_THEMES: ReadonlySet<string> = new Set(["light", "dark", "system"]);

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
};

const createStrongEtag = (value: string): string => `"${createHash("sha256").update(value, "utf8").digest("hex")}"`;

const normalizeWeakEtag = (value: string): string => value.trim().replace(/^W\//i, "");

const ifNoneMatchMatches = (ifNoneMatchHeader: string | string[] | undefined, etag: string): boolean => {
  if (!ifNoneMatchHeader) return false;
  const value = Array.isArray(ifNoneMatchHeader) ? ifNoneMatchHeader.join(",") : ifNoneMatchHeader;
  const candidates = value.split(",").map((entry) => entry.trim());
  if (candidates.includes("*")) return true;
  const normalizedExpected = normalizeWeakEtag(etag);
  return candidates.some((entry) => normalizeWeakEtag(entry) === normalizedExpected);
};

const ifMatchMatches = (ifMatchHeader: string | string[] | undefined, etag: string): boolean => {
  if (!ifMatchHeader) return true;
  const value = Array.isArray(ifMatchHeader) ? ifMatchHeader.join(",") : ifMatchHeader;
  const candidates = value.split(",").map((entry) => entry.trim());
  if (candidates.includes("*")) return true;
  return candidates.some((entry) => entry === etag);
};

const buildUserMePayload = (user: PublicUser): Record<string, string | null> => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  role: user.role,
  theme: user.theme ?? "system",
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  lastLoginAt: user.lastLoginAt ?? null
});

const buildUserMeEtag = (user: PublicUser): string => createStrongEtag(JSON.stringify(buildUserMePayload(user)));

export const registerUserRoutes = async (app: FastifyInstance): Promise<void> => {
  // GET /api/user/me — returns public user data including theme; 401 if not logged in
  app.get("/api/user/me", { preHandler: [requireApiAuth] }, async (request, reply) => {
    const user = request.currentUser;
    if (!user) {
      return reply.code(401).send({ error: "Nicht angemeldet." });
    }

    const etag = buildUserMeEtag(user);
    reply.header("ETag", etag);
    reply.header("Cache-Control", "private, no-cache");
    if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
      return reply.code(304).send();
    }

    return reply.send(buildUserMePayload(user));
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

      const currentEtag = buildUserMeEtag(user);
      reply.header("ETag", currentEtag);
      if (!ifMatchMatches(request.headers["if-match"], currentEtag)) {
        return reply.code(412).send({
          ok: false,
          error: "Precondition Failed: If-Match passt nicht zur aktuellen Benutzer-Version."
        });
      }

      await updateUserTheme(user.id, theme as Theme);
      const updatedUser = await findUserById(user.id);
      if (!updatedUser) {
        return reply.code(404).send({ ok: false, error: "Benutzer nicht gefunden." });
      }

      const updatedEtag = buildUserMeEtag(updatedUser);
      reply.header("ETag", updatedEtag);

      return reply.send({ ok: true, theme, updatedAt: updatedUser.updatedAt });
    }
  );
};
