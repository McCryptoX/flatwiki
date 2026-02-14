import type { FastifyInstance } from "fastify";
import { clearSessionCookie, requireAuth, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import { escapeHtml, formatDate, renderLayout } from "../lib/render.js";
import { changeUserPassword } from "../lib/userStore.js";
import { validatePasswordStrength } from "../lib/password.js";
import { deleteUserSessions } from "../lib/sessionStore.js";

const asRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, string>;
};

export const registerAccountRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/account", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = asRecord(request.query);
    const user = request.currentUser;

    if (!user) {
      return reply.redirect("/login");
    }

    const body = `
      <section class="content-wrap">
        <h1>Mein Konto</h1>
        <div class="profile-grid">
          <div>
            <strong>Benutzername</strong>
            <p>${escapeHtml(user.username)}</p>
          </div>
          <div>
            <strong>Anzeigename</strong>
            <p>${escapeHtml(user.displayName)}</p>
          </div>
          <div>
            <strong>Rolle</strong>
            <p>${escapeHtml(user.role)}</p>
          </div>
          <div>
            <strong>Erstellt</strong>
            <p>${escapeHtml(formatDate(user.createdAt))}</p>
          </div>
        </div>

        <h2>Passwort ändern</h2>
        <form method="post" action="/account/password" class="stack">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <label>Aktuelles Passwort
            <input type="password" name="oldPassword" required autocomplete="current-password" />
          </label>
          <label>Neues Passwort
            <input type="password" name="newPassword" required minlength="12" autocomplete="new-password" />
          </label>
          <label>Neues Passwort wiederholen
            <input type="password" name="confirmPassword" required minlength="12" autocomplete="new-password" />
          </label>
          <button type="submit">Passwort aktualisieren</button>
        </form>

        <hr />
        <h2>Datenexport (DSGVO)</h2>
        <p>Du kannst deine gespeicherten Kontodaten als JSON exportieren.</p>
        <a class="button secondary" href="/account/export">Meine Daten herunterladen</a>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Mein Konto",
        body,
        user,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/account/password", { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.currentUser;
    if (!user) {
      return reply.redirect("/login");
    }

    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const oldPassword = body.oldPassword ?? "";
    const newPassword = body.newPassword ?? "";
    const confirmPassword = body.confirmPassword ?? "";

    if (newPassword !== confirmPassword) {
      return reply.redirect("/account?error=Neue+Passw%C3%B6rter+stimmen+nicht+%C3%BCberein");
    }

    const passwordError = validatePasswordStrength(newPassword);
    if (passwordError) {
      return reply.redirect(`/account?error=${encodeURIComponent(passwordError)}`);
    }

    const result = await changeUserPassword(user.id, oldPassword, newPassword);
    if (!result.ok) {
      return reply.redirect(`/account?error=${encodeURIComponent(result.error ?? "Passwort konnte nicht geändert werden")}`);
    }

    await deleteUserSessions(user.id);
    clearSessionCookie(reply);

    await writeAuditLog({
      action: "user_password_changed",
      actorId: user.id
    });

    return reply.redirect("/login?notice=Passwort+ge%C3%A4ndert.+Bitte+neu+anmelden.");
  });

  app.get("/account/export", { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.currentUser;
    if (!user) {
      return reply.redirect("/login");
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt ?? null,
        disabled: user.disabled
      }
    };

    await writeAuditLog({
      action: "user_data_export",
      actorId: user.id
    });

    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="flatwiki-export-${user.username}.json"`);
    return reply.send(`${JSON.stringify(payload, null, 2)}\n`);
  });
};
