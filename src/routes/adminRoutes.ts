import type { FastifyInstance } from "fastify";
import { requireAdmin, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import {
  cleanupUnusedUploads,
  deleteUploadFile,
  getUploadUsageReport,
  normalizeUploadFileName
} from "../lib/mediaStore.js";
import { escapeHtml, formatDate, renderLayout } from "../lib/render.js";
import {
  createUser,
  deleteUser,
  findUserById,
  listUsers,
  setUserPasswordByAdmin,
  updateUser,
  validateUserInput
} from "../lib/userStore.js";
import { validatePasswordStrength } from "../lib/password.js";
import { deleteUserSessions } from "../lib/sessionStore.js";

const asRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, string>;
};

const renderUsersTable = (csrfToken: string, ownUserId: string, users: Awaited<ReturnType<typeof listUsers>>): string => {
  if (users.length === 0) {
    return '<p class="empty">Noch keine Benutzer vorhanden.</p>';
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Benutzername</th>
            <th>Anzeigename</th>
            <th>Rolle</th>
            <th>Status</th>
            <th>Zuletzt aktiv</th>
            <th>Aktionen</th>
          </tr>
        </thead>
        <tbody>
          ${users
            .map(
              (user) => `
                <tr>
                  <td>${escapeHtml(user.username)}</td>
                  <td>${escapeHtml(user.displayName)}</td>
                  <td>${escapeHtml(user.role)}</td>
                  <td>${user.disabled ? "deaktiviert" : "aktiv"}</td>
                  <td>${user.lastLoginAt ? escapeHtml(formatDate(user.lastLoginAt)) : "-"}</td>
                  <td>
                    <div class="action-row">
                      <a class="button tiny" href="/admin/users/${escapeHtml(user.id)}/edit">Bearbeiten</a>
                      ${
                        user.id !== ownUserId
                          ? `<form method="post" action="/admin/users/${escapeHtml(
                              user.id
                            )}/delete" onsubmit="return confirm('Benutzer wirklich löschen?')"><input type="hidden" name="_csrf" value="${escapeHtml(
                              csrfToken
                            )}" /><button class="danger tiny" type="submit">Löschen</button></form>`
                          : ""
                      }
                    </div>
                  </td>
                </tr>
              `
            )
            .join("\n")}
        </tbody>
      </table>
    </div>
  `;
};

const roleOptions = (role: "admin" | "user"): string => `
  <option value="user" ${role === "user" ? "selected" : ""}>user</option>
  <option value="admin" ${role === "admin" ? "selected" : ""}>admin</option>
`;

const formatFileSize = (sizeBytes: number): string => {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
};

