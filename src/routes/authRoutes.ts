import type { FastifyInstance } from "fastify";
import {
  clearLoginCsrfToken,
  clearSessionCookie,
  createLoginCsrfToken,
  requireAuth,
  setSessionCookie,
  verifyLoginCsrfToken,
  verifySessionCsrfToken
} from "../lib/auth.js";
import { createSession, deleteSession } from "../lib/sessionStore.js";
import { escapeHtml, renderLayout } from "../lib/render.js";
import { hasAnyUser, touchLastLogin, verifyUserCredentials } from "../lib/userStore.js";
import { writeAuditLog } from "../lib/audit.js";

const asRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, string>;
};

const readQuery = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, string>;
};

const sanitizeNextPath = (nextPath: string | undefined): string => {
  if (!nextPath || !nextPath.startsWith("/")) return "/";
  if (nextPath.startsWith("//")) return "/";
  return nextPath;
};

export const registerAuthRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/login", async (request, reply) => {
    const usersExist = await hasAnyUser();
    if (!usersExist) {
      return reply.redirect("/setup");
    }

    if (request.currentUser) {
      return reply.redirect("/");
    }

    const query = readQuery(request.query);
    const csrf = createLoginCsrfToken(reply);
    const next = sanitizeNextPath(query.next);
    const error = query.error;
    const notice = query.notice;

    const body = `
      <section class="auth-shell">
        <article class="auth-card">
          <h1>Anmeldung</h1>
          <p>Melde dich mit deinem Konto an.</p>
          <form method="post" action="/login" class="stack">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}" />
            <input type="hidden" name="next" value="${escapeHtml(next)}" />
            <label>Benutzername
              <input type="text" name="username" autocomplete="username" required />
            </label>
            <label>Passwort
              <input type="password" name="password" autocomplete="current-password" required />
            </label>
            <button type="submit">Anmelden</button>
          </form>
          <p class="muted-note">
            Kein Konto? Beim Erststart zuerst <a href="/setup">Setup</a> ausführen, danach Benutzer im Admin-Bereich anlegen.
          </p>
        </article>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Anmeldung",
        body,
        error,
        notice
      })
    );
  });

  app.post(
    "/login",
    {
      config: {
        rateLimit: {
          // Login is brute-force sensitive, so we enforce a stricter per-route cap.
          max: 5,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const usersExist = await hasAnyUser();
      if (!usersExist) {
        return reply.redirect("/setup");
      }

      const body = asRecord(request.body);
      const token = body._csrf ?? "";
      const next = sanitizeNextPath(body.next);

      if (!verifyLoginCsrfToken(request, token)) {
        return reply.redirect("/login?error=Ung%C3%BCltiges+CSRF-Token");
      }

      const username = body.username ?? "";
      const password = body.password ?? "";
      const { user, error } = await verifyUserCredentials(username, password);

      if (!user) {
        await writeAuditLog({
          action: "login_failed",
          details: {
            username,
            ip: request.ip
          }
        });
        return reply.redirect(`/login?error=${encodeURIComponent(error ?? "Anmeldung fehlgeschlagen")}`);
      }

      const rawUserAgent = request.headers["user-agent"];
      const userAgent = Array.isArray(rawUserAgent) ? rawUserAgent.join(" ") : rawUserAgent;

      const session = await createSession(user.id, request.ip, userAgent);
      setSessionCookie(reply, session.id);
      clearLoginCsrfToken(reply);
      await touchLastLogin(user.id);

      await writeAuditLog({
        action: "login_success",
        actorId: user.id,
        details: {
          ip: request.ip
        }
      });

      return reply.redirect(next);
    }
  );

  app.post("/logout", { preHandler: [requireAuth] }, async (request, reply) => {
    const body = asRecord(request.body);
    const token = body._csrf ?? "";
    if (!verifySessionCsrfToken(request, token)) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const sessionId = request.currentSessionId;
    if (sessionId) {
      await deleteSession(sessionId);
    }
    clearSessionCookie(reply);

    if (request.currentUser) {
      await writeAuditLog({
        action: "logout",
        actorId: request.currentUser.id
      });
    }

    return reply.redirect("/login");
  });
};
