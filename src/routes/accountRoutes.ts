import type { FastifyInstance } from "fastify";
import { clearSessionCookie, requireAuth, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import { listNotificationsForUser, markAllNotificationsRead, markNotificationRead } from "../lib/notificationStore.js";
import { escapeHtml, formatDate, renderLayout } from "../lib/render.js";
import { listWatchedSlugsByUser } from "../lib/watchStore.js";
import { changeUserPassword } from "../lib/userStore.js";
import { validatePasswordStrength } from "../lib/password.js";
import { deleteUserSessions } from "../lib/sessionStore.js";
import { exportPagesCreatedByUser, listPagesCreatedByUser, listPagesForUser } from "../lib/wikiStore.js";

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

    const myArticles = await listPagesCreatedByUser(user.username);
    const watchedSlugs = await listWatchedSlugsByUser(user.id);
    const visiblePages = await listPagesForUser(user);
    const pagesBySlug = new Map(visiblePages.map((page) => [page.slug, page] as const));
    const watchedPages = watchedSlugs
      .map((slug) => pagesBySlug.get(slug))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const myArticlesSection =
      myArticles.length > 0
        ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Slug</th>
                  <th>Erstellt</th>
                  <th>Zuletzt geändert</th>
                </tr>
              </thead>
              <tbody>
                ${myArticles
                  .map(
                    (article) => `
                  <tr>
                    <td><a href="/wiki/${encodeURIComponent(article.slug)}">${escapeHtml(article.title)}</a></td>
                    <td><code>${escapeHtml(article.slug)}</code></td>
                    <td>${escapeHtml(formatDate(article.createdAt))}</td>
                    <td>${escapeHtml(formatDate(article.updatedAt))}</td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : '<p class="empty">Du hast bisher keine eigenen Artikel erstellt.</p>';

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
        <h2>Beobachtete Seiten</h2>
        <p>${watchedPages.length} Seiten auf deiner Watchlist.</p>
        ${
          watchedPages.length < 1
            ? '<p class="empty">Noch keine beobachteten Seiten. Öffne einen Artikel und klicke auf „Beobachten“.</p>'
            : `
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Titel</th>
                      <th>Kategorie</th>
                      <th>Zuletzt geändert</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${watchedPages
                      .map(
                        (page) => `
                          <tr>
                            <td><a href="/wiki/${encodeURIComponent(page.slug)}">${escapeHtml(page.title)}</a></td>
                            <td>${escapeHtml(page.categoryName)}</td>
                            <td>${escapeHtml(formatDate(page.updatedAt))}</td>
                          </tr>
                        `
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>
            `
        }

        <hr />
        <h2>Benachrichtigungen</h2>
        <p>Erwähnungen, Kommentare und Updates beobachteter Seiten findest du in deiner Inbox.</p>
        <a class="button secondary" href="/notifications">Inbox öffnen</a>

        <hr />
        <h2>Datenexport (Datenschutz)</h2>
        <p>Du kannst deine gespeicherten Kontodaten inklusive eigener Artikelübersicht und Markdown-Speicherdump als JSON exportieren.</p>
        <a class="button secondary" href="/account/export">Meine Daten herunterladen</a>

        <hr />
        <h2>Meine Artikel</h2>
        <p>${myArticles.length} Artikel von dir erstellt. (Kriterium: <code>createdBy</code>, bei Altseiten Fallback auf <code>updatedBy</code>)</p>
        ${myArticlesSection}
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Mein Konto",
        body,
        user,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/account/password", { preHandler: [requireAuth], config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
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

    const myArticles = await exportPagesCreatedByUser(user.username);

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
      },
      authoredArticles: myArticles.map((article) => ({
        slug: article.slug,
        title: article.title,
        tags: article.tags,
        createdAt: article.createdAt,
        updatedAt: article.updatedAt,
        updatedBy: article.updatedBy
      })),
      storageDump: {
        format: "markdown",
        files: myArticles.map((article) => ({
          path: article.storagePath,
          markdown: article.markdown
        }))
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

  app.get("/notifications", { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.currentUser;
    if (!user) {
      return reply.redirect("/login");
    }

    const notifications = await listNotificationsForUser(user.id, 120);
    const query = asRecord(request.query);

    const body = `
      <section class="content-wrap stack large">
        <div class="page-header">
          <div>
            <h1>Benachrichtigungen</h1>
            <p>${notifications.length} Einträge</p>
          </div>
          <form method="post" action="/notifications/mark-all-read" class="action-row">
            <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
            <button type="submit" class="secondary tiny">Alle als gelesen markieren</button>
          </form>
        </div>
        ${
          notifications.length < 1
            ? '<p class="empty">Keine Benachrichtigungen vorhanden.</p>'
            : `
              <ul class="notification-list">
                ${notifications
                  .map(
                    (notification) => `
                      <li class="notification-item ${notification.readAt ? "is-read" : "is-unread"}">
                        <div class="notification-main">
                          <a href="${escapeHtml(notification.url)}">${escapeHtml(notification.title)}</a>
                          <p>${escapeHtml(notification.body || "-")}</p>
                          <span class="muted-note small">${escapeHtml(formatDate(notification.createdAt))}${
                            notification.readAt ? ` • gelesen ${escapeHtml(formatDate(notification.readAt))}` : ""
                          }</span>
                        </div>
                        ${
                          notification.readAt
                            ? ""
                            : `
                              <form method="post" action="/notifications/${encodeURIComponent(notification.id)}/read">
                                <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
                                <button type="submit" class="tiny secondary">Als gelesen</button>
                              </form>
                            `
                        }
                      </li>
                    `
                  )
                  .join("")}
              </ul>
            `
        }
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Benachrichtigungen",
        body,
        user,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/notifications/:id/read", { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.currentUser;
    if (!user) {
      return reply.redirect("/login");
    }

    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const params = request.params as { id: string };
    await markNotificationRead({
      userId: user.id,
      notificationId: params.id
    });

    return reply.redirect("/notifications");
  });

  app.post("/notifications/mark-all-read", { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.currentUser;
    if (!user) {
      return reply.redirect("/login");
    }

    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const changed = await markAllNotificationsRead(user.id);
    return reply.redirect(`/notifications?notice=${encodeURIComponent(`${changed} Benachrichtigung(en) als gelesen markiert.`)}`);
  });
};