const renderMediaTable = (
  csrfToken: string,
  report: Awaited<ReturnType<typeof getUploadUsageReport>>
): string => {
  if (report.files.length === 0) {
    return '<p class="empty">Keine hochgeladenen Bilddateien vorhanden.</p>';
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Datei</th>
            <th>Größe</th>
            <th>Zuletzt geändert</th>
            <th>Einbindung</th>
            <th>Aktionen</th>
          </tr>
        </thead>
        <tbody>
          ${report.files
            .map((file) => {
              const references =
                file.referencedBy.length > 0
                  ? `<div class="media-ref-list">
                      ${file.referencedBy
                        .map(
                          (ref) => `<a href="/wiki/${escapeHtml(ref.slug)}">${escapeHtml(ref.title)} (${escapeHtml(ref.slug)})</a>`
                        )
                        .join("")}
                    </div>`
                  : '<span class="media-ref-empty">nicht eingebunden</span>';

              const actionHtml =
                file.referencedBy.length > 0
                  ? `
                      <div class="action-row">
                        <button type="button" class="secondary tiny" disabled>In Nutzung (${file.referencedBy.length})</button>
                        <form method="post" action="/admin/media/delete" onsubmit="return confirm('Datei ist noch eingebunden. Wirklich erzwungen löschen?')">
                          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
                          <input type="hidden" name="fileName" value="${escapeHtml(file.fileName)}" />
                          <input type="hidden" name="force" value="1" />
                          <button type="submit" class="danger tiny">Erzwingen</button>
                        </form>
                      </div>
                    `
                  : `
                      <form method="post" action="/admin/media/delete" onsubmit="return confirm('Datei wirklich löschen?')">
                        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
                        <input type="hidden" name="fileName" value="${escapeHtml(file.fileName)}" />
                        <button type="submit" class="danger tiny">Löschen</button>
                      </form>
                    `;

              return `
                <tr>
                  <td>
                    <a href="${escapeHtml(file.url)}" target="_blank" rel="noreferrer">${escapeHtml(file.fileName)}</a>
                  </td>
                  <td>${escapeHtml(formatFileSize(file.sizeBytes))}</td>
                  <td>${escapeHtml(formatDate(file.modifiedAt))}</td>
                  <td>${references}</td>
                  <td>${actionHtml}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
};

const renderMissingMediaReferences = (report: Awaited<ReturnType<typeof getUploadUsageReport>>): string => {
  if (report.missingReferences.length === 0) return "";

  return `
    <hr />
    <h2>Defekte Bildverweise</h2>
    <p class="muted-note">Diese Dateien werden in Artikeln referenziert, liegen aber nicht mehr im Upload-Ordner.</p>
    <ul class="media-missing-list">
      ${report.missingReferences
        .map(
          (entry) => `
            <li>
              <code>/uploads/${escapeHtml(entry.fileName)}</code>
              <span>verwendet in:</span>
              ${entry.referencedBy
                .map((ref) => `<a href="/wiki/${escapeHtml(ref.slug)}">${escapeHtml(ref.title)} (${escapeHtml(ref.slug)})</a>`)
                .join(", ")}
            </li>
          `
        )
        .join("")}
    </ul>
  `;
};

export const registerAdminRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/admin/users", { preHandler: [requireAdmin] }, async (request, reply) => {
    const users = await listUsers();
    const query = asRecord(request.query);

    const body = `
      <section class="page-header">
        <div>
          <h1>Benutzerverwaltung</h1>
          <p>Konten DSGVO-bewusst verwalten (minimal gespeicherte Stammdaten).</p>
        </div>
        <div class="action-row">
          <a class="button secondary" href="/admin/media">Bildverwaltung</a>
          <a class="button" href="/admin/users/new">Neuen Benutzer anlegen</a>
        </div>
      </section>
      ${renderUsersTable(request.csrfToken ?? "", request.currentUser?.id ?? "", users)}
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Benutzerverwaltung",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.get("/admin/media", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const report = await getUploadUsageReport();
    const orphanCount = report.files.filter((file) => file.referencedBy.length === 0).length;

    const body = `
      <section class="page-header">
        <div>
          <h1>Bildverwaltung</h1>
          <p>Upload-Dateien prüfen, Referenzen nachvollziehen und unbenutzte Bilder entfernen.</p>
        </div>
        <div class="action-row">
          <a class="button secondary" href="/admin/users">Benutzerverwaltung</a>
          <form method="post" action="/admin/media/cleanup" onsubmit="return confirm('Alle ungenutzten Bilddateien wirklich löschen?')">
            <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
            <button type="submit">Ungenutzte Bilder löschen</button>
          </form>
        </div>
      </section>
      <section class="content-wrap">
        <p>
          ${report.files.length} Upload-Datei(en), ${escapeHtml(formatFileSize(report.totalSizeBytes))} gesamt,
          ${orphanCount} ungenutzt.
        </p>
        ${renderMediaTable(request.csrfToken ?? "", report)}
        ${renderMissingMediaReferences(report)}
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Bildverwaltung",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/admin/media/cleanup", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const cleanupResult = await cleanupUnusedUploads();

    await writeAuditLog({
      action: "admin_media_cleanup",
      actorId: request.currentUser?.id,
      details: {
        deletedCount: cleanupResult.deleted.length
      }
    });

    const notice =
      cleanupResult.deleted.length > 0
        ? `${cleanupResult.deleted.length} ungenutzte Bilddatei(en) gelöscht.`
        : "Keine ungenutzten Bilddateien gefunden.";

    return reply.redirect(`/admin/media?notice=${encodeURIComponent(notice)}`);
  });

  app.post("/admin/media/delete", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const normalizedFileName = normalizeUploadFileName(body.fileName ?? "");
    if (!normalizedFileName) {
      return reply.redirect("/admin/media?error=Ung%C3%BCltiger+Dateiname");
    }

    const force = body.force === "1";
    const report = await getUploadUsageReport();
    const fileEntry = report.files.find((file) => file.fileName === normalizedFileName);

    if (!fileEntry) {
      return reply.redirect(`/admin/media?error=${encodeURIComponent(`Datei nicht gefunden: ${normalizedFileName}`)}`);
    }

    if (fileEntry.referencedBy.length > 0 && !force) {
      const locations = fileEntry.referencedBy.map((ref) => ref.slug);
      const preview = locations.slice(0, 5).join(", ");
      const suffix = locations.length > 5 ? ", ..." : "";
      return reply.redirect(
        `/admin/media?error=${encodeURIComponent(`Datei ist eingebunden in ${locations.length} Artikel(n): ${preview}${suffix}`)}`
      );
    }

    const removed = await deleteUploadFile(normalizedFileName);
    if (!removed) {
      return reply.redirect(`/admin/media?error=${encodeURIComponent(`Löschen fehlgeschlagen: ${normalizedFileName}`)}`);
    }

    await writeAuditLog({
      action: "admin_media_deleted",
      actorId: request.currentUser?.id,
      targetId: normalizedFileName,
      details: {
        forced: force,
        referencesBeforeDelete: fileEntry.referencedBy.length
      }
    });

    const notice =
      force && fileEntry.referencedBy.length > 0
        ? `Datei erzwungen gelöscht: ${normalizedFileName}`
        : `Datei gelöscht: ${normalizedFileName}`;

    return reply.redirect(`/admin/media?notice=${encodeURIComponent(notice)}`);
  });

  app.get("/admin/users/new", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);

    const body = `
      <section class="content-wrap">
        <h1>Neuen Benutzer anlegen</h1>
        <form method="post" action="/admin/users/new" class="stack large">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <label>Benutzername
            <input type="text" name="username" value="${escapeHtml(query.username ?? "")}" pattern="[a-z0-9._-]{3,32}" required />
          </label>
          <label>Anzeigename
            <input type="text" name="displayName" value="${escapeHtml(query.displayName ?? "")}" required />
          </label>
          <label>Rolle
            <select name="role">${roleOptions(query.role === "admin" ? "admin" : "user")}</select>
          </label>
          <label>Initiales Passwort
            <input type="password" name="password" required minlength="12" autocomplete="new-password" />
          </label>
          <button type="submit">Benutzer erstellen</button>
        </form>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Benutzer anlegen",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: query.error
      })
    );
  });

  app.post("/admin/users/new", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const username = body.username ?? "";
    const displayName = body.displayName ?? "";
    const role = body.role === "admin" ? "admin" : "user";
    const password = body.password ?? "";

    const baseValidation = validateUserInput({ username, displayName });
    if (baseValidation) {
      return reply.redirect(
        `/admin/users/new?error=${encodeURIComponent(baseValidation)}&username=${encodeURIComponent(username)}&displayName=${encodeURIComponent(displayName)}&role=${encodeURIComponent(role)}`
      );
    }

    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      return reply.redirect(
        `/admin/users/new?error=${encodeURIComponent(passwordError)}&username=${encodeURIComponent(username)}&displayName=${encodeURIComponent(displayName)}&role=${encodeURIComponent(role)}`
      );
    }

    const result = await createUser({
      username,
      displayName,
      role,
      password
    });

    if (!result.user) {
      return reply.redirect(
        `/admin/users/new?error=${encodeURIComponent(result.error ?? "Erstellen fehlgeschlagen")}&username=${encodeURIComponent(username)}&displayName=${encodeURIComponent(displayName)}&role=${encodeURIComponent(role)}`
      );
    }

    await writeAuditLog({
      action: "admin_user_created",
      actorId: request.currentUser?.id,
      targetId: result.user.id,
      details: { role: result.user.role }
    });

    return reply.redirect("/admin/users?notice=Benutzer+angelegt");
  });

  app.get("/admin/users/:id/edit", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { id: string };
    const user = await findUserById(params.id);
    if (!user) {
      return reply.redirect("/admin/users?error=Benutzer+nicht+gefunden");
    }

    const query = asRecord(request.query);

    const body = `
      <section class="content-wrap">
        <h1>Benutzer bearbeiten</h1>
        <form method="post" action="/admin/users/${escapeHtml(user.id)}/edit" class="stack large">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <label>Benutzername
            <input type="text" value="${escapeHtml(user.username)}" disabled />
          </label>
          <label>Anzeigename
            <input type="text" name="displayName" value="${escapeHtml(query.displayName ?? user.displayName)}" required />
          </label>
          <label>Rolle
            <select name="role">${roleOptions((query.role as "admin" | "user") ?? user.role)}</select>
          </label>
          <label>
            <input type="checkbox" name="disabled" value="1" ${query.disabled === "1" || (query.disabled === undefined && user.disabled) ? "checked" : ""} />
            Konto deaktivieren
          </label>
          <button type="submit">Speichern</button>
        </form>

        <hr />
        <h2>Passwort zurücksetzen</h2>
        <form method="post" action="/admin/users/${escapeHtml(user.id)}/password" class="stack">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <label>Neues Passwort
            <input type="password" name="password" minlength="12" required autocomplete="new-password" />
          </label>
          <button type="submit">Passwort setzen</button>
        </form>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Benutzer bearbeiten",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: query.error,
        notice: query.notice
      })
    );
  });

  app.post("/admin/users/:id/edit", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = asRecord(request.body);

    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const role = body.role === "admin" ? "admin" : "user";
    const disabled = body.disabled === "1";
    const displayName = body.displayName ?? "";

    const users = await listUsers();
    const target = users.find((candidate) => candidate.id === params.id);
    if (!target) {
      return reply.redirect("/admin/users?error=Benutzer+nicht+gefunden");
    }

    if (target.id === request.currentUser?.id && disabled) {
      return reply.redirect(`/admin/users/${encodeURIComponent(target.id)}/edit?error=Eigenes+Konto+kann+nicht+deaktiviert+werden`);
    }

    const removesLastAdminAccess = target.role === "admin" && (role !== "admin" || disabled);
    if (removesLastAdminAccess) {
      const remainingActiveAdmins = users.filter(
        (candidate) => candidate.id !== target.id && candidate.role === "admin" && !candidate.disabled
      );
      if (remainingActiveAdmins.length < 1) {
        return reply.redirect(
          `/admin/users/${encodeURIComponent(target.id)}/edit?error=Mindestens+ein+aktiver+Admin+wird+ben%C3%B6tigt`
        );
      }
    }

    const result = await updateUser(target.id, {
      displayName,
      role,
      disabled
    });

    if (!result.user) {
      return reply.redirect(`/admin/users/${encodeURIComponent(target.id)}/edit?error=${encodeURIComponent(result.error ?? "Aktualisierung fehlgeschlagen")}`);
    }

    await writeAuditLog({
      action: "admin_user_updated",
      actorId: request.currentUser?.id,
      targetId: result.user.id,
      details: {
        role: result.user.role,
        disabled: result.user.disabled
      }
    });

    return reply.redirect(`/admin/users/${encodeURIComponent(target.id)}/edit?notice=Benutzer+aktualisiert`);
  });

  app.post("/admin/users/:id/password", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = asRecord(request.body);

    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const password = body.password ?? "";
    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      return reply.redirect(`/admin/users/${encodeURIComponent(params.id)}/edit?error=${encodeURIComponent(passwordError)}`);
    }

    const result = await setUserPasswordByAdmin(params.id, password);
    if (!result.ok) {
      return reply.redirect(`/admin/users/${encodeURIComponent(params.id)}/edit?error=${encodeURIComponent(result.error ?? "Passwort konnte nicht gesetzt werden")}`);
    }

    await deleteUserSessions(params.id);

    await writeAuditLog({
      action: "admin_user_password_reset",
      actorId: request.currentUser?.id,
      targetId: params.id
    });

    return reply.redirect(`/admin/users/${encodeURIComponent(params.id)}/edit?notice=Passwort+aktualisiert`);
  });

  app.post("/admin/users/:id/delete", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = asRecord(request.body);

    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    if (params.id === request.currentUser?.id) {
      return reply.redirect("/admin/users?error=Eigenes+Konto+kann+nicht+gel%C3%B6scht+werden");
    }

    const users = await listUsers();
    const target = users.find((candidate) => candidate.id === params.id);

    if (!target) {
      return reply.redirect("/admin/users?error=Benutzer+nicht+gefunden");
    }

    if (target.role === "admin") {
      const activeAdmins = users.filter((candidate) => candidate.role === "admin" && !candidate.disabled);
      if (activeAdmins.length <= 1) {
        return reply.redirect("/admin/users?error=Mindestens+ein+aktiver+Admin+wird+ben%C3%B6tigt");
      }
    }

    const deleted = await deleteUser(params.id);
    if (!deleted) {
      return reply.redirect("/admin/users?error=L%C3%B6schen+fehlgeschlagen");
    }

    await deleteUserSessions(params.id);

    await writeAuditLog({
      action: "admin_user_deleted",
      actorId: request.currentUser?.id,
      targetId: params.id
    });

    return reply.redirect("/admin/users?notice=Benutzer+gel%C3%B6scht");
  });
};
