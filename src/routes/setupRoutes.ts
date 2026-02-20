import type { FastifyInstance } from "fastify";
import {
  clearLoginCsrfToken,
  createLoginCsrfToken,
  setSessionCookie,
  verifyLoginCsrfToken
} from "../lib/auth.js";
import { config } from "../config.js";
import { validatePasswordStrength } from "../lib/password.js";
import { escapeHtml, renderLayout } from "../lib/render.js";
import { createSession } from "../lib/sessionStore.js";
import { hasAnyUser, setupInitialAdmin } from "../lib/userStore.js";
import { writeAuditLog } from "../lib/audit.js";

const asRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, string>;
};

export const registerSetupRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/setup", async (request, reply) => {
    const usersExist = await hasAnyUser();
    if (usersExist) {
      return reply.redirect(request.currentUser ? "/" : "/login");
    }

    const query = asRecord(request.query);
    const csrf = createLoginCsrfToken(reply);

    const body = `
      <section class="auth-shell">
        <article class="auth-card">
          <h1>Ersteinrichtung</h1>
          <p>Lege den ersten Administrator an. Danach ist das Wiki sofort nutzbar.</p>
          <form method="post" action="/setup" class="stack">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}" />
            <label>Admin-Benutzername
              <input type="text" name="username" value="${escapeHtml(query.username ?? config.bootstrapAdminUsername)}" pattern="[a-z0-9._-]{3,32}" required />
            </label>
            <label>Anzeigename
              <input type="text" name="displayName" value="${escapeHtml(query.displayName ?? "Administrator")}" minlength="2" maxlength="80" required />
            </label>
            <label>Passwort
              <input type="password" name="password" autocomplete="new-password" minlength="12" required />
            </label>
            <label>Passwort wiederholen
              <input type="password" name="passwordConfirm" autocomplete="new-password" minlength="12" required />
            </label>
            <button type="submit">Setup abschließen</button>
          </form>
          <p class="muted-note">Sicherheitswerte wie <code>COOKIE_SECRET</code>, <code>PASSWORD_PEPPER</code>, <code>CONTENT_ENCRYPTION_KEY</code>, <code>CONTENT_INTEGRITY_KEY</code> und <code>BACKUP_ENCRYPTION_KEY</code> werden automatisch gesetzt.</p>
        </article>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Ersteinrichtung",
        body,
        error: query.error,
        notice: query.notice
      })
    );
  });

  app.post("/setup", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const usersExist = await hasAnyUser();
    if (usersExist) {
      return reply.redirect(request.currentUser ? "/" : "/login");
    }

    const body = asRecord(request.body);
    if (!verifyLoginCsrfToken(request, body._csrf ?? "")) {
      return reply.redirect("/setup?error=Ung%C3%BCltiges+CSRF-Token");
    }

    const username = (body.username ?? "").trim().toLowerCase();
    const displayName = (body.displayName ?? "").trim();
    const password = body.password ?? "";
    const passwordConfirm = body.passwordConfirm ?? "";

    if (password !== passwordConfirm) {
      return reply.redirect(
        `/setup?error=${encodeURIComponent("Passwörter stimmen nicht überein.")}&username=${encodeURIComponent(
          username
        )}&displayName=${encodeURIComponent(displayName)}`
      );
    }

    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      return reply.redirect(
        `/setup?error=${encodeURIComponent(passwordError)}&username=${encodeURIComponent(username)}&displayName=${encodeURIComponent(
          displayName
        )}`
      );
    }

    const result = await setupInitialAdmin({
      username,
      displayName,
      password
    });

    if (!result.user) {
      return reply.redirect(
        `/setup?error=${encodeURIComponent(result.error ?? "Setup fehlgeschlagen.")}&username=${encodeURIComponent(
          username
        )}&displayName=${encodeURIComponent(displayName)}`
      );
    }

    const rawUserAgent = request.headers["user-agent"];
    const userAgent = Array.isArray(rawUserAgent) ? rawUserAgent.join(" ") : rawUserAgent;
    const session = await createSession(result.user.id, request.ip, userAgent);
    setSessionCookie(reply, session.id);
    clearLoginCsrfToken(reply);

    await writeAuditLog({
      action: "initial_setup_completed",
      actorId: result.user.id
    });

    return reply.redirect("/?notice=Ersteinrichtung+abgeschlossen");
  });
};
