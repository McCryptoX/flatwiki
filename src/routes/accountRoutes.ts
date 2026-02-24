import type { FastifyInstance } from "fastify";
import { clearSessionCookie, requireAuth, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import { listNotificationsForUser, markAllNotificationsRead, markNotificationRead } from "../lib/notificationStore.js";
import { escapeHtml, formatDate, renderLayout } from "../lib/render.js";
import { listWatchedSlugsByUser } from "../lib/watchStore.js";
import { changeUserPassword, updateUser } from "../lib/userStore.js";
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

    const inputClass =
      "bg-slate-950 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
    const secondaryButtonClass =
      "bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-lg font-medium transition-colors border border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-400/30";
    const primaryButtonClass =
      "bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400/30";
    const tableWrapperClass = "bg-slate-900 border border-slate-800 rounded-2xl shadow-sm overflow-hidden";
    const tableClass = "w-full text-left text-sm text-slate-300 whitespace-nowrap";

    const myArticlesSection =
      myArticles.length > 0
        ? `
          <div class="${tableWrapperClass}">
            <div class="overflow-x-auto">
            <table class="${tableClass}">
              <thead class="bg-slate-950/50 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                <tr>
                  <th class="px-5 py-4">Titel</th>
                  <th class="px-5 py-4">Slug</th>
                  <th class="px-5 py-4">Erstellt</th>
                  <th class="px-5 py-4">Zuletzt geändert</th>
                </tr>
              </thead>
              <tbody>
                ${myArticles
                  .map(
                    (article) => `
                  <tr class="border-t border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td class="px-5 py-4"><a href="/wiki/${encodeURIComponent(article.slug)}">${escapeHtml(article.title)}</a></td>
                    <td class="px-5 py-4"><code>${escapeHtml(article.slug)}</code></td>
                    <td class="px-5 py-4">${escapeHtml(formatDate(article.createdAt))}</td>
                    <td class="px-5 py-4">${escapeHtml(formatDate(article.updatedAt))}</td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
            </div>
          </div>
        `
        : '<p class="text-sm text-slate-400">Du hast bisher keine eigenen Artikel erstellt.</p>';

    const body = `
      <section class="max-w-7xl mx-auto p-6 md:p-8 space-y-6 text-slate-100">
        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6">
          <h1 class="text-2xl font-semibold text-slate-100 mb-1">Mein Konto</h1>
          <p class="text-sm text-slate-400 mb-4">Übersicht deiner Stammdaten und Profileinstellungen.</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div class="rounded-xl border border-slate-800/70 bg-slate-950/50 p-4">
              <strong class="block mb-1 text-slate-300">Benutzername</strong>
              <p>${escapeHtml(user.username)}</p>
            </div>
            <div class="rounded-xl border border-slate-800/70 bg-slate-950/50 p-4">
              <strong class="block mb-1 text-slate-300">Anzeigename</strong>
              <p>${escapeHtml(user.displayName)}</p>
            </div>
            <div class="rounded-xl border border-slate-800/70 bg-slate-950/50 p-4">
              <strong class="block mb-1 text-slate-300">E-Mail</strong>
              <p>${user.email ? escapeHtml(user.email) : '<span class="text-slate-500">Keine E-Mail hinterlegt</span>'}</p>
            </div>
            <div class="rounded-xl border border-slate-800/70 bg-slate-950/50 p-4">
              <strong class="block mb-1 text-slate-300">Rolle</strong>
              <p>${escapeHtml(user.role)}</p>
            </div>
            <div class="rounded-xl border border-slate-800/70 bg-slate-950/50 p-4">
              <strong class="block mb-1 text-slate-300">Erstellt</strong>
              <p>${escapeHtml(formatDate(user.createdAt))}</p>
            </div>
          </div>
        </section>

        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6">
          <h2 class="text-base font-semibold text-white">Passwort</h2>
          <p class="text-sm text-slate-400 mt-1">Sicherheitsrelevante Kontodaten aktualisieren.</p>
          <form method="post" action="/account/password" class="mt-4">
            <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
            <div class="w-full max-w-xl space-y-4">
              <label class="text-sm text-slate-300">Aktuelles Passwort
                <input class="${inputClass}" type="password" name="oldPassword" required autocomplete="current-password" />
              </label>
              <label class="text-sm text-slate-300">Neues Passwort
                <input class="${inputClass}" type="password" name="newPassword" required minlength="12" autocomplete="new-password" />
              </label>
              <label class="text-sm text-slate-300">Neues Passwort wiederholen
                <input class="${inputClass}" type="password" name="confirmPassword" required minlength="12" autocomplete="new-password" />
              </label>
              <div class="mt-4 flex justify-end gap-2">
                <button class="${primaryButtonClass}" type="submit">Passwort aktualisieren</button>
              </div>
            </div>
          </form>
        </section>

        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6">
          <h2 class="text-base font-semibold text-white">E-Mail</h2>
          <p class="text-sm text-slate-400 mt-1">Wird für Benachrichtigungen per E-Mail genutzt. Optional.</p>
          <form method="post" action="/account/email" class="mt-4">
            <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
            <div class="w-full max-w-xl space-y-4">
              <label class="text-sm text-slate-300">E-Mail-Adresse
                <input class="${inputClass}" type="email" name="email" value="${escapeHtml(user.email ?? "")}" autocomplete="email" placeholder="du@example.com" />
              </label>
              <div class="mt-4 flex justify-end gap-2">
                <button class="${primaryButtonClass}" type="submit">E-Mail aktualisieren</button>
              </div>
            </div>
          </form>
        </section>

        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 space-y-4">
          <h2 class="text-base font-semibold text-white">Beobachtete Seiten</h2>
          <p class="text-sm text-slate-400">${watchedPages.length} Seiten auf deiner Watchlist.</p>
          ${
            watchedPages.length < 1
              ? '<p class="text-sm text-slate-400">Noch keine beobachteten Seiten. Öffne einen Artikel und klicke auf „Beobachten“.</p>'
              : `
                <div class="${tableWrapperClass}">
                  <div class="overflow-x-auto">
                  <table class="${tableClass}">
                    <thead class="bg-slate-950/50 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      <tr>
                        <th class="px-5 py-4">Titel</th>
                        <th class="px-5 py-4">Kategorie</th>
                        <th class="px-5 py-4">Zuletzt geändert</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${watchedPages
                        .map(
                          (page) => `
                            <tr class="border-t border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                              <td class="px-5 py-4"><a href="/wiki/${encodeURIComponent(page.slug)}">${escapeHtml(page.title)}</a></td>
                              <td class="px-5 py-4">${escapeHtml(page.categoryName)}</td>
                              <td class="px-5 py-4">${escapeHtml(formatDate(page.updatedAt))}</td>
                            </tr>
                          `
                        )
                        .join("")}
                    </tbody>
                  </table>
                  </div>
                </div>
              `
          }
        </section>

        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6">
          <h2 class="text-base font-semibold text-white">Benachrichtigungen</h2>
          <p class="text-sm text-slate-400 mt-1 mb-4">Erwähnungen, Kommentare und Updates beobachteter Seiten findest du in deiner Inbox.</p>
          <div class="mt-4 flex justify-end gap-2">
            <a class="${secondaryButtonClass}" href="/notifications">Inbox öffnen</a>
          </div>
        </section>

        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6">
          <h2 class="text-base font-semibold text-white">Datenexport (Datenschutz)</h2>
          <p class="text-sm text-slate-400 mt-1 mb-4">Du kannst deine gespeicherten Kontodaten inklusive eigener Artikelübersicht und Markdown-Speicherdump als JSON exportieren.</p>
          <div class="mt-4 flex justify-end gap-2">
            <a class="${secondaryButtonClass}" href="/account/export">Meine Daten herunterladen</a>
          </div>
        </section>

        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 space-y-4">
          <h2 class="text-base font-semibold text-white">Meine Artikel</h2>
          <p class="text-sm text-slate-400 mt-1">${myArticles.length} Artikel von dir erstellt. (Kriterium: <code>createdBy</code>, bei Altseiten Fallback auf <code>updatedBy</code>)</p>
          ${myArticlesSection}
        </section>
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

  app.post("/account/email", { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.currentUser;
    if (!user) return reply.redirect("/login");

    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const result = await updateUser(user.id, {
      displayName: user.displayName,
      role: user.role,
      disabled: user.disabled,
      email: body.email ?? ""
    });

    if (!result.user) {
      return reply.redirect(`/account?error=${encodeURIComponent(result.error ?? "E-Mail konnte nicht gespeichert werden.")}`);
    }

    return reply.redirect("/account?notice=E-Mail+aktualisiert.");
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
