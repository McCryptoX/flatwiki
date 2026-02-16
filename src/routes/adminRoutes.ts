import type { FastifyInstance } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { requireAdmin, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import { config } from "../config.js";
import { removeFile } from "../lib/fileStore.js";
import { createCategory, listCategories, renameCategory } from "../lib/categoryStore.js";
import {
  createGroup,
  deleteGroup,
  findGroupById,
  listGroups,
  removeUserFromAllGroups,
  setGroupMembers,
  updateGroup
} from "../lib/groupStore.js";
import { createTemplate, deleteTemplate, listTemplates, updateTemplate } from "../lib/templateStore.js";
import {
  ensureSearchIndexConsistency,
  getSearchIndexBuildStatus,
  getSearchIndexInfo,
  startSearchIndexRebuild
} from "../lib/searchIndexStore.js";
import {
  cleanupUnusedUploads,
  deleteUploadFile,
  getUploadUsageReport,
  normalizeUploadFileName
} from "../lib/mediaStore.js";
import { cleanupAllPageVersions, getVersionStoreReport } from "../lib/pageVersionStore.js";
import {
  cancelPreparedRestore,
  createRestoreUploadTarget,
  deleteBackupFile,
  getBackupAutomationStatus,
  getBackupStatus,
  getPreparedRestoreInfo,
  getRestoreStatus,
  listBackupFiles,
  prepareRestoreUpload,
  resolveBackupFilePath,
  runBackupRetentionNow,
  startBackupJob,
  startRestoreJob
} from "../lib/backupStore.js";
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
import { getRuntimeSettings, setIndexBackend } from "../lib/runtimeSettingsStore.js";
import { deleteUserSessions } from "../lib/sessionStore.js";
import { listBrokenInternalLinks, listPages } from "../lib/wikiStore.js";

const asRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, string>;
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
};

const readSingle = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) {
    return String(value[0] ?? "");
  }
  return "";
};

const readMany = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
};

const readCheckbox = (value: unknown): boolean => {
  const normalized = readSingle(value).trim().toLowerCase();
  return normalized === "1" || normalized === "on" || normalized === "true" || normalized === "yes";
};

const parseCsvTags = (raw: string): string[] =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

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

const renderCategoriesTable = (
  csrfToken: string,
  categories: Awaited<ReturnType<typeof listCategories>>,
  pageCountByCategory: Map<string, number>
): string => {
  if (categories.length < 1) {
    return '<p class="empty">Keine Kategorien vorhanden.</p>';
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>ID</th>
            <th>Upload-Ordner</th>
            <th>Artikel</th>
            <th>Aktion</th>
          </tr>
        </thead>
        <tbody>
          ${categories
            .map(
              (category) => `
                <tr>
                  <td>${escapeHtml(category.name)}</td>
                  <td><code>${escapeHtml(category.id)}</code></td>
                  <td><code>${escapeHtml(category.uploadFolder)}</code></td>
                  <td>${pageCountByCategory.get(category.id) ?? 0}</td>
                  <td>
                    <form method="post" action="/admin/categories/${escapeHtml(category.id)}/rename" class="action-row">
                      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
                      <input type="text" name="name" value="${escapeHtml(category.name)}" minlength="2" maxlength="80" required />
                      <button type="submit" class="tiny secondary">Umbenennen</button>
                    </form>
                  </td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
};

const renderTemplateCards = (
  csrfToken: string,
  templates: Awaited<ReturnType<typeof listTemplates>>
): string => {
  if (templates.length < 1) {
    return '<p class="empty">Keine Vorlagen vorhanden.</p>';
  }

  return `
    <div class="stack">
      ${templates
        .map((template) => {
          const isBlankTemplate = template.id === "blank";
          const tagsValue = template.defaultTags.join(", ");
          return `
            <article class="admin-index-panel stack">
              <form method="post" action="/admin/templates/${encodeURIComponent(template.id)}/update" class="stack">
                <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
                ${
                  isBlankTemplate
                    ? '<input type="hidden" name="enabled" value="1" />'
                    : ""
                }
                <label class="checkline standalone-checkline">
                  <input type="checkbox" name="enabled" value="1" ${template.enabled ? "checked" : ""} ${isBlankTemplate ? "disabled" : ""} />
                  <span>Vorlage aktiv</span>
                </label>
                <label>Name
                  <input type="text" name="name" value="${escapeHtml(template.name)}" minlength="2" maxlength="80" required />
                </label>
                <label>Beschreibung (optional)
                  <input type="text" name="description" value="${escapeHtml(template.description)}" maxlength="260" />
                </label>
                <div class="action-row">
                  <label>Schutzmodus
                    <select name="sensitivity">
                      <option value="normal" ${template.sensitivity === "normal" ? "selected" : ""}>Standard</option>
                      <option value="sensitive" ${template.sensitivity === "sensitive" ? "selected" : ""}>Sensibel</option>
                    </select>
                  </label>
                  <label>Reihenfolge
                    <input type="number" name="sortOrder" value="${template.sortOrder}" min="-100000" max="100000" />
                  </label>
                </div>
                <label>Vorgabe-Titel
                  <input type="text" name="defaultTitle" value="${escapeHtml(template.defaultTitle)}" maxlength="120" />
                </label>
                <label>Vorgabe-Tags (kommagetrennt)
                  <input type="text" name="defaultTags" value="${escapeHtml(tagsValue)}" />
                </label>
                <label>Vorgabe-Inhalt (Markdown)
                  <textarea name="defaultContent" rows="8">${escapeHtml(template.defaultContent)}</textarea>
                </label>
                <div class="action-row">
                  <button type="submit">Vorlage speichern</button>
                </div>
              </form>
              <p class="muted-note small">
                ID: <code>${escapeHtml(template.id)}</code> |
                Typ: ${template.system ? "Systemvorlage" : "Benutzerdefiniert"} |
                Aktualisiert: ${escapeHtml(formatDate(template.updatedAt))}
              </p>
              ${
                template.system
                  ? ""
                  : `
                    <form method="post" action="/admin/templates/${encodeURIComponent(
                      template.id
                    )}/delete" class="action-row" onsubmit="return confirm('Vorlage wirklich löschen?')">
                      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
                      <button type="submit" class="danger tiny">Vorlage löschen</button>
                    </form>
                  `
              }
            </article>
          `;
        })
        .join("")}
    </div>
  `;
};

const renderGroupsTable = (
  csrfToken: string,
  groups: Awaited<ReturnType<typeof listGroups>>,
  pageCountByGroup: Map<string, number>
): string => {
  if (groups.length < 1) {
    return '<p class="empty">Keine Gruppen vorhanden.</p>';
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Beschreibung</th>
            <th>Mitglieder</th>
            <th>Artikel</th>
            <th>Aktion</th>
          </tr>
        </thead>
        <tbody>
          ${groups
            .map(
              (group) => `
                <tr>
                  <td>${escapeHtml(group.name)}</td>
                  <td>${group.description ? escapeHtml(group.description) : "-"}</td>
                  <td>${group.members.length}</td>
                  <td>${pageCountByGroup.get(group.id) ?? 0}</td>
                  <td>
                    <div class="action-row">
                      <a class="button tiny secondary" href="/admin/groups/${escapeHtml(group.id)}/edit">Bearbeiten</a>
                      <form method="post" action="/admin/groups/${escapeHtml(group.id)}/delete" onsubmit="return confirm('Gruppe wirklich löschen?')">
                        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
                        <button type="submit" class="danger tiny">Löschen</button>
                      </form>
                    </div>
                  </td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
};

const renderGroupMemberPicker = (
  users: Awaited<ReturnType<typeof listUsers>>,
  selectedUsernames: string[]
): string => {
  if (users.length < 1) {
    return '<p class="empty">Keine Benutzer vorhanden.</p>';
  }

  const selectedSet = new Set(selectedUsernames.map((value) => value.toLowerCase()));
  const safeUsers = users.filter((user) => !user.disabled);

  return `
    <fieldset class="stack access-user-picker">
      <legend>Mitglieder</legend>
      <div class="picker-toolbar">
        <input type="search" class="tiny" placeholder="Benutzer filtern" data-picker-filter autocomplete="off" />
        <span class="muted-note small" data-picker-count></span>
      </div>
      <div class="stack allowed-users-list" data-picker-list>
        ${
          safeUsers.length > 0
            ? safeUsers
                .map((user) => {
                  const checked = selectedSet.has(user.username.toLowerCase()) ? "checked" : "";
                  const searchData = `${user.displayName} ${user.username}`;
                  return `<label class="checkline user-checkline" data-search="${escapeHtml(searchData.toLowerCase())}"><input type="checkbox" name="members" value="${escapeHtml(user.username)}" ${checked} /> <span>${escapeHtml(user.displayName)} (${escapeHtml(user.username)})</span></label>`;
                })
                .join("")
            : '<p class="muted-note">Keine aktiven Benutzer verfügbar.</p>'
        }
      </div>
    </fieldset>
  `;
};

const renderIndexManagement = (
  csrfToken: string,
  info: Awaited<ReturnType<typeof getSearchIndexInfo>>,
  status: ReturnType<typeof getSearchIndexBuildStatus>,
  indexBackend: "flat" | "sqlite"
): string => {
  const percent = Number.isFinite(status.percent) ? Math.min(Math.max(status.percent, 0), 100) : 0;
  const statusError = status.error ? escapeHtml(status.error) : "";
  const stateLabel =
    status.phase === "error"
      ? "Fehler"
      : status.running
        ? "Läuft"
        : status.phase === "done"
          ? "Fertig"
          : "Bereit";

  return `
    <section class="content-wrap stack large admin-index-shell" data-index-admin data-csrf="${escapeHtml(csrfToken)}">
      <div class="admin-index-panel">
        <h2>Aktueller Suchindex</h2>
        <dl class="admin-index-meta">
          <dt>Datei</dt>
          <dd><code>${escapeHtml(info.indexFile)}</code></dd>
          <dt>Vorhanden</dt>
          <dd>${info.exists ? "Ja" : "Nein"}</dd>
          <dt>Version</dt>
          <dd>${info.version}</dd>
          <dt>Einträge</dt>
          <dd>${info.totalPages}</dd>
          <dt>Dateigröße</dt>
          <dd>${escapeHtml(formatFileSize(info.fileSizeBytes))}</dd>
          <dt>Zuletzt generiert</dt>
          <dd>${info.generatedAt ? escapeHtml(formatDate(info.generatedAt)) : "-"}</dd>
        </dl>
      </div>

      <div class="admin-index-panel">
        <h2>Backend</h2>
        <p class="muted-note">
          Artikel bleiben immer Markdown-Dateien. Hier wird nur der Such-/Metadatenindex umgestellt.
        </p>
        <form method="post" action="/admin/index/backend" class="stack">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
          <label>Index-Backend
            <select name="backend" ${status.running ? "disabled" : ""}>
              <option value="flat" ${indexBackend === "flat" ? "selected" : ""}>Flat-Datei (pages.json)</option>
              <option value="sqlite" ${indexBackend === "sqlite" ? "selected" : ""}>SQLite Hybrid (pages.sqlite)</option>
            </select>
          </label>
          <button type="submit" ${status.running ? "disabled" : ""}>Backend speichern</button>
        </form>
      </div>

      <div class="admin-index-panel">
        <h2>Index neu generieren</h2>
        <p class="muted-note">Erstellt alle Suchindex-Dateien neu. Sinnvoll nach vielen Importen oder manuellen Dateisystem-Änderungen.</p>
        <div class="action-row">
          <button type="button" data-index-start ${status.running ? "disabled" : ""}>Neu aufbauen</button>
        </div>

        <div class="admin-index-progress">
          <div class="admin-index-progress-head">
            <strong data-index-state>${escapeHtml(stateLabel)}</strong>
            <span data-index-percent>${percent}%</span>
          </div>
          <progress value="${percent}" max="100" data-index-progress></progress>
          <p class="muted-note" data-index-message>${escapeHtml(status.message)}</p>
          <p class="muted-note" data-index-time>
            Start: ${status.startedAt ? escapeHtml(formatDate(status.startedAt)) : "-"} |
            Ende: ${status.finishedAt ? escapeHtml(formatDate(status.finishedAt)) : "-"}
          </p>
          <p class="admin-index-error" data-index-error ${statusError ? "" : "hidden"}>${statusError}</p>
        </div>
      </div>
    </section>
  `;
};

const renderVersionManagement = (
  csrfToken: string,
  report: Awaited<ReturnType<typeof getVersionStoreReport>>,
  query: Record<string, string>
): string => {
  const defaultRetention = String(config.versionHistoryRetention);
  const defaultCompressAfter = String(config.versionHistoryCompressAfter);
  const retention = query.keepLatest && query.keepLatest.trim().length > 0 ? query.keepLatest.trim() : defaultRetention;
  const compressAfter =
    query.compressAfter && query.compressAfter.trim().length > 0 ? query.compressAfter.trim() : defaultCompressAfter;

  return `
    <section class="content-wrap stack large">
      <div class="admin-index-panel">
        <h2>Historie-Speicher</h2>
        <dl class="admin-index-meta">
          <dt>Artikel mit Historie</dt>
          <dd>${report.totalSlugs}</dd>
          <dt>Versionen gesamt</dt>
          <dd>${report.totalVersions}</dd>
          <dt>Belegter Speicher</dt>
          <dd>${escapeHtml(formatFileSize(report.totalDiskBytes))}</dd>
          <dt>Retention (Standard)</dt>
          <dd>${config.versionHistoryRetention} pro Artikel</dd>
          <dt>Kompression ab Position</dt>
          <dd>${config.versionHistoryCompressAfter}</dd>
        </dl>
      </div>

      <div class="admin-index-panel">
        <h2>Bereinigung starten</h2>
        <p class="muted-note">Ältere Versionen werden komprimiert und überzählige Stände pro Artikel entfernt.</p>
        <form method="post" action="/admin/versions/cleanup" class="stack">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
          <label>Versionen pro Artikel behalten
            <input type="number" min="1" max="5000" name="keepLatest" value="${escapeHtml(retention)}" required />
          </label>
          <label>Ab Position komprimieren (.json.gz)
            <input type="number" min="0" max="5000" name="compressAfter" value="${escapeHtml(compressAfter)}" required />
          </label>
          <button type="submit">Historie bereinigen</button>
        </form>
      </div>

      <div class="admin-index-panel">
        <h2>Top-Artikel nach Historie</h2>
        ${
          report.topItems.length < 1
            ? '<p class="empty">Noch keine gespeicherten Versionen vorhanden.</p>'
            : `
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Artikel</th>
                      <th>Versionen</th>
                      <th>Speicher</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${report.topItems
                      .map(
                        (item) => `
                          <tr>
                            <td><a href="/wiki/${encodeURIComponent(item.slug)}/history">${escapeHtml(item.slug)}</a></td>
                            <td>${item.totalVersions}</td>
                            <td>${escapeHtml(formatFileSize(item.diskBytes))}</td>
                          </tr>
                        `
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>
            `
        }
      </div>
    </section>
  `;
};

const renderBackupManagement = (
  csrfToken: string,
  backupStatus: ReturnType<typeof getBackupStatus>,
  restoreStatus: ReturnType<typeof getRestoreStatus>,
  automationStatus: ReturnType<typeof getBackupAutomationStatus>,
  preparedRestore: Awaited<ReturnType<typeof getPreparedRestoreInfo>>,
  files: Awaited<ReturnType<typeof listBackupFiles>>,
  hasBackupKey: boolean
): string => {
  const backupPercent = Number.isFinite(backupStatus.percent) ? Math.min(Math.max(backupStatus.percent, 0), 100) : 0;
  const backupStatusError = backupStatus.error ? escapeHtml(backupStatus.error) : "";
  const backupStateLabel =
    backupStatus.phase === "error"
      ? "Fehler"
      : backupStatus.running
        ? "Läuft"
        : backupStatus.phase === "done"
          ? "Fertig"
          : "Bereit";
  const restorePercent = Number.isFinite(restoreStatus.percent) ? Math.min(Math.max(restoreStatus.percent, 0), 100) : 0;
  const restoreStatusError = restoreStatus.error ? escapeHtml(restoreStatus.error) : "";
  const restoreStateLabel =
    restoreStatus.phase === "error"
      ? "Fehler"
      : restoreStatus.running
        ? "Läuft"
        : restoreStatus.phase === "done"
          ? "Fertig"
          : "Bereit";
  const operationRunning = backupStatus.running || restoreStatus.running;
  const backupPassphrase = (process.env.BACKUP_ENCRYPTION_KEY ?? "").trim();
  const backupPassphraseFingerprint = backupPassphrase
    ? createHash("sha256").update(backupPassphrase).digest("hex").slice(0, 16)
    : "";
  const automationStateLabel = automationStatus.enabled ? "Aktiv" : "Deaktiviert";
  const automationLastResultLabel =
    automationStatus.lastResult === "success"
      ? "Erfolgreich"
      : automationStatus.lastResult === "error"
        ? "Fehler"
        : automationStatus.lastResult === "skipped"
          ? "Übersprungen"
          : "Noch kein Lauf";
  const retentionHintParts: string[] = [];
  if (automationStatus.retentionMaxFiles > 0) {
    retentionHintParts.push(`max. ${automationStatus.retentionMaxFiles} Dateien`);
  }
  if (automationStatus.retentionMaxAgeDays > 0) {
    retentionHintParts.push(`max. ${automationStatus.retentionMaxAgeDays} Tage`);
  }
  if (retentionHintParts.length < 1) {
    retentionHintParts.push("deaktiviert");
  }

  const latestFiles = files
    .slice(0, 50)
    .map(
      (file) => `
        <tr>
          <td><code>${escapeHtml(file.fileName)}</code></td>
          <td>${escapeHtml(formatDate(file.modifiedAt))}</td>
          <td>${escapeHtml(formatFileSize(file.sizeBytes))}</td>
          <td>${file.hasChecksum ? "ja" : "nein"}</td>
          <td>
            <div class="action-row">
              <a class="button tiny secondary" href="/admin/backups/download/${encodeURIComponent(file.fileName)}">Download</a>
              <form method="post" action="/admin/backups/delete" onsubmit="return confirm('Backup-Datei wirklich löschen?')">
                <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
                <input type="hidden" name="fileName" value="${escapeHtml(file.fileName)}" />
                <button type="submit" class="danger tiny" ${operationRunning ? "disabled" : ""}>Löschen</button>
              </form>
            </div>
          </td>
        </tr>
      `
    )
    .join("");

  const preparedRestoreHtml = preparedRestore
    ? `
      <div class="admin-restore-ready stack">
        <h3>Prüfung erfolgreich</h3>
        <dl class="admin-index-meta">
          <dt>Datei</dt>
          <dd><code>${escapeHtml(preparedRestore.uploadedFileName)}</code></dd>
          <dt>Backup erstellt</dt>
          <dd>${preparedRestore.backupCreatedAt ? escapeHtml(formatDate(preparedRestore.backupCreatedAt)) : "-"}</dd>
          <dt>Archiv-Einträge</dt>
          <dd>${preparedRestore.archiveEntries}</dd>
          <dt>Größe</dt>
          <dd>${escapeHtml(formatFileSize(preparedRestore.encryptedSizeBytes))}</dd>
          <dt>Gültig bis</dt>
          <dd>${escapeHtml(formatDate(preparedRestore.expiresAt))}</dd>
        </dl>
        <form method="post" action="/admin/backups/restore/start" class="stack">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
          <input type="hidden" name="ticketId" value="${escapeHtml(preparedRestore.id)}" />
          <label>Backup-Passphrase (erneut, identisch zu BACKUP_ENCRYPTION_KEY)
            <input type="password" name="passphrase" autocomplete="off" minlength="8" required ${operationRunning ? "disabled" : ""} />
          </label>
          <label class="checkline standalone-checkline">
            <input type="checkbox" name="confirm" value="yes" required ${operationRunning ? "disabled" : ""} />
            <span>Ich bestätige, dass bestehende Daten durch den Backup-Stand ersetzt werden.</span>
          </label>
          <div class="action-row">
            <button type="submit" ${operationRunning ? "disabled" : ""}>Wiederherstellung starten</button>
          </div>
        </form>
        <form method="post" action="/admin/backups/restore/cancel" class="action-row">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
          <input type="hidden" name="ticketId" value="${escapeHtml(preparedRestore.id)}" />
          <button type="submit" class="secondary tiny" ${operationRunning ? "disabled" : ""}>Vorbereitung verwerfen</button>
        </form>
      </div>
    `
    : '<p class="muted-note">Noch kein geprüfter Restore-Upload vorbereitet.</p>';

  return `
    <section class="content-wrap stack large admin-backup-shell" data-backup-admin data-csrf="${escapeHtml(csrfToken)}">
      <div class="admin-index-panel">
        <h2>Automatische Backups & Retention</h2>
        <dl class="admin-index-meta" data-backup-auto>
          <dt>Status</dt>
          <dd data-auto-state>${escapeHtml(automationStateLabel)}</dd>
          <dt>Intervall</dt>
          <dd data-auto-interval>${automationStatus.intervalHours} Stunde(n)</dd>
          <dt>Nächster Lauf</dt>
          <dd data-auto-next-run>${automationStatus.nextRunAt ? escapeHtml(formatDate(automationStatus.nextRunAt)) : "-"}</dd>
          <dt>Letzter Lauf</dt>
          <dd data-auto-last-run>${automationStatus.lastRunAt ? escapeHtml(formatDate(automationStatus.lastRunAt)) : "-"}</dd>
          <dt>Letztes Ergebnis</dt>
          <dd data-auto-last-result>${escapeHtml(automationLastResultLabel)}</dd>
          <dt>Retention</dt>
          <dd data-auto-retention>${escapeHtml(retentionHintParts.join(", "))}</dd>
          <dt>Zuletzt bereinigt</dt>
          <dd data-auto-last-retention>
            ${
              automationStatus.lastRetentionAt
                ? `${escapeHtml(formatDate(automationStatus.lastRetentionAt))} (${automationStatus.lastRetentionDeletedFiles} gelöscht)`
                : "-"
            }
          </dd>
        </dl>
        <p class="muted-note" data-auto-message>${escapeHtml(automationStatus.lastMessage)}</p>
        <p class="admin-index-error" data-auto-error ${automationStatus.lastError ? "" : "hidden"}>${escapeHtml(automationStatus.lastError ?? "")}</p>
        <form method="post" action="/admin/backups/retention/run" class="action-row">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
          <button type="submit" class="secondary" ${operationRunning ? "disabled" : ""}>Retention jetzt ausführen</button>
        </form>
      </div>

      <div class="admin-index-panel">
        <h2>Backup starten</h2>
        <p class="muted-note">Erstellt ein verschlüsseltes Daten-Backup inkl. Prüfsumme im Ordner <code>data/backups</code>.</p>
        ${
          hasBackupKey
            ? `<p class="muted-note">Schlüsselstatus: <strong>BACKUP_ENCRYPTION_KEY aktiv</strong>.</p>
               <p class="muted-note"><strong>Backup-Passphrase:</strong> Der exakte Wert aus <code>BACKUP_ENCRYPTION_KEY</code> in <code>config.env</code>.</p>
               <p class="muted-note">Fingerprint (SHA-256, gekürzt): <code>${escapeHtml(backupPassphraseFingerprint)}</code></p>`
            : '<p class="muted-note">Schlüsselstatus: <strong>BACKUP_ENCRYPTION_KEY fehlt</strong>. Bitte in <code>config.env</code> setzen und Dienst neu starten.</p>'
        }
        <div class="action-row">
          <button type="button" data-backup-start ${operationRunning || !hasBackupKey ? "disabled" : ""}>Backup jetzt erstellen</button>
        </div>

        <div class="admin-index-progress">
          <div class="admin-index-progress-head">
            <strong data-backup-state>${escapeHtml(backupStateLabel)}</strong>
            <span data-backup-percent>${backupPercent}%</span>
          </div>
          <progress value="${backupPercent}" max="100" data-backup-progress></progress>
          <p class="muted-note" data-backup-message>${escapeHtml(backupStatus.message)}</p>
          <p class="muted-note" data-backup-time>
            Start: ${backupStatus.startedAt ? escapeHtml(formatDate(backupStatus.startedAt)) : "-"} |
            Ende: ${backupStatus.finishedAt ? escapeHtml(formatDate(backupStatus.finishedAt)) : "-"}
          </p>
          <p class="muted-note" data-backup-target>
            Datei: ${backupStatus.archiveFileName ? `<code>${escapeHtml(backupStatus.archiveFileName)}</code>` : "-"}
          </p>
          <p class="admin-index-error" data-backup-error ${backupStatusError ? "" : "hidden"}>${backupStatusError}</p>
        </div>
      </div>

      <div class="admin-index-panel">
        <h2>Backup wiederherstellen</h2>
        <p class="muted-note">1. Datei hochladen und prüfen. 2. Wiederherstellung explizit bestätigen. 3. Restore wird mit Fortschritt ausgeführt.</p>
        <p class="muted-note"><strong>Wichtig:</strong> Für Prüfung und Restore ist die gleiche Passphrase nötig wie beim Erstellen: <code>BACKUP_ENCRYPTION_KEY</code> aus <code>config.env</code>.</p>
        <form method="post" action="/admin/backups/restore/prepare" enctype="multipart/form-data" class="stack">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
          <label>Backup-Datei (.tar.gz.enc)
            <input type="file" name="backupFile" accept=".enc,.tar.gz.enc" required ${operationRunning ? "disabled" : ""} />
          </label>
          <label>Backup-Passphrase (Wert aus BACKUP_ENCRYPTION_KEY)
            <input type="password" name="passphrase" autocomplete="off" minlength="8" required ${operationRunning ? "disabled" : ""} />
          </label>
          <div class="action-row">
            <button type="submit" class="secondary" ${operationRunning ? "disabled" : ""}>Backup prüfen</button>
          </div>
        </form>
        ${preparedRestoreHtml}
        <div class="admin-index-progress">
          <div class="admin-index-progress-head">
            <strong data-restore-state>${escapeHtml(restoreStateLabel)}</strong>
            <span data-restore-percent>${restorePercent}%</span>
          </div>
          <progress value="${restorePercent}" max="100" data-restore-progress></progress>
          <p class="muted-note" data-restore-message>${escapeHtml(restoreStatus.message)}</p>
          <p class="muted-note" data-restore-time>
            Start: ${restoreStatus.startedAt ? escapeHtml(formatDate(restoreStatus.startedAt)) : "-"} |
            Ende: ${restoreStatus.finishedAt ? escapeHtml(formatDate(restoreStatus.finishedAt)) : "-"}
          </p>
          <p class="muted-note" data-restore-source>
            Quelle: ${restoreStatus.sourceFileName ? `<code>${escapeHtml(restoreStatus.sourceFileName)}</code>` : "-"}
          </p>
          <p class="admin-index-error" data-restore-error ${restoreStatusError ? "" : "hidden"}>${restoreStatusError}</p>
        </div>
      </div>

      <div class="admin-index-panel">
        <h2>Vorhandene Backups</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Datei</th>
                <th>Erstellt</th>
                <th>Größe</th>
                <th>Checksum</th>
                <th>Aktion</th>
              </tr>
            </thead>
            <tbody data-backup-files>
              ${
                latestFiles.length > 0
                  ? latestFiles
                  : '<tr><td colspan="5" class="muted-note">Noch keine Backup-Dateien vorhanden.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
};

const renderBrokenLinksPanel = (items: Awaited<ReturnType<typeof listBrokenInternalLinks>>): string => {
  if (items.length < 1) {
    return '<section class="content-wrap"><p class="empty">Keine defekten internen Wiki-Links gefunden.</p></section>';
  }

  return `
    <section class="content-wrap">
      <p>${items.length} defekte interne Verlinkung(en) gefunden.</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Quellseite</th>
              <th>Ziel (eingetragen)</th>
              <th>Ziel-Slug</th>
              <th>Linktext</th>
              <th>Letzte Änderung</th>
              <th>Aktion</th>
            </tr>
          </thead>
          <tbody>
            ${items
              .map(
                (entry) => `
                  <tr>
                    <td><a href="/wiki/${encodeURIComponent(entry.sourceSlug)}">${escapeHtml(entry.sourceTitle)} (${escapeHtml(entry.sourceSlug)})</a></td>
                    <td><code>${escapeHtml(entry.targetRaw)}</code></td>
                    <td><code>${escapeHtml(entry.targetSlug)}</code></td>
                    <td>${escapeHtml(entry.label)}</td>
                    <td>${escapeHtml(formatDate(entry.sourceUpdatedAt))}</td>
                    <td>
                      <a class="button tiny secondary" href="/new?title=${encodeURIComponent(entry.targetRaw || entry.targetSlug)}&slug=${encodeURIComponent(
                        entry.targetSlug
                      )}">Zielseite anlegen</a>
                    </td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
};

type AdminNavKey = "users" | "media" | "categories" | "templates" | "groups" | "versions" | "backups" | "links" | "index";

const ADMIN_NAV_ITEMS: Array<{ key: AdminNavKey; href: string; label: string }> = [
  { key: "users", href: "/admin/users", label: "Benutzerverwaltung" },
  { key: "media", href: "/admin/media", label: "Bildverwaltung" },
  { key: "categories", href: "/admin/categories", label: "Kategorien" },
  { key: "templates", href: "/admin/templates", label: "Vorlagen" },
  { key: "groups", href: "/admin/groups", label: "Gruppen" },
  { key: "versions", href: "/admin/versions", label: "Versionen" },
  { key: "backups", href: "/admin/backups", label: "Backups" },
  { key: "links", href: "/admin/links", label: "Link-Check" },
  { key: "index", href: "/admin/index", label: "Suchindex" }
];

const renderAdminNav = (active: AdminNavKey): string => `
  <nav class="action-row admin-nav" aria-label="Admin Navigation">
    ${ADMIN_NAV_ITEMS.map((item) => {
      const activeClass = item.key === active ? " is-active-nav" : "";
      const ariaCurrent = item.key === active ? ' aria-current="page"' : "";
      return `<a class="button secondary${activeClass}" href="${item.href}"${ariaCurrent}>${item.label}</a>`;
    }).join("")}
  </nav>
`;

const renderAdminHeader = (input: {
  title: string;
  description: string;
  active: AdminNavKey;
  actions?: string;
}): string => `
  <section class="page-header under-title">
    <div>
      <h1>${input.title}</h1>
      <p>${input.description}</p>
    </div>
    ${renderAdminNav(input.active)}
    ${input.actions ? `<div class="action-row admin-page-actions">${input.actions}</div>` : ""}
  </section>
`;

export const registerAdminRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/admin/users", { preHandler: [requireAdmin] }, async (request, reply) => {
    const users = await listUsers();
    const query = asRecord(request.query);

    const body = `
      ${renderAdminHeader({
        title: "Benutzerverwaltung",
        description: "Konten DSGVO-bewusst verwalten (minimal gespeicherte Stammdaten).",
        active: "users",
        actions: '<a class="button" href="/admin/users/new">Neuen Benutzer anlegen</a>'
      })}
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
      ${renderAdminHeader({
        title: "Bildverwaltung",
        description: "Upload-Dateien prüfen, Referenzen nachvollziehen und unbenutzte Bilder entfernen.",
        active: "media",
        actions: `<form method="post" action="/admin/media/cleanup" onsubmit="return confirm('Alle ungenutzten Bilddateien wirklich löschen?')">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <button type="submit">Ungenutzte Bilder löschen</button>
        </form>`
      })}
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

  app.get("/admin/categories", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const categories = await listCategories();
    const pages = await listPages();
    const pageCountByCategory = new Map<string, number>();
    for (const page of pages) {
      pageCountByCategory.set(page.categoryId, (pageCountByCategory.get(page.categoryId) ?? 0) + 1);
    }

    const body = `
      ${renderAdminHeader({
        title: "Kategorien",
        description: "Kategorien für Artikel verwalten.",
        active: "categories"
      })}
      <section class="content-wrap stack">
        <form method="post" action="/admin/categories/new" class="action-row">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <input type="text" name="name" placeholder="Neue Kategorie" minlength="2" maxlength="80" required />
          <button type="submit">Kategorie anlegen</button>
        </form>
        ${renderCategoriesTable(request.csrfToken ?? "", categories, pageCountByCategory)}
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Kategorien",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/admin/categories/new", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const result = await createCategory(body.name ?? "");
    if (!result.ok) {
      return reply.redirect(`/admin/categories?error=${encodeURIComponent(result.error ?? "Kategorie konnte nicht erstellt werden.")}`);
    }

    await writeAuditLog({
      action: "admin_category_created",
      actorId: request.currentUser?.id,
      targetId: result.category?.id
    });

    return reply.redirect(`/admin/categories?notice=${encodeURIComponent("Kategorie erstellt.")}`);
  });

  app.post("/admin/categories/:id/rename", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = asRecord(request.body);

    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const result = await renameCategory(params.id, body.name ?? "");
    if (!result.ok) {
      return reply.redirect(`/admin/categories?error=${encodeURIComponent(result.error ?? "Kategorie konnte nicht umbenannt werden.")}`);
    }

    await writeAuditLog({
      action: "admin_category_renamed",
      actorId: request.currentUser?.id,
      targetId: result.category?.id
    });

    return reply.redirect(`/admin/categories?notice=${encodeURIComponent("Kategorie umbenannt.")}`);
  });

  app.get("/admin/templates", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const templates = await listTemplates({ includeDisabled: true });

    const body = `
      ${renderAdminHeader({
        title: "Vorlagen",
        description: "Inhaltstypen für den Seiten-Assistenten aktivieren, sortieren und anpassen.",
        active: "templates"
      })}
      <section class="content-wrap stack">
        <form method="post" action="/admin/templates/new" class="stack">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <h2>Neue Vorlage anlegen</h2>
          <label>Name
            <input type="text" name="name" minlength="2" maxlength="80" required />
          </label>
          <label>Beschreibung (optional)
            <input type="text" name="description" maxlength="260" />
          </label>
          <div class="action-row">
            <label>Schutzmodus
              <select name="sensitivity">
                <option value="normal" selected>Standard</option>
                <option value="sensitive">Sensibel</option>
              </select>
            </label>
            <label>Reihenfolge
              <input type="number" name="sortOrder" value="100" min="-100000" max="100000" />
            </label>
          </div>
          <label>Vorgabe-Titel
            <input type="text" name="defaultTitle" maxlength="120" />
          </label>
          <label>Vorgabe-Tags (kommagetrennt)
            <input type="text" name="defaultTags" placeholder="z. B. idee, intern" />
          </label>
          <label>Vorgabe-Inhalt (Markdown)
            <textarea name="defaultContent" rows="8"></textarea>
          </label>
          <label class="checkline standalone-checkline">
            <input type="checkbox" name="enabled" value="1" checked />
            <span>Vorlage sofort aktivieren</span>
          </label>
          <div class="action-row">
            <button type="submit">Vorlage anlegen</button>
          </div>
        </form>

        <h2>Vorlagen verwalten</h2>
        <p class="muted-note">Nur aktive Vorlagen werden im Assistenten bei "Neue Seite" angezeigt.</p>
        ${renderTemplateCards(request.csrfToken ?? "", templates)}
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Vorlagen",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/admin/templates/new", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const sortOrderRaw = readSingle(body.sortOrder).trim();
    let sortOrder: number | undefined;
    if (sortOrderRaw) {
      const parsedSortOrder = Number.parseInt(sortOrderRaw, 10);
      if (!Number.isFinite(parsedSortOrder)) {
        return reply.redirect("/admin/templates?error=Ung%C3%BCltige+Reihenfolge.");
      }
      sortOrder = parsedSortOrder;
    }

    const result = await createTemplate({
      name: body.name ?? "",
      description: body.description ?? "",
      defaultTitle: body.defaultTitle ?? "",
      defaultTags: parseCsvTags(body.defaultTags ?? ""),
      defaultContent: body.defaultContent ?? "",
      sensitivity: readSingle(body.sensitivity) === "sensitive" ? "sensitive" : "normal",
      enabled: readCheckbox(body.enabled),
      ...(sortOrder !== undefined ? { sortOrder } : {})
    });

    if (!result.ok) {
      return reply.redirect(`/admin/templates?error=${encodeURIComponent(result.error ?? "Vorlage konnte nicht erstellt werden.")}`);
    }

    await writeAuditLog({
      action: "admin_template_created",
      actorId: request.currentUser?.id,
      targetId: result.template?.id
    });

    return reply.redirect("/admin/templates?notice=Vorlage+erstellt.");
  });

  app.post("/admin/templates/:id/update", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const sortOrderRaw = readSingle(body.sortOrder).trim();
    const parsedSortOrder = Number.parseInt(sortOrderRaw || "0", 10);
    if (!Number.isFinite(parsedSortOrder)) {
      return reply.redirect("/admin/templates?error=Ung%C3%BCltige+Reihenfolge.");
    }

    const result = await updateTemplate({
      id: params.id,
      name: body.name ?? "",
      description: body.description ?? "",
      defaultTitle: body.defaultTitle ?? "",
      defaultTags: parseCsvTags(body.defaultTags ?? ""),
      defaultContent: body.defaultContent ?? "",
      sensitivity: readSingle(body.sensitivity) === "sensitive" ? "sensitive" : "normal",
      enabled: readCheckbox(body.enabled),
      sortOrder: parsedSortOrder
    });

    if (!result.ok) {
      return reply.redirect(`/admin/templates?error=${encodeURIComponent(result.error ?? "Vorlage konnte nicht gespeichert werden.")}`);
    }

    await writeAuditLog({
      action: "admin_template_updated",
      actorId: request.currentUser?.id,
      targetId: result.template?.id
    });

    return reply.redirect("/admin/templates?notice=Vorlage+gespeichert.");
  });

  app.post("/admin/templates/:id/delete", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const result = await deleteTemplate(params.id);
    if (!result.ok) {
      return reply.redirect(`/admin/templates?error=${encodeURIComponent(result.error ?? "Vorlage konnte nicht gelöscht werden.")}`);
    }

    await writeAuditLog({
      action: "admin_template_deleted",
      actorId: request.currentUser?.id,
      targetId: params.id
    });

    return reply.redirect("/admin/templates?notice=Vorlage+gel%C3%B6scht.");
  });

  app.get("/admin/groups", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const groups = await listGroups();
    const pages = await listPages({ forceFileScan: true });
    const pageCountByGroup = new Map<string, number>();

    for (const page of pages) {
      for (const groupId of page.allowedGroups) {
        pageCountByGroup.set(groupId, (pageCountByGroup.get(groupId) ?? 0) + 1);
      }
    }

    const body = `
      ${renderAdminHeader({
        title: "Gruppen",
        description: "Benutzergruppen für Artikel-Freigaben verwalten.",
        active: "groups"
      })}
      <section class="content-wrap stack">
        <form method="post" action="/admin/groups/new" class="stack">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <label>Name
            <input type="text" name="name" minlength="2" maxlength="80" required />
          </label>
          <label>Beschreibung (optional)
            <input type="text" name="description" maxlength="300" />
          </label>
          <div class="action-row">
            <button type="submit">Gruppe anlegen</button>
          </div>
        </form>
        ${renderGroupsTable(request.csrfToken ?? "", groups, pageCountByGroup)}
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Gruppen",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/admin/groups/new", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const result = await createGroup({
      name: body.name ?? "",
      description: body.description ?? ""
    });
    if (!result.ok) {
      return reply.redirect(`/admin/groups?error=${encodeURIComponent(result.error ?? "Gruppe konnte nicht erstellt werden.")}`);
    }

    await writeAuditLog({
      action: "admin_group_created",
      actorId: request.currentUser?.id,
      targetId: result.group?.id
    });

    return reply.redirect(`/admin/groups?notice=${encodeURIComponent("Gruppe erstellt.")}`);
  });

  app.get("/admin/groups/:id/edit", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { id: string };
    const group = await findGroupById(params.id);
    if (!group) {
      return reply.redirect("/admin/groups?error=Gruppe+nicht+gefunden");
    }

    const query = asRecord(request.query);
    const users = await listUsers();

    const name = query.name ?? group.name;
    const description = query.description ?? group.description;
    const selectedMembersRaw = (query.members ?? "").trim();
    const selectedMembers =
      selectedMembersRaw.length > 0
        ? selectedMembersRaw
            .split(",")
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0)
        : group.members;

    const body = `
      <section class="content-wrap stack large">
        <h1>Gruppe bearbeiten</h1>
        <form method="post" action="/admin/groups/${escapeHtml(group.id)}/edit" class="stack large">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <label>Name
            <input type="text" name="name" value="${escapeHtml(name)}" minlength="2" maxlength="80" required />
          </label>
          <label>Beschreibung (optional)
            <input type="text" name="description" value="${escapeHtml(description)}" maxlength="300" />
          </label>
          ${renderGroupMemberPicker(users, selectedMembers)}
          <button type="submit">Gruppe speichern</button>
        </form>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Gruppe bearbeiten",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error,
        scripts: ["/picker-ui.js?v=1"]
      })
    );
  });

  app.post("/admin/groups/:id/edit", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = asObject(request.body);
    const csrfToken = readSingle(body._csrf);
    if (!verifySessionCsrfToken(request, csrfToken)) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const group = await findGroupById(params.id);
    if (!group) {
      return reply.redirect("/admin/groups?error=Gruppe+nicht+gefunden");
    }

    const name = readSingle(body.name);
    const description = readSingle(body.description);
    const userNameSet = new Set((await listUsers()).filter((user) => !user.disabled).map((user) => user.username.toLowerCase()));
    const requestedMembers = readMany(body.members).map((entry) => entry.trim().toLowerCase());
    const members = [...new Set(requestedMembers.filter((username) => userNameSet.has(username)))];

    const updateResult = await updateGroup(group.id, {
      name,
      description
    });
    if (!updateResult.ok) {
      return reply.redirect(
        `/admin/groups/${encodeURIComponent(group.id)}/edit?error=${encodeURIComponent(updateResult.error ?? "Gruppe konnte nicht gespeichert werden.")}&name=${encodeURIComponent(
          name
        )}&description=${encodeURIComponent(description)}&members=${encodeURIComponent(members.join(","))}`
      );
    }

    const memberResult = await setGroupMembers(group.id, members);
    if (!memberResult.ok) {
      return reply.redirect(
        `/admin/groups/${encodeURIComponent(group.id)}/edit?error=${encodeURIComponent(memberResult.error ?? "Mitglieder konnten nicht gespeichert werden.")}&name=${encodeURIComponent(
          name
        )}&description=${encodeURIComponent(description)}&members=${encodeURIComponent(members.join(","))}`
      );
    }

    await writeAuditLog({
      action: "admin_group_updated",
      actorId: request.currentUser?.id,
      targetId: group.id,
      details: {
        memberCount: members.length
      }
    });

    return reply.redirect(`/admin/groups/${encodeURIComponent(group.id)}/edit?notice=${encodeURIComponent("Gruppe aktualisiert.")}`);
  });

  app.post("/admin/groups/:id/delete", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const group = await findGroupById(params.id);
    if (!group) {
      return reply.redirect("/admin/groups?error=Gruppe+nicht+gefunden");
    }

    const pages = await listPages({ forceFileScan: true });
    const usageCount = pages.filter((page) => page.allowedGroups.includes(group.id)).length;
    if (usageCount > 0) {
      return reply.redirect(
        `/admin/groups?error=${encodeURIComponent(`Gruppe wird noch in ${usageCount} Artikel(n) verwendet.`)}`
      );
    }

    const deleted = await deleteGroup(group.id);
    if (!deleted) {
      return reply.redirect("/admin/groups?error=L%C3%B6schen+fehlgeschlagen");
    }

    await writeAuditLog({
      action: "admin_group_deleted",
      actorId: request.currentUser?.id,
      targetId: group.id
    });

    return reply.redirect(`/admin/groups?notice=${encodeURIComponent("Gruppe gelöscht.")}`);
  });

  app.get("/admin/versions", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const report = await getVersionStoreReport(50);

    const body = `
      ${renderAdminHeader({
        title: "Versionshistorie",
        description: "Aufbewahrung und Kompression der Artikel-Historie zentral verwalten.",
        active: "versions"
      })}
      ${renderVersionManagement(request.csrfToken ?? "", report, query)}
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Versionshistorie",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/admin/versions/cleanup", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const keepLatest = Number.parseInt(body.keepLatest ?? "", 10);
    const compressAfter = Number.parseInt(body.compressAfter ?? "", 10);

    if (!Number.isFinite(keepLatest) || keepLatest < 1 || keepLatest > 5000) {
      return reply.redirect("/admin/versions?error=Ung%C3%BCltiger+Wert+f%C3%BCr+Retention");
    }

    if (!Number.isFinite(compressAfter) || compressAfter < 0 || compressAfter > 5000) {
      return reply.redirect("/admin/versions?error=Ung%C3%BCltiger+Wert+f%C3%BCr+Kompression");
    }

    const cleanup = await cleanupAllPageVersions({
      keepLatest,
      compressAfter
    });

    await writeAuditLog({
      action: "admin_versions_cleanup",
      actorId: request.currentUser?.id,
      details: {
        keepLatest,
        compressAfter,
        scannedSlugs: cleanup.scannedSlugs,
        compressedFiles: cleanup.compressedFiles,
        deletedFiles: cleanup.deletedFiles,
        errors: cleanup.errors.length
      }
    });

    const params = new URLSearchParams();
    params.set(
      "notice",
      `Bereinigung abgeschlossen: ${cleanup.compressedFiles} komprimiert, ${cleanup.deletedFiles} gelöscht (${cleanup.scannedSlugs} Artikel).`
    );
    params.set("keepLatest", String(keepLatest));
    params.set("compressAfter", String(compressAfter));
    if (cleanup.errors.length > 0) {
      params.set("error", `${cleanup.errors.length} Fehler, siehe Server-Log.`);
      request.log.warn({ errors: cleanup.errors.slice(0, 20) }, "Versions-Cleanup meldet Fehler");
    }

    return reply.redirect(`/admin/versions?${params.toString()}`);
  });

  app.get("/admin/backups", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const backupStatus = getBackupStatus();
    const restoreStatus = getRestoreStatus();
    const automationStatus = getBackupAutomationStatus();
    const files = await listBackupFiles();
    const preparedRestore = await getPreparedRestoreInfo(request.currentUser?.id);
    const hasBackupKey = Boolean((process.env.BACKUP_ENCRYPTION_KEY ?? "").trim());

    const body = `
      ${renderAdminHeader({
        title: "Backups",
        description: "Verschlüsselte Datensicherungen erstellen und verwalten.",
        active: "backups"
      })}
      ${renderBackupManagement(request.csrfToken ?? "", backupStatus, restoreStatus, automationStatus, preparedRestore, files, hasBackupKey)}
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Backups",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error,
        scripts: ["/admin-backups.js?v=3"]
      })
    );
  });

  app.post("/admin/backups/delete", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const backupStatus = getBackupStatus();
    const restoreStatus = getRestoreStatus();
    if (backupStatus.running || restoreStatus.running) {
      return reply.redirect("/admin/backups?error=Aktuell+l%C3%A4uft+ein+Backup+oder+Restore.+Bitte+warten.");
    }

    const deleted = await deleteBackupFile(body.fileName ?? "");
    if (!deleted) {
      return reply.redirect("/admin/backups?error=Backup-Datei+nicht+gefunden+oder+ung%C3%BCltig.");
    }

    await writeAuditLog({
      action: "admin_backup_deleted",
      actorId: request.currentUser?.id,
      targetId: body.fileName ?? ""
    });

    return reply.redirect("/admin/backups?notice=Backup+gel%C3%B6scht.");
  });

  app.post("/admin/backups/retention/run", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const backupStatus = getBackupStatus();
    const restoreStatus = getRestoreStatus();
    if (backupStatus.running || restoreStatus.running) {
      return reply.redirect("/admin/backups?error=Retention+ist+w%C3%A4hrend+Backup/Restore+nicht+m%C3%B6glich.");
    }

    try {
      const retention = await runBackupRetentionNow();

      await writeAuditLog({
        action: "admin_backup_retention_run",
        actorId: request.currentUser?.id,
        details: {
          deletedFiles: retention.deletedFiles,
          deletedBytes: retention.deletedBytes
        }
      });

      const notice =
        retention.deletedFiles > 0
          ? `${retention.deletedFiles} Backup-Datei(en) durch Retention gelöscht.`
          : "Retention ausgeführt. Keine Datei wurde gelöscht.";
      return reply.redirect(`/admin/backups?notice=${encodeURIComponent(notice)}`);
    } catch (error) {
      return reply.redirect(`/admin/backups?error=${encodeURIComponent(error instanceof Error ? error.message : "Retention fehlgeschlagen.")}`);
    }
  });

  app.post("/admin/backups/restore/prepare", { preHandler: [requireAdmin] }, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.redirect("/admin/backups?error=Es+wurde+kein+Multipart-Upload+gesendet.");
    }

    let csrfToken = "";
    let passphrase = "";
    let uploaded:
      | {
          filePath: string;
          fileName: string;
          originalName: string;
        }
      | null = null;
    let fileCount = 0;
    let validationError = "";

    try {
      for await (const part of request.parts({ limits: { files: 1, fields: 8, fileSize: 1024 * 1024 * 1024 } })) {
        if (part.type === "field") {
          const value = typeof part.value === "string" ? part.value : String(part.value ?? "");
          if (part.fieldname === "_csrf") csrfToken = value;
          if (part.fieldname === "passphrase") passphrase = value;
          continue;
        }

        if (part.fieldname !== "backupFile") {
          part.file.resume();
          continue;
        }

        fileCount += 1;
        if (fileCount > 1 || uploaded) {
          validationError = "Bitte genau eine Backup-Datei hochladen.";
          part.file.resume();
          continue;
        }

        const target = await createRestoreUploadTarget();
        const originalName = (part.filename ?? "").trim() || target.fileName;

        await pipeline(part.file, createWriteStream(target.filePath, { flags: "wx" }));

        if (part.file.truncated) {
          await removeFile(target.filePath);
          validationError = "Die Upload-Datei ist zu groß.";
          continue;
        }

        uploaded = {
          filePath: target.filePath,
          fileName: target.fileName,
          originalName
        };
      }
    } catch (error) {
      if (uploaded) {
        await removeFile(uploaded.filePath);
      }

      request.log.warn({ error }, "Restore-Upload fehlgeschlagen");
      return reply.redirect("/admin/backups?error=Upload+fehlgeschlagen.+Bitte+Datei+oder+Gr%C3%B6%C3%9Fe+pr%C3%BCfen.");
    }

    if (!verifySessionCsrfToken(request, csrfToken)) {
      if (uploaded) {
        await removeFile(uploaded.filePath);
      }
      return reply.redirect("/admin/backups?error=Ung%C3%BCltiges+CSRF-Token.");
    }

    if (validationError) {
      if (uploaded) {
        await removeFile(uploaded.filePath);
      }
      return reply.redirect(`/admin/backups?error=${encodeURIComponent(validationError)}`);
    }

    if (!uploaded) {
      return reply.redirect("/admin/backups?error=Bitte+eine+Backup-Datei+ausw%C3%A4hlen.");
    }

    const prepared = await prepareRestoreUpload({
      stagedFilePath: uploaded.filePath,
      stagedFileName: uploaded.fileName,
      uploadedFileName: uploaded.originalName,
      passphrase,
      ...(request.currentUser?.id ? { actorId: request.currentUser.id } : {})
    });

    if (!prepared.ok) {
      return reply.redirect(`/admin/backups?error=${encodeURIComponent(prepared.error)}`);
    }

    await writeAuditLog({
      action: "admin_restore_prepared",
      actorId: request.currentUser?.id,
      targetId: prepared.prepared.id,
      details: {
        fileName: prepared.prepared.uploadedFileName,
        archiveEntries: prepared.prepared.archiveEntries
      }
    });

    return reply.redirect("/admin/backups?notice=Backup+gepr%C3%BCft.+Bitte+Wiederherstellung+best%C3%A4tigen.");
  });

  app.post("/admin/backups/restore/cancel", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const cancelled = await cancelPreparedRestore({
      ticketId: body.ticketId ?? "",
      ...(request.currentUser?.id ? { actorId: request.currentUser.id } : {})
    });

    if (!cancelled) {
      return reply.redirect("/admin/backups?error=Restore-Vorbereitung+nicht+gefunden+oder+abgelaufen.");
    }

    await writeAuditLog({
      action: "admin_restore_preparation_cancelled",
      actorId: request.currentUser?.id
    });

    return reply.redirect("/admin/backups?notice=Restore-Vorbereitung+verworfen.");
  });

  app.post("/admin/backups/restore/start", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    if ((body.confirm ?? "").trim().toLowerCase() !== "yes") {
      return reply.redirect("/admin/backups?error=Bitte+Wiederherstellung+explizit+best%C3%A4tigen.");
    }

    const result = startRestoreJob({
      ticketId: body.ticketId ?? "",
      passphrase: body.passphrase ?? "",
      ...(request.currentUser?.id ? { actorId: request.currentUser.id } : {})
    });

    if (!result.started) {
      return reply.redirect(`/admin/backups?error=${encodeURIComponent(result.reason ?? "Restore konnte nicht gestartet werden.")}`);
    }

    await writeAuditLog({
      action: "admin_restore_started",
      actorId: request.currentUser?.id
    });

    return reply.redirect("/admin/backups?notice=Restore+wurde+gestartet.");
  });

  app.get("/admin/backups/download/:fileName", { preHandler: [requireAdmin] }, async (request, reply) => {
    const params = request.params as { fileName: string };
    const fullPath = await resolveBackupFilePath(params.fileName);
    if (!fullPath) {
      return reply.redirect("/admin/backups?error=Backup-Datei+nicht+gefunden.");
    }

    const safeName = path.basename(fullPath);
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename=\"${safeName}\"`);
    return reply.send(createReadStream(fullPath));
  });

  app.get("/admin/api/backups/status", { preHandler: [requireAdmin] }, async (request, reply) => {
    const files = await listBackupFiles();
    const hasBackupKey = Boolean((process.env.BACKUP_ENCRYPTION_KEY ?? "").trim());
    const preparedRestore = await getPreparedRestoreInfo(request.currentUser?.id);
    return reply.send({
      ok: true,
      status: getBackupStatus(),
      restoreStatus: getRestoreStatus(),
      automation: getBackupAutomationStatus(),
      preparedRestore,
      files,
      hasBackupKey
    });
  });

  app.post("/admin/api/backups/start", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).send({
        ok: false,
        error: "Ungültiges CSRF-Token"
      });
    }

    const result = startBackupJob();

    if (result.started) {
      await writeAuditLog({
        action: "admin_backup_started",
        actorId: request.currentUser?.id
      });
    }

    const files = await listBackupFiles();

    return reply.send({
      ok: result.started,
      started: result.started,
      reason: result.reason,
      status: result.status,
      restoreStatus: getRestoreStatus(),
      automation: getBackupAutomationStatus(),
      preparedRestore: await getPreparedRestoreInfo(request.currentUser?.id),
      hasBackupKey: Boolean((process.env.BACKUP_ENCRYPTION_KEY ?? "").trim()),
      files
    });
  });

  app.get("/admin/links", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const brokenLinks = await listBrokenInternalLinks();

    const body = `
      ${renderAdminHeader({
        title: "Interne Wiki-Links",
        description: "Prüfung auf defekte [[Seite]]-Verweise im gesamten Wiki.",
        active: "links"
      })}
      ${renderBrokenLinksPanel(brokenLinks)}
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Interne Links",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.get("/admin/index", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const info = await getSearchIndexInfo();
    const status = getSearchIndexBuildStatus();
    const runtimeSettings = await getRuntimeSettings();

    const body = `
      ${renderAdminHeader({
        title: "Suchindex",
        description: "Suchindex-Dateien neu generieren und Fortschritt live verfolgen.",
        active: "index"
      })}
      ${renderIndexManagement(request.csrfToken ?? "", info, status, runtimeSettings.indexBackend)}
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Suchindex",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error,
        scripts: ["/admin-index.js?v=1"]
      })
    );
  });

  app.post("/admin/index/backend", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const previous = (await getRuntimeSettings()).indexBackend;
    const result = await setIndexBackend(
      request.currentUser?.username
        ? {
            backend: body.backend ?? "",
            updatedBy: request.currentUser.username
          }
        : {
            backend: body.backend ?? ""
          }
    );

    if (!result.ok) {
      return reply.redirect(`/admin/index?error=${encodeURIComponent(result.error ?? "Backend konnte nicht gesetzt werden.")}`);
    }

    const consistency = await ensureSearchIndexConsistency();

    await writeAuditLog({
      action: "admin_index_backend_changed",
      actorId: request.currentUser?.id,
      details: {
        previous,
        next: result.indexBackend,
        changed: result.changed,
        rebuilt: consistency.rebuilt,
        reason: consistency.reason
      }
    });

    const notice = result.changed
      ? `Index-Backend auf ${result.indexBackend} umgestellt. ${consistency.rebuilt ? "Index wurde neu aufgebaut." : "Index ist bereits aktuell."}`
      : `Index-Backend bleibt ${result.indexBackend}. ${consistency.rebuilt ? "Index wurde neu aufgebaut." : "Index ist aktuell."}`;

    return reply.redirect(`/admin/index?notice=${encodeURIComponent(notice)}`);
  });

  app.get("/admin/api/index/status", { preHandler: [requireAdmin] }, async (_request, reply) => {
    const info = await getSearchIndexInfo();
    const status = getSearchIndexBuildStatus();

    return reply.send({
      ok: true,
      status,
      info
    });
  });

  app.post("/admin/api/index/rebuild", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).send({
        ok: false,
        error: "Ungültiges CSRF-Token"
      });
    }

    const result = startSearchIndexRebuild();

    if (result.started) {
      await writeAuditLog({
        action: "admin_search_index_rebuild_started",
        actorId: request.currentUser?.id
      });
    }

    return reply.send({
      ok: result.started,
      started: result.started,
      reason: result.reason,
      status: result.status
    });
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
    const removedFromGroups = await removeUserFromAllGroups(target.username);

    await writeAuditLog({
      action: "admin_user_deleted",
      actorId: request.currentUser?.id,
      targetId: params.id,
      details: {
        removedFromGroups
      }
    });

    return reply.redirect("/admin/users?notice=Benutzer+gel%C3%B6scht");
  });
};
