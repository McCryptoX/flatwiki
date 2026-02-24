import type { FastifyInstance, FastifyRequest } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { requireAdmin, verifySessionCsrfToken } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";
import { config } from "../config.js";
import { removeFile } from "../lib/fileStore.js";
import { createCategory, findCategoryById, getDefaultCategory, listCategories, renameCategory } from "../lib/categoryStore.js";
import {
  createGroup,
  deleteGroup,
  findGroupById,
  listGroupIdsForUser,
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
  startSearchIndexRebuild,
  upsertSearchIndexBySlug
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
import { deleteCommentsForPage, deletePageComment, listAllComments, reviewPageComment, type PageComment } from "../lib/commentStore.js";
import { createNotification } from "../lib/notificationStore.js";
import { escapeHtml, formatDate, renderLayout } from "../lib/render.js";
import {
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
  listUsers,
  setUserPasswordByAdmin,
  updateUser,
  validateUserInput
} from "../lib/userStore.js";
import { validatePasswordStrength } from "../lib/password.js";
import { sendMail, sendMentionNotification, sendPageUpdateNotification } from "../lib/mailer.js";
import {
  getCommentModerationSettings,
  getRuntimeSettings,
  getSmtpSettings,
  getUiMode,
  setCommentModerationSettings,
  setIndexBackend,
  setPublicRead,
  setSmtpSettings,
  setUploadDerivativesEnabled,
  setUiMode,
  validateAndRepairRuntimeSettings,
  type RuntimeSmtpSettings,
  type UiMode
} from "../lib/runtimeSettingsStore.js";
import { backfillUploadDerivatives, getUploadDerivativeToolingStatus } from "../lib/uploadDerivativeBackfill.js";
import { deriveUploadPaths, isLikelyGeneratedDerivative } from "../lib/uploadDerivatives.js";
import { deleteUserSessions } from "../lib/sessionStore.js";
import { convertWikitextToMarkdown } from "../lib/wikitextImport.js";
import { canUserAccessPage, getPage, listBrokenInternalLinks, listPages, savePage, slugifyTitle } from "../lib/wikiStore.js";
import { listWatchersForPage } from "../lib/watchStore.js";
import type { PublicUser } from "../types.js";

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

const parseTrustedUsernamesInput = (value: string): string[] => {
  return value
    .split(/[\s,;]+/g)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
};

const parseCommentSelection = (values: string[]): Array<{ slug: string; commentId: string }> => {
  const seen = new Set<string>();
  const out: Array<{ slug: string; commentId: string }> = [];
  for (const entry of values) {
    const raw = String(entry ?? "").trim();
    if (!raw) continue;
    const splitIndex = raw.indexOf("::");
    if (splitIndex < 1) continue;
    const slug = raw.slice(0, splitIndex).trim().toLowerCase();
    const commentId = raw.slice(splitIndex + 2).trim();
    if (!slug || !commentId) continue;
    const key = `${slug}::${commentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug, commentId });
  }
  return out;
};

const buildCommentAdminQuery = (input: { status?: string; slug?: string; sort?: string }): string => {
  const query = new URLSearchParams();
  const status = (input.status ?? "").trim().toLowerCase();
  const slug = (input.slug ?? "").trim().toLowerCase();
  const sort = (input.sort ?? "").trim().toLowerCase();
  if (status) query.set("status", status);
  if (slug) query.set("slug", slug);
  if (sort) query.set("sort", sort);
  const output = query.toString();
  return output ? `?${output}` : "";
};

const parseCsvTags = (raw: string): string[] =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const readUploadPartAsText = async (part: { file: AsyncIterable<Buffer> }): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of part.file) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
};

const buildAccessUser = async (user: PublicUser): Promise<PublicUser> => {
  if (user.role === "admin") {
    return {
      ...user,
      groupIds: []
    };
  }
  const groupIds = await listGroupIdsForUser(user.username);
  return {
    ...user,
    groupIds
  };
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

const VALID_THEMES = new Set(["light", "dark", "system"]);
const themeOptions = (theme: string): string => `
  <option value="system" ${theme === "system" ? "selected" : ""}>System (automatisch)</option>
  <option value="light" ${theme === "light" ? "selected" : ""}>Hell</option>
  <option value="dark" ${theme === "dark" ? "selected" : ""}>Dunkel</option>
`;

const formatFileSize = (sizeBytes: number): string => {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
};

type UploadUsageReportData = Awaited<ReturnType<typeof getUploadUsageReport>>;
type UploadUsageFileEntry = UploadUsageReportData["files"][number];

interface MediaOriginalEntry {
  file: UploadUsageFileEntry;
  hasAvif: boolean;
  hasWebp: boolean;
  convertible: boolean;
  missingDerivatives: number;
}

const CONVERTIBLE_DERIVATIVE_SOURCE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif"]);

const buildMediaOriginalEntries = (report: UploadUsageReportData): MediaOriginalEntry[] => {
  const byFileName = new Map(report.files.map((entry) => [entry.fileName, entry] as const));
  const originals = report.files.filter((entry) => !isLikelyGeneratedDerivative(entry.fileName));

  return originals.map((entry) => {
    const derived = deriveUploadPaths(entry.fileName);
    const hasAvif = byFileName.has(derived.avifPath);
    const hasWebp = byFileName.has(derived.webpPath);
    const convertible = CONVERTIBLE_DERIVATIVE_SOURCE_EXTENSIONS.has(derived.extension);
    const missingDerivatives = convertible ? Number(!hasAvif) + Number(!hasWebp) : 0;
    return {
      file: entry,
      hasAvif,
      hasWebp,
      convertible,
      missingDerivatives
    };
  });
};

const renderMediaTable = (
  csrfToken: string,
  rows: MediaOriginalEntry[],
  options?: { onlyMissingDerivatives?: boolean }
): string => {
  if (rows.length === 0) {
    if (options?.onlyMissingDerivatives) {
      return '<p class="empty">Alle Originalbilder haben bereits AVIF/WEBP-Derivate.</p>';
    }
    return '<p class="empty">Keine Originalbilder vorhanden.</p>';
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Datei</th>
            <th>Größe</th>
            <th>Zuletzt geändert</th>
            <th>Derivate</th>
            <th>Einbindung</th>
            <th>Aktionen</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((row) => {
              const file = row.file;
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
              const derivativeState = row.convertible
                ? `<span class="${row.hasAvif ? "status-badge success" : "status-badge warning"}">AVIF ${row.hasAvif ? "vorhanden" : "fehlt"}</span>
                   <span class="${row.hasWebp ? "status-badge success" : "status-badge warning"}">WEBP ${row.hasWebp ? "vorhanden" : "fehlt"}</span>`
                : '<span class="status-badge secondary">nicht konvertierbar</span>';

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
                  <td><div class="action-row">${derivativeState}</div></td>
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

interface SslStatusInspection {
  appProtocol: string;
  appHost: string;
  normalizedHost: string;
  hostType: "domain" | "ip" | "localhost" | "unknown";
  proxyDetected: boolean;
  tlsDetected: boolean;
  forwardedHeader: string;
  forwardedProto: string;
  forwardedHost: string;
  forwardedPort: string;
  xForwardedProto: string;
  xForwardedHost: string;
  xForwardedPort: string;
  xForwardedFor: string;
  xRealIp: string;
  remoteAddress: string;
}

const firstForwardedToken = (value: string): string => {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0) ?? "";
};

const parseForwardedHeader = (value: string): { proto: string; host: string; port: string } => {
  const first = firstForwardedToken(value);
  if (!first) return { proto: "", host: "", port: "" };

  const params = first
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const result = { proto: "", host: "", port: "" };
  for (const param of params) {
    const separator = param.indexOf("=");
    if (separator < 1) continue;
    const key = param.slice(0, separator).trim().toLowerCase();
    const raw = param.slice(separator + 1).trim().replace(/^"|"$/g, "");
    if (!raw) continue;
    if (key === "proto") result.proto = raw.toLowerCase();
    if (key === "host") result.host = raw;
    if (key === "port") result.port = raw;
  }

  return result;
};

const normalizeHost = (rawHost: string): string => {
  const first = firstForwardedToken(rawHost);
  if (!first) return "";

  const ipv6Match = first.match(/^\[([a-f0-9:]+)\](?::\d+)?$/i);
  if (ipv6Match?.[1]) return ipv6Match[1].toLowerCase();

  const chunks = first.split(":");
  if (chunks.length > 1) {
    return (chunks[0] ?? "").trim().toLowerCase();
  }

  return first.trim().toLowerCase();
};

const classifyHost = (host: string): "domain" | "ip" | "localhost" | "unknown" => {
  if (!host) return "unknown";
  if (host === "localhost" || host === "::1" || host === "127.0.0.1" || host.endsWith(".local")) return "localhost";
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return "ip";
  if (/^[a-f0-9:]+$/i.test(host) && host.includes(":")) return "ip";
  if (host.includes(".")) return "domain";
  return "unknown";
};

const inspectSslStatus = (request: FastifyRequest): SslStatusInspection => {
  const forwardedHeader = readSingle(request.headers.forwarded).trim();
  const parsedForwarded = parseForwardedHeader(forwardedHeader);
  const xForwardedProto = firstForwardedToken(readSingle(request.headers["x-forwarded-proto"]).trim().toLowerCase());
  const xForwardedHost = firstForwardedToken(readSingle(request.headers["x-forwarded-host"]).trim());
  const xForwardedPort = firstForwardedToken(readSingle(request.headers["x-forwarded-port"]).trim());
  const xForwardedFor = firstForwardedToken(readSingle(request.headers["x-forwarded-for"]).trim());
  const xRealIp = readSingle(request.headers["x-real-ip"]).trim();
  const xForwardedSsl = readSingle(request.headers["x-forwarded-ssl"]).trim().toLowerCase();

  const appProtocol = (request.protocol || "").trim().toLowerCase();
  const appHost = firstForwardedToken(readSingle(request.headers.host).trim());
  const normalizedHost = normalizeHost(xForwardedHost || parsedForwarded.host || appHost);
  const hostType = classifyHost(normalizedHost);

  const proxyDetected = Boolean(xForwardedProto || xForwardedHost || xForwardedFor || xRealIp || forwardedHeader);
  const tlsDetected =
    appProtocol === "https" ||
    xForwardedProto === "https" ||
    parsedForwarded.proto === "https" ||
    xForwardedSsl === "on";

  return {
    appProtocol,
    appHost,
    normalizedHost,
    hostType,
    proxyDetected,
    tlsDetected,
    forwardedHeader,
    forwardedProto: parsedForwarded.proto,
    forwardedHost: parsedForwarded.host,
    forwardedPort: parsedForwarded.port,
    xForwardedProto,
    xForwardedHost,
    xForwardedPort,
    xForwardedFor,
    xRealIp,
    remoteAddress: request.ip
  };
};

const renderSslState = (state: "ok" | "warn" | "manual", text: string): string => {
  return `<span class="ssl-state ssl-state-${state}">${escapeHtml(text)}</span>`;
};

const renderSslManagement = (inspection: SslStatusInspection): string => {
  const hasPublicDomain = inspection.hostType === "domain";
  const warnings: string[] = [];

  if (!hasPublicDomain) {
    warnings.push("Host ist aktuell kein öffentlicher Domainname (localhost oder IP).");
  }
  if (hasPublicDomain && !inspection.tlsDetected) {
    warnings.push("HTTPS wird nicht erkannt. Prüfe Reverse-Proxy/TLS-Konfiguration.");
  }
  if (!config.isProduction) {
    warnings.push("NODE_ENV ist nicht auf production. Setze NODE_ENV=production für Secure-Cookies und produktive Header.");
  }

  return `
    <section class="content-wrap stack large">
      <div class="admin-index-panel">
        <h2>Erkannter TLS/Proxy-Status</h2>
        <dl class="admin-index-meta">
          <dt>Host</dt>
          <dd><code>${escapeHtml(inspection.normalizedHost || inspection.appHost || "-")}</code></dd>
          <dt>Host-Typ</dt>
          <dd>${escapeHtml(inspection.hostType)}</dd>
          <dt>HTTPS erkannt</dt>
          <dd>${inspection.tlsDetected ? renderSslState("ok", "Ja") : renderSslState("warn", "Nein")}</dd>
          <dt>Proxy-Header erkannt</dt>
          <dd>${inspection.proxyDetected ? renderSslState("ok", "Ja") : renderSslState("warn", "Nein")}</dd>
          <dt>App-Protokoll</dt>
          <dd><code>${escapeHtml(inspection.appProtocol || "-")}</code></dd>
          <dt>NODE_ENV=production</dt>
          <dd>${config.isProduction ? renderSslState("ok", "Ja") : renderSslState("warn", "Nein")}</dd>
        </dl>
      </div>

      <div class="admin-index-panel">
        <h2>To-do Checkliste</h2>
        <ul class="ssl-checklist">
          <li>${hasPublicDomain ? renderSslState("ok", "OK") : renderSslState("warn", "Offen")} Öffentliche Domain (kein localhost/IP)</li>
          <li>${inspection.proxyDetected ? renderSslState("ok", "OK") : renderSslState("warn", "Offen")} Reverse-Proxy liefert Forwarded/X-Forwarded-Header</li>
          <li>${inspection.tlsDetected ? renderSslState("ok", "OK") : renderSslState("warn", "Offen")} HTTPS/TLS aktiv erkannt</li>
          <li>${config.isProduction ? renderSslState("ok", "OK") : renderSslState("warn", "Offen")} App läuft mit NODE_ENV=production</li>
          <li>${renderSslState("manual", "Manuell")} Ports 80/443 in Firewall/Sicherheitsgruppe geöffnet</li>
          <li>${renderSslState("manual", "Manuell")} DNS A/AAAA zeigt auf den Server</li>
        </ul>
        <p class="muted-note">
          1-Klick-Setup außerhalb der App: <code>./scripts/deploy-caddy.sh --domain wiki.example.com --email admin@example.com</code>
        </p>
      </div>

      <div class="admin-index-panel">
        <h2>Empfangene Header (Debug, read-only)</h2>
        <dl class="admin-index-meta">
          <dt>Host</dt>
          <dd><code>${escapeHtml(inspection.appHost || "-")}</code></dd>
          <dt>X-Forwarded-Proto</dt>
          <dd><code>${escapeHtml(inspection.xForwardedProto || "-")}</code></dd>
          <dt>X-Forwarded-Host</dt>
          <dd><code>${escapeHtml(inspection.xForwardedHost || "-")}</code></dd>
          <dt>X-Forwarded-Port</dt>
          <dd><code>${escapeHtml(inspection.xForwardedPort || "-")}</code></dd>
          <dt>Forwarded</dt>
          <dd><code>${escapeHtml(inspection.forwardedHeader || "-")}</code></dd>
          <dt>Forwarded: proto</dt>
          <dd><code>${escapeHtml(inspection.forwardedProto || "-")}</code></dd>
          <dt>Forwarded: host</dt>
          <dd><code>${escapeHtml(inspection.forwardedHost || "-")}</code></dd>
          <dt>Forwarded: port</dt>
          <dd><code>${escapeHtml(inspection.forwardedPort || "-")}</code></dd>
          <dt>X-Forwarded-For</dt>
          <dd><code>${escapeHtml(inspection.xForwardedFor || "-")}</code></dd>
          <dt>X-Real-IP</dt>
          <dd><code>${escapeHtml(inspection.xRealIp || "-")}</code></dd>
          <dt>Erkannte Client-IP</dt>
          <dd><code>${escapeHtml(inspection.remoteAddress || "-")}</code></dd>
        </dl>
      </div>

      ${
        warnings.length > 0
          ? `
            <div class="admin-index-panel">
              <h2>Warnungen</h2>
              <ul class="ssl-warning-list">
                ${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}
              </ul>
            </div>
          `
          : `
            <div class="admin-index-panel">
              <h2>Status</h2>
              <p class="muted-note">Keine kritischen Warnungen erkannt. HTTPS/Proxy-Konfiguration wirkt konsistent.</p>
            </div>
          `
      }
    </section>
  `;
};

const renderUiModeManagement = (
  csrfToken: string,
  currentUiMode: UiMode,
  publicReadEnabled: boolean,
  uploadDerivativesEnabled: boolean,
  toolingStatus: Awaited<ReturnType<typeof getUploadDerivativeToolingStatus>>
): string => `
  <section class="content-wrap stack admin-settings-shell">
    <form method="post" action="/admin/ui" class="stack">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
      <div class="admin-index-panel stack">
        <h2>Allgemeine Einstellungen</h2>
        <label>Wiki Name
          <input type="text" value="${escapeHtml(config.wikiTitle)}" readonly aria-readonly="true" />
        </label>
        <label>Beschreibung
          <textarea rows="3" readonly aria-readonly="true">Datenschutzfreundliches Flat-File-Wiki mit rollenbasiertem Zugriff und Markdown-Workflows.</textarea>
        </label>
        <p class="muted-note small">Name/Beschreibung werden derzeit über Umgebungsvariablen gesteuert und hier als Referenz angezeigt.</p>
      </div>

      <div class="admin-index-panel stack">
        <h2>Sicherheit & Zugang</h2>
        <label>Bedienmodus
          <select name="mode">
            <option value="simple" ${currentUiMode === "simple" ? "selected" : ""}>Einfach</option>
            <option value="advanced" ${currentUiMode === "advanced" ? "selected" : ""}>Erweitert</option>
          </select>
        </label>
        <label>Öffentlicher Lesezugriff
          <select name="publicRead">
            <option value="0" ${!publicReadEnabled ? "selected" : ""}>Aus (Wiki privat)</option>
            <option value="1" ${publicReadEnabled ? "selected" : ""}>An (Lesen ohne Login)</option>
          </select>
        </label>
        <label>Upload-Derivate (AVIF/WEBP)
          <select name="uploadDerivativesEnabled">
            <option value="0" ${!uploadDerivativesEnabled ? "selected" : ""}>Aus</option>
            <option value="1" ${uploadDerivativesEnabled ? "selected" : ""}>An</option>
          </select>
        </label>
        <p class="muted-note small">
          Tool-Status: AVIF (${toolingStatus.avifenc.available ? "OK" : "Fehlt"}: <code>${escapeHtml(toolingStatus.avifenc.command)}</code>),
          WEBP (${toolingStatus.cwebp.available ? "OK" : "Fehlt"}: <code>${escapeHtml(toolingStatus.cwebp.command)}</code>)
          ${
            toolingStatus.avifenc.available && toolingStatus.cwebp.available
              ? ""
              : `<br />Fehlende Tools in Docker nachinstallieren via <code>docker compose up -d --build</code>.`
          }
        </p>
      </div>

      <div class="admin-index-panel stack">
        <div class="action-row">
          <button type="submit">Änderungen speichern</button>
          <a class="button secondary" href="/admin/ui">Verwerfen</a>
        </div>
      </div>
    </form>
    <form method="post" action="/admin/ui/repair" class="stack">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
      <div class="admin-index-panel">
        <div class="action-row">
          <button type="submit" class="secondary">Konfiguration prüfen & reparieren</button>
        </div>
      </div>
    </form>
  </section>
`;

export type AdminNavKey =
  | "users"
  | "ui"
  | "mail"
  | "comments"
  | "media"
  | "import"
  | "categories"
  | "templates"
  | "groups"
  | "versions"
  | "backups"
  | "links"
  | "seo"
  | "index"
  | "ssl";

const ADMIN_NAV_ITEMS: Array<{ key: AdminNavKey; href: string; label: string; minMode?: UiMode }> = [
  { key: "users", href: "/admin/users", label: "Benutzerverwaltung" },
  { key: "ui", href: "/admin/ui", label: "Bedienmodus" },
  { key: "mail", href: "/admin/mail", label: "E-Mail" },
  { key: "comments", href: "/admin/comments", label: "Kommentare" },
  { key: "media", href: "/admin/media", label: "Uploads & Bilder" },
  { key: "import", href: "/admin/import/wikitext", label: "Wikitext-Import", minMode: "advanced" },
  { key: "categories", href: "/admin/categories", label: "Kategorien" },
  { key: "templates", href: "/admin/templates", label: "Vorlagen" },
  { key: "groups", href: "/admin/groups", label: "Gruppen", minMode: "advanced" },
  { key: "versions", href: "/admin/versions", label: "Versionen", minMode: "advanced" },
  { key: "backups", href: "/admin/backups", label: "Backups", minMode: "advanced" },
  { key: "seo", href: "/admin/seo", label: "SEO / robots.txt" },
  { key: "ssl", href: "/admin/ssl", label: "TLS/SSL", minMode: "advanced" },
  { key: "links", href: "/admin/links", label: "Link-Check", minMode: "advanced" },
  { key: "index", href: "/admin/index", label: "Suchindex", minMode: "advanced" }
];

const renderAdminNav = (active: AdminNavKey): string => `
  <nav class="action-row admin-nav" aria-label="Admin Navigation">
    ${ADMIN_NAV_ITEMS.filter((item) => {
      if (!item.minMode) return true;
      return getUiMode() === "advanced";
    })
      .map((item) => {
      const activeClass = item.key === active ? " is-active-nav" : "";
      const ariaCurrent = item.key === active ? ' aria-current="page"' : "";
      return `<a class="button secondary${activeClass}" href="${item.href}"${ariaCurrent}>${item.label}</a>`;
    })
      .join("")}
  </nav>
`;

export const renderAdminHeader = (input: {
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
        description: "Konten datenschutzfreundlich verwalten (minimal gespeicherte Stammdaten).",
        active: "users",
        actions: '<a class="button" href="/admin/users/new">Neuen Benutzer anlegen</a>'
      })}
      ${renderUsersTable(request.csrfToken ?? "", request.currentUser?.id ?? "", users)}
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Benutzerverwaltung",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.get("/admin/ui", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const [runtimeSettings, toolingStatus] = await Promise.all([getRuntimeSettings(), getUploadDerivativeToolingStatus()]);
    const currentUiMode = getUiMode();

    const body = `
      ${renderAdminHeader({
        title: "Bedienmodus",
        description: "Wähle, wie umfangreich die Admin-Oberfläche angezeigt wird.",
        active: "ui"
      })}
      ${renderUiModeManagement(
        request.csrfToken ?? "",
        currentUiMode,
        runtimeSettings.publicRead,
        runtimeSettings.uploadDerivativesEnabled,
        toolingStatus
      )}
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Bedienmodus",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/admin/ui", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const modeResult = await setUiMode({
      mode: body.mode ?? "",
      ...(request.currentUser?.username ? { updatedBy: request.currentUser.username } : {})
    });
    if (!modeResult.ok) {
      return reply.redirect(`/admin/ui?error=${encodeURIComponent(modeResult.error ?? "Bedienmodus konnte nicht gespeichert werden.")}`);
    }

    const publicReadResult = await setPublicRead({
      enabled: body.publicRead ?? "0",
      ...(request.currentUser?.username ? { updatedBy: request.currentUser.username } : {})
    });
    if (!publicReadResult.ok) {
      return reply.redirect(`/admin/ui?error=${encodeURIComponent(publicReadResult.error ?? "Öffentlicher Lesezugriff konnte nicht gespeichert werden.")}`);
    }

    const uploadDerivativesResult = await setUploadDerivativesEnabled({
      enabled: body.uploadDerivativesEnabled ?? "0",
      ...(request.currentUser?.username ? { updatedBy: request.currentUser.username } : {})
    });
    if (!uploadDerivativesResult.ok) {
      return reply.redirect(
        `/admin/ui?error=${encodeURIComponent(uploadDerivativesResult.error ?? "Upload-Derivate konnten nicht gespeichert werden.")}`
      );
    }

    await writeAuditLog({
      action: "admin_ui_mode_changed",
      actorId: request.currentUser?.id,
      details: {
        mode: modeResult.uiMode,
        publicRead: publicReadResult.publicRead,
        uploadDerivativesEnabled: uploadDerivativesResult.uploadDerivativesEnabled
      }
    });

    const changedParts: string[] = [];
    if (modeResult.changed) {
      changedParts.push(`Modus: ${modeResult.uiMode === "simple" ? "Einfach" : "Erweitert"}`);
    }
    if (publicReadResult.changed) {
      changedParts.push(`Öffentlich lesen: ${publicReadResult.publicRead ? "An" : "Aus"}`);
    }
    if (uploadDerivativesResult.changed) {
      changedParts.push(`Upload-Derivate: ${uploadDerivativesResult.uploadDerivativesEnabled ? "An" : "Aus"}`);
    }
    const notice = changedParts.length > 0 ? `Gespeichert (${changedParts.join(", ")}).` : "Einstellungen unverändert.";
    return reply.redirect(`/admin/ui?notice=${encodeURIComponent(notice)}`);
  });

  app.post("/admin/ui/repair", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const repair = await validateAndRepairRuntimeSettings({
      ...(request.currentUser?.username ? { updatedBy: request.currentUser.username } : {})
    });

    await writeAuditLog({
      action: "admin_runtime_settings_repair",
      actorId: request.currentUser?.id,
      details: {
        changed: repair.changed,
        fixes: repair.fixes
      }
    });

    const notice = repair.changed
      ? `Konfiguration repariert (${repair.fixes.length > 0 ? repair.fixes.join(" | ") : "Normalisierung durchgeführt"}).`
      : "Konfiguration ist konsistent. Keine Änderungen nötig.";
    return reply.redirect(`/admin/ui?notice=${encodeURIComponent(notice)}`);
  });

  app.post("/admin/ui/smtp", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const current = await getSmtpSettings();
    const shouldClearPass = body.smtpPassClear === "1";
    const passRaw = body.smtpPass ?? "";
    const nextPass = shouldClearPass ? "" : passRaw.trim().length > 0 ? passRaw : current.pass;

    const result = await setSmtpSettings({
      host: body.smtpHost ?? "",
      port: body.smtpPort ?? "",
      secure: body.smtpSecure ?? "0",
      user: body.smtpUser ?? "",
      pass: nextPass,
      from: body.smtpFrom ?? "",
      ...(request.currentUser?.username ? { updatedBy: request.currentUser.username } : {})
    });

    if (!result.ok) {
      return reply.redirect(`/admin/mail?error=${encodeURIComponent(result.error ?? "SMTP-Einstellungen konnten nicht gespeichert werden.")}`);
    }

    await writeAuditLog({
      action: "admin_smtp_settings_changed",
      actorId: request.currentUser?.id,
      details: {
        host: result.smtp.host,
        port: result.smtp.port,
        secure: result.smtp.secure,
        user: result.smtp.user,
        from: result.smtp.from,
        passwordSet: result.smtp.pass.length > 0
      }
    });

    const notice = result.changed ? "SMTP-Einstellungen gespeichert." : "SMTP-Einstellungen unverändert.";
    return reply.redirect(`/admin/mail?notice=${encodeURIComponent(notice)}`);
  });

  app.get("/admin/mail", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const smtp = await getSmtpSettings();

    const body = `
      ${renderAdminHeader({
        title: "E-Mail",
        description: "SMTP-Konfiguration für Benachrichtigungen.",
        active: "mail"
      })}
      <section class="content-wrap stack">
        <div class="admin-index-panel stack">
          <h2>SMTP</h2>
          <p class="muted-note">
            Werte werden in <code>data/runtime-settings.json</code> gespeichert.
          </p>
          <form method="post" action="/admin/ui/smtp" class="stack">
            <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
            <label>SMTP-Host
              <input type="text" name="smtpHost" value="${escapeHtml(smtp.host)}" placeholder="smtp.example.com (leer = deaktiviert)" maxlength="255" />
            </label>
            <div class="action-row">
              <label>Port
                <input type="number" name="smtpPort" min="1" max="65535" value="${smtp.port}" />
              </label>
              <label>TLS direkt (Port 465)
                <select name="smtpSecure">
                  <option value="0" ${!smtp.secure ? "selected" : ""}>Nein (STARTTLS, z.B. 587)</option>
                  <option value="1" ${smtp.secure ? "selected" : ""}>Ja</option>
                </select>
              </label>
            </div>
            <label>Benutzer (optional)
              <input type="text" name="smtpUser" value="${escapeHtml(smtp.user)}" autocomplete="off" maxlength="254" />
            </label>
            <label>Passwort
              <input type="password" name="smtpPass" value="" autocomplete="new-password" placeholder="Leer lassen = unverändert" />
            </label>
            <label class="checkline">
              <input type="checkbox" name="smtpPassClear" value="1" />
              <span>Gespeichertes SMTP-Passwort löschen</span>
            </label>
            <label>Absender
              <input type="text" name="smtpFrom" value="${escapeHtml(smtp.from)}" placeholder="FlatWiki <wiki@example.com>" maxlength="260" />
            </label>
            <p class="muted-note small">
              SMTP-Passwort gespeichert: <strong>${smtp.pass ? "ja" : "nein"}</strong>
            </p>
            <div class="action-row">
              <button type="submit">SMTP speichern</button>
            </div>
          </form>
        </div>
        <div class="admin-index-panel stack">
          <h2>Testmail senden</h2>
          <p class="muted-note">Sendet eine einfache Testnachricht mit den aktuell gespeicherten SMTP-Einstellungen.</p>
          <form method="post" action="/admin/mail/test" class="stack">
            <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
            <label>Empfänger
              <input type="email" name="to" value="${escapeHtml(request.currentUser?.email ?? "")}" placeholder="du@example.com" required />
            </label>
            <div class="action-row">
              <button type="submit">Testmail senden</button>
            </div>
          </form>
        </div>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "E-Mail",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/admin/mail/test", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const to = (body.to ?? "").trim();
    if (!to.includes("@")) {
      return reply.redirect("/admin/mail?error=Bitte+g%C3%BCltige+Empf%C3%A4nger-E-Mail+eintragen.");
    }

    const ok = await sendMail({
      to,
      subject: `[${config.wikiTitle}] SMTP-Test`,
      text: `Dies ist eine SMTP-Testmail von ${config.wikiTitle}.\n\nZeit: ${new Date().toISOString()}`,
      html: `<p>Dies ist eine SMTP-Testmail von <strong>${escapeHtml(config.wikiTitle)}</strong>.</p><p>Zeit: <code>${escapeHtml(
        new Date().toISOString()
      )}</code></p>`
    });

    await writeAuditLog({
      action: "admin_mail_test_sent",
      actorId: request.currentUser?.id,
      details: {
        to,
        success: ok
      }
    });

    if (!ok) {
      return reply.redirect("/admin/mail?error=Testmail+konnte+nicht+gesendet+werden.+Bitte+SMTP-Konfiguration+pr%C3%BCfen.");
    }
    return reply.redirect(`/admin/mail?notice=${encodeURIComponent(`Testmail an ${to} gesendet.`)}`);
  });

  const notifyForApprovedComment = async (comment: PageComment): Promise<void> => {
    const page = await getPage(comment.slug);
    if (!page) return;

    const activeUsers = (await listUsers()).filter((entry) => !entry.disabled);
    const userById = new Map(activeUsers.map((entry) => [entry.id, entry] as const));

    for (const username of comment.mentions) {
      const mentioned = await findUserByUsername(username);
      if (!mentioned || mentioned.disabled) continue;
      if (mentioned.id === comment.authorId) continue;

      const accessUser = await buildAccessUser(mentioned);
      if (!canUserAccessPage(page, accessUser)) continue;

      const mentionResult = await createNotification({
        userId: mentioned.id,
        type: "mention",
        title: `${comment.authorDisplayName} hat dich erwähnt`,
        body: `in ${page.title}`,
        url: `/wiki/${encodeURIComponent(page.slug)}#comment-${encodeURIComponent(comment.id)}`,
        sourceSlug: page.slug,
        actorId: comment.authorId,
        dedupeKey: `mention:${page.slug}:${comment.id}:${mentioned.id}`
      });

      if (mentionResult.ok && mentionResult.created && mentioned.email) {
        sendMentionNotification({
          toEmail: mentioned.email,
          toDisplayName: mentioned.displayName,
          pageTitle: page.title,
          pageSlug: page.slug,
          commentId: comment.id,
          actorDisplayName: comment.authorDisplayName
        }).catch(() => {/* Mail-Fehler nie nach oben propagieren */});
      }
    }

    const watcherIds = await listWatchersForPage(page.slug);
    for (const watcherId of watcherIds) {
      if (watcherId === comment.authorId) continue;
      const watcher = userById.get(watcherId);
      if (!watcher) continue;
      const accessUser = await buildAccessUser(watcher);
      if (!canUserAccessPage(page, accessUser)) continue;

      const watcherResult = await createNotification({
        userId: watcher.id,
        type: "comment",
        title: `Neuer Kommentar: ${page.title}`,
        body: `${comment.authorDisplayName} hat einen Kommentar hinzugefügt.`,
        url: `/wiki/${encodeURIComponent(page.slug)}#comment-${encodeURIComponent(comment.id)}`,
        sourceSlug: page.slug,
        actorId: comment.authorId,
        dedupeKey: `comment:${page.slug}:${comment.id}:${watcher.id}`
      });

      if (watcherResult.ok && watcherResult.created && watcher.email) {
        sendPageUpdateNotification({
          toEmail: watcher.email,
          toDisplayName: watcher.displayName,
          pageTitle: page.title,
          pageSlug: page.slug,
          actorDisplayName: comment.authorDisplayName,
          eventType: "comment"
        }).catch(() => {/* Mail-Fehler nie nach oben propagieren */});
      }
    }
  };

  app.get("/admin/comments", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const selectedStatus = (query.status ?? "pending").trim().toLowerCase();
    const selectedSlug = (query.slug ?? "").trim().toLowerCase();
    const selectedSortRaw = (query.sort ?? "created_desc").trim().toLowerCase();
    const selectedSort = selectedSortRaw === "created_asc" || selectedSortRaw === "status" ? selectedSortRaw : "created_desc";
    const [comments, commentModeration, users] = await Promise.all([
      listAllComments(),
      getCommentModerationSettings(),
      listUsers()
    ]);
    const pages = await listPages();
    const titleBySlug = new Map(pages.map((page) => [page.slug, page.title] as const));
    const slugCounts = new Map<string, number>();
    for (const comment of comments) {
      slugCounts.set(comment.slug, (slugCounts.get(comment.slug) ?? 0) + 1);
    }

    const filtered = comments.filter((comment) => {
      const statusMatches = selectedStatus === "all" ? true : comment.status === selectedStatus;
      const slugMatches = selectedSlug.length < 1 ? true : comment.slug === selectedSlug;
      return statusMatches && slugMatches;
    });
    if (selectedSort === "created_asc") {
      filtered.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    } else if (selectedSort === "status") {
      const weight = (value: PageComment["status"]): number => (value === "pending" ? 0 : value === "rejected" ? 1 : 2);
      filtered.sort((a, b) => weight(a.status) - weight(b.status) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    } else {
      filtered.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }

    const statusOptions = [
      { id: "pending", label: "Pending" },
      { id: "approved", label: "Freigegeben" },
      { id: "rejected", label: "Abgelehnt" },
      { id: "all", label: "Alle" }
    ];
    const sortOptions = [
      { id: "created_desc", label: "Neueste zuerst" },
      { id: "created_asc", label: "Älteste zuerst" },
      { id: "status", label: "Status (pending zuerst)" }
    ];
    const moderationModeLabel =
      commentModeration.moderationMode === "all_auto"
        ? "Alle automatisch"
        : commentModeration.moderationMode === "trusted_auto"
          ? "Trusted User automatisch"
          : "Freigabe nötig";
    const moderationModeHint =
      commentModeration.moderationMode === "all_auto"
        ? "Neue Kommentare werden sofort veröffentlicht."
        : commentModeration.moderationMode === "trusted_auto"
          ? `Auto-Freigabe nur für: ${commentModeration.trustedAutoApproveUsernames.length > 0 ? commentModeration.trustedAutoApproveUsernames.join(", ") : "keine User hinterlegt"}`
          : "Neue Kommentare bleiben auf „pending“, bis ein Admin freigibt.";
    const trustedUserDisplay = commentModeration.trustedAutoApproveUsernames.join(", ");
    const knownActiveUsernames = users
      .filter((user) => !user.disabled)
      .map((user) => user.username)
      .sort((a, b) => a.localeCompare(b, "de"))
      .slice(0, 30)
      .join(", ");
    const slugOptions = Array.from(slugCounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0], "de"))
      .map(([slug, count]) => `<option value="${escapeHtml(slug)}" ${selectedSlug === slug ? "selected" : ""}>${escapeHtml(slug)} (${count})</option>`)
      .join("");

    const body = `
      ${renderAdminHeader({
        title: "Kommentare",
        description: "Moderation, Freigabe und Aufräumen von Kommentaren.",
        active: "comments"
      })}
      <section class="content-wrap stack large">
        <div class="admin-index-panel stack">
          <h2>Moderationseinstellungen</h2>
          <p class="muted-note">Steuert, wann neue Kommentare sofort sichtbar sind und wann eine Freigabe nötig ist.</p>
          <form method="post" action="/admin/comments/settings" class="stack">
            <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
            <label>Modus
              <select name="moderationMode">
                <option value="moderated" ${commentModeration.moderationMode === "moderated" ? "selected" : ""}>Freigabe nötig (Standard)</option>
                <option value="trusted_auto" ${commentModeration.moderationMode === "trusted_auto" ? "selected" : ""}>Nur bestimmte User automatisch freigeben</option>
                <option value="all_auto" ${commentModeration.moderationMode === "all_auto" ? "selected" : ""}>Alle automatisch freigeben</option>
              </select>
            </label>
            <label>Trusted User (nur für „bestimmte User automatisch freigeben“)
              <textarea name="trustedUsernames" rows="3" placeholder="z.B. admin, roman">${escapeHtml(trustedUserDisplay)}</textarea>
            </label>
            <p class="muted-note small">Eingabe mit Komma, Leerzeichen oder Zeilenumbruch trennen. Beispiel-User: ${escapeHtml(knownActiveUsernames || "-")}.</p>
            <div class="action-row">
              <button type="submit">Moderation speichern</button>
            </div>
          </form>
        </div>
        <div class="admin-index-panel">
          <h2>Aktiver Modus <span class="tag-chip">${escapeHtml(moderationModeLabel)}</span></h2>
          <p class="muted-note">${escapeHtml(moderationModeHint)}</p>
        </div>
        <div class="admin-index-panel">
          <form method="get" action="/admin/comments" class="action-row">
            <label>Status
              <select name="status">
                ${statusOptions
                  .map((option) => `<option value="${option.id}" ${selectedStatus === option.id ? "selected" : ""}>${option.label}</option>`)
                  .join("")}
              </select>
            </label>
            <label>Seite
              <select name="slug">
                <option value="">Alle Seiten</option>
                ${slugOptions}
              </select>
            </label>
            <label>Sortierung
              <select name="sort">
                ${sortOptions.map((option) => `<option value="${option.id}" ${selectedSort === option.id ? "selected" : ""}>${option.label}</option>`).join("")}
              </select>
            </label>
            <button type="submit" class="secondary">Filtern</button>
          </form>
        </div>
        <div class="admin-index-panel">
          ${
            filtered.length < 1
              ? '<p class="empty">Keine Kommentare für den aktuellen Filter gefunden.</p>'
              : `
                <form id="comment-bulk-form" method="post" action="/admin/comments/review-bulk" class="stack">
                  <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
                  <input type="hidden" name="status" value="${escapeHtml(selectedStatus)}" />
                  <input type="hidden" name="slug" value="${escapeHtml(selectedSlug)}" />
                  <input type="hidden" name="sort" value="${escapeHtml(selectedSort)}" />
                  <div class="action-row">
                    <button type="submit" name="decision" value="approve" class="secondary tiny" onclick="return confirm('Ausgewählte Kommentare wirklich freigeben?')">Auswahl freigeben</button>
                    <button type="submit" name="decision" value="reject" class="secondary tiny" onclick="return confirm('Ausgewählte Kommentare wirklich ablehnen?')">Auswahl ablehnen</button>
                    <button type="submit" formaction="/admin/comments/delete-bulk" class="danger tiny" onclick="return confirm('Ausgewählte Kommentare wirklich löschen?')">Auswahl löschen</button>
                  </div>
                </form>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Auswahl</th>
                        <th>Status</th>
                        <th>Seite</th>
                        <th>Autor</th>
                        <th>Text</th>
                        <th>Erstellt</th>
                        <th>Aktionen</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${filtered
                        .map((comment) => {
                          const statusLabel =
                            comment.status === "approved" ? "Freigegeben" : comment.status === "rejected" ? "Abgelehnt" : "Pending";
                          const excerpt = comment.body.length > 180 ? `${comment.body.slice(0, 180)}…` : comment.body;
                          return `
                            <tr>
                              <td>
                                <label class="checkline">
                                  <input type="checkbox" name="items" value="${escapeHtml(`${comment.slug}::${comment.id}`)}" form="comment-bulk-form" />
                                  <span class="sr-only">Kommentar auswählen</span>
                                </label>
                              </td>
                              <td>${escapeHtml(statusLabel)}</td>
                              <td><a href="/wiki/${encodeURIComponent(comment.slug)}#comment-${encodeURIComponent(comment.id)}">${escapeHtml(
                                titleBySlug.get(comment.slug) ?? comment.slug
                              )}</a></td>
                              <td>${escapeHtml(comment.authorDisplayName)} (${escapeHtml(comment.authorUsername)})</td>
                              <td>${escapeHtml(excerpt)}</td>
                              <td>${escapeHtml(formatDate(comment.createdAt))}</td>
                              <td>
                                <div class="action-row">
                                  <form method="post" action="/admin/comments/review">
                                    <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
                                    <input type="hidden" name="slug" value="${escapeHtml(comment.slug)}" />
                                    <input type="hidden" name="commentId" value="${escapeHtml(comment.id)}" />
                                    <input type="hidden" name="decision" value="approve" />
                                    <input type="hidden" name="filterStatus" value="${escapeHtml(selectedStatus)}" />
                                    <input type="hidden" name="filterSlug" value="${escapeHtml(selectedSlug)}" />
                                    <input type="hidden" name="filterSort" value="${escapeHtml(selectedSort)}" />
                                    <button type="submit" class="tiny secondary">Freigeben</button>
                                  </form>
                                  <form method="post" action="/admin/comments/review">
                                    <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
                                    <input type="hidden" name="slug" value="${escapeHtml(comment.slug)}" />
                                    <input type="hidden" name="commentId" value="${escapeHtml(comment.id)}" />
                                    <input type="hidden" name="decision" value="reject" />
                                    <input type="hidden" name="filterStatus" value="${escapeHtml(selectedStatus)}" />
                                    <input type="hidden" name="filterSlug" value="${escapeHtml(selectedSlug)}" />
                                    <input type="hidden" name="filterSort" value="${escapeHtml(selectedSort)}" />
                                    <button type="submit" class="tiny secondary">Ablehnen</button>
                                  </form>
                                  <form method="post" action="/admin/comments/delete" onsubmit="return confirm('Kommentar wirklich löschen?')">
                                    <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
                                    <input type="hidden" name="slug" value="${escapeHtml(comment.slug)}" />
                                    <input type="hidden" name="commentId" value="${escapeHtml(comment.id)}" />
                                    <input type="hidden" name="filterStatus" value="${escapeHtml(selectedStatus)}" />
                                    <input type="hidden" name="filterSlug" value="${escapeHtml(selectedSlug)}" />
                                    <input type="hidden" name="filterSort" value="${escapeHtml(selectedSort)}" />
                                    <button type="submit" class="tiny danger">Löschen</button>
                                  </form>
                                </div>
                              </td>
                            </tr>
                          `;
                        })
                        .join("")}
                    </tbody>
                  </table>
                </div>
              `
          }
        </div>
        <div class="admin-index-panel">
          <h2>Alle Kommentare einer Seite löschen</h2>
          <form method="post" action="/admin/comments/delete-page" class="action-row" onsubmit="return confirm('Alle Kommentare der gewählten Seite wirklich löschen?')">
            <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
            <input type="hidden" name="filterStatus" value="${escapeHtml(selectedStatus)}" />
            <input type="hidden" name="filterSlug" value="${escapeHtml(selectedSlug)}" />
            <input type="hidden" name="filterSort" value="${escapeHtml(selectedSort)}" />
            <select name="slug" required>
              <option value="">Seite wählen</option>
              ${slugOptions}
            </select>
            <button type="submit" class="danger">Alle löschen</button>
          </form>
        </div>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Kommentare",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/admin/comments/settings", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const moderationMode = (body.moderationMode ?? "").trim();
    const trustedUsernames = parseTrustedUsernamesInput(body.trustedUsernames ?? "");
    const result = await setCommentModerationSettings({
      moderationMode,
      trustedAutoApproveUsernames: trustedUsernames,
      ...(request.currentUser?.username ? { updatedBy: request.currentUser.username } : {})
    });
    if (!result.ok) {
      return reply.redirect(`/admin/comments?error=${encodeURIComponent(result.error ?? "Moderation konnte nicht gespeichert werden.")}`);
    }

    await writeAuditLog({
      action: "admin_comment_moderation_settings_changed",
      actorId: request.currentUser?.id,
      details: {
        moderationMode: result.comments.moderationMode,
        trustedCount: result.comments.trustedAutoApproveUsernames.length
      }
    });

    return reply.redirect(
      `/admin/comments?notice=${encodeURIComponent(
        result.changed ? "Moderationseinstellungen gespeichert." : "Moderationseinstellungen unverändert."
      )}`
    );
  });

  app.post("/admin/comments/review", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const redirectQuery = buildCommentAdminQuery({
      status: body.filterStatus ?? "pending",
      slug: body.filterSlug ?? "",
      sort: body.filterSort ?? "created_desc"
    });
    const slug = (body.slug ?? "").trim();
    const commentId = (body.commentId ?? "").trim();
    const approve = (body.decision ?? "").trim().toLowerCase() === "approve";
    const result = await reviewPageComment({
      slug,
      commentId,
      reviewerId: request.currentUser?.id ?? "",
      approve
    });
    if (!result.ok) {
      return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}error=${encodeURIComponent(result.error ?? "Kommentar konnte nicht moderiert werden.")}`);
    }

    await writeAuditLog({
      action: approve ? "admin_comment_approved" : "admin_comment_rejected",
      actorId: request.currentUser?.id,
      targetId: commentId,
      details: { slug }
    });

    if (approve && result.updated && result.previousStatus !== "approved") {
      await notifyForApprovedComment(result.updated);
    }

    return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}notice=${encodeURIComponent(approve ? "Kommentar freigegeben." : "Kommentar abgelehnt.")}`);
  });

  app.post("/admin/comments/review-bulk", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    const payload = asObject(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const redirectQuery = buildCommentAdminQuery({
      status: body.status ?? "pending",
      slug: body.slug ?? "",
      sort: body.sort ?? "created_desc"
    });
    const approve = (body.decision ?? "").trim().toLowerCase() === "approve";
    const items = parseCommentSelection(readMany(payload.items));
    if (items.length < 1) {
      return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}error=Bitte+mindestens+einen+Kommentar+ausw%C3%A4hlen.`);
    }

    let updatedCount = 0;
    let notifyCount = 0;
    for (const item of items) {
      const result = await reviewPageComment({
        slug: item.slug,
        commentId: item.commentId,
        reviewerId: request.currentUser?.id ?? "",
        approve
      });
      if (!result.ok || !result.updated) continue;
      updatedCount += 1;
      if (approve && result.previousStatus !== "approved") {
        await notifyForApprovedComment(result.updated);
        notifyCount += 1;
      }
      await writeAuditLog({
        action: approve ? "admin_comment_approved" : "admin_comment_rejected",
        actorId: request.currentUser?.id,
        targetId: item.commentId,
        details: { slug: item.slug, bulk: true }
      });
    }

    if (updatedCount < 1) {
      return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}error=Keine+ausgew%C3%A4hlten+Kommentare+konnten+aktualisiert+werden.`);
    }

    const summary = approve
      ? `${updatedCount} Kommentar(e) freigegeben${notifyCount > 0 ? `, ${notifyCount} Benachrichtigungsrunde(n) ausgelöst` : ""}.`
      : `${updatedCount} Kommentar(e) abgelehnt.`;
    return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}notice=${encodeURIComponent(summary)}`);
  });

  app.post("/admin/comments/delete-bulk", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    const payload = asObject(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const redirectQuery = buildCommentAdminQuery({
      status: body.status ?? "pending",
      slug: body.slug ?? "",
      sort: body.sort ?? "created_desc"
    });
    const items = parseCommentSelection(readMany(payload.items));
    if (items.length < 1) {
      return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}error=Bitte+mindestens+einen+Kommentar+ausw%C3%A4hlen.`);
    }

    let deletedCount = 0;
    for (const item of items) {
      const result = await deletePageComment({
        slug: item.slug,
        commentId: item.commentId,
        actorId: request.currentUser?.id ?? "",
        isAdmin: true
      });
      if (!result.ok || !result.deleted) continue;
      deletedCount += 1;
      await writeAuditLog({
        action: "admin_comment_deleted",
        actorId: request.currentUser?.id,
        targetId: item.commentId,
        details: { slug: item.slug, bulk: true }
      });
    }

    if (deletedCount < 1) {
      return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}error=Keine+ausgew%C3%A4hlten+Kommentare+konnten+gel%C3%B6scht+werden.`);
    }

    return reply.redirect(
      `/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}notice=${encodeURIComponent(`${deletedCount} Kommentar(e) gelöscht.`)}`
    );
  });

  app.post("/admin/comments/delete", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }
    const redirectQuery = buildCommentAdminQuery({
      status: body.filterStatus ?? "pending",
      slug: body.filterSlug ?? "",
      sort: body.filterSort ?? "created_desc"
    });
    const slug = (body.slug ?? "").trim();
    const commentId = (body.commentId ?? "").trim();
    const result = await deletePageComment({
      slug,
      commentId,
      actorId: request.currentUser?.id ?? "",
      isAdmin: true
    });
    if (!result.ok) {
      return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}error=${encodeURIComponent(result.error ?? "Kommentar konnte nicht gelöscht werden.")}`);
    }

    await writeAuditLog({
      action: "admin_comment_deleted",
      actorId: request.currentUser?.id,
      targetId: commentId,
      details: { slug }
    });
    return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}notice=Kommentar+gel%C3%B6scht.`);
  });

  app.post("/admin/comments/delete-page", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }
    const redirectQuery = buildCommentAdminQuery({
      status: body.filterStatus ?? "pending",
      slug: body.filterSlug ?? "",
      sort: body.filterSort ?? "created_desc"
    });
    const slug = (body.slug ?? "").trim();
    if (!slug) {
      return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}error=Bitte+eine+Seite+ausw%C3%A4hlen.`);
    }

    const removed = await deleteCommentsForPage(slug);
    await writeAuditLog({
      action: "admin_comments_deleted_for_page",
      actorId: request.currentUser?.id,
      targetId: slug,
      details: { removed }
    });
    return reply.redirect(`/admin/comments${redirectQuery}${redirectQuery ? "&" : "?"}notice=${encodeURIComponent(`${removed} Kommentar(e) gelöscht.`)}`);
  });

  app.get("/admin/media", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const [report, toolingStatus] = await Promise.all([getUploadUsageReport(), getUploadDerivativeToolingStatus()]);
    const onlyMissingDerivatives = query.missingOnly === "1";
    const originalEntries = buildMediaOriginalEntries(report);
    const tableEntries = onlyMissingDerivatives
      ? originalEntries.filter((entry) => entry.convertible && entry.missingDerivatives > 0)
      : originalEntries;
    const orphanCount = report.files.filter((file) => file.referencedBy.length === 0).length;
    const missingDerivativeOriginalCount = originalEntries.filter((entry) => entry.convertible && entry.missingDerivatives > 0).length;

    const body = `
      ${renderAdminHeader({
        title: "Uploads & Bilder",
        description: "Upload-Dateien prüfen, Referenzen nachvollziehen und unbenutzte Bilder entfernen.",
        active: "media",
        actions: `
          <form method="post" action="/admin/media/cleanup" onsubmit="return confirm('Alle ungenutzten Bilddateien wirklich löschen?')">
            <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
            <button type="submit">Verwaiste Bilder löschen</button>
          </form>
          <form method="post" action="/admin/media/derivatives/backfill">
            <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
            <input type="hidden" name="dryRun" value="0" />
            <input type="hidden" name="limit" value="500" />
            <input type="hidden" name="concurrency" value="2" />
            <button type="submit" ${toolingStatus.avifenc.available && toolingStatus.cwebp.available ? "" : "disabled"}>Bestehende Bilder konvertieren</button>
          </form>
        `
      })}
      <section class="content-wrap">
        <p>
          ${originalEntries.length} Originalbild(er), ${report.files.length} Upload-Datei(en), ${escapeHtml(formatFileSize(report.totalSizeBytes))} gesamt,
          ${orphanCount} ungenutzt, ${missingDerivativeOriginalCount} mit fehlenden Derivaten.
        </p>
        <p class="muted-note">
          Konverter-Status: AVIF (${toolingStatus.avifenc.available ? "OK" : "Fehlt"}: <code>${escapeHtml(toolingStatus.avifenc.command)}</code>),
          WEBP (${toolingStatus.cwebp.available ? "OK" : "Fehlt"}: <code>${escapeHtml(toolingStatus.cwebp.command)}</code>)
        </p>
        <form method="get" action="/admin/media" class="action-row">
          <label class="checkline">
            <input type="checkbox" name="missingOnly" value="1" ${onlyMissingDerivatives ? "checked" : ""} />
            <span>Nur Bilder mit fehlenden AVIF/WEBP-Derivaten anzeigen</span>
          </label>
          <button type="submit" class="secondary tiny">Filter anwenden</button>
        </form>
        <form method="post" action="/admin/media/derivatives/backfill" class="action-row">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <label>Max. Bilder
            <input type="number" name="limit" min="1" max="10000" value="500" />
          </label>
          <label>Gleichzeitig
            <input type="number" name="concurrency" min="1" max="8" value="2" />
          </label>
          <label>Nur seit Datum (optional)
            <input type="date" name="since" />
          </label>
          <label class="checkline">
            <input type="checkbox" name="dryRun" value="1" />
            <span>Testlauf (ohne Änderungen)</span>
          </label>
          <button type="submit" ${toolingStatus.avifenc.available && toolingStatus.cwebp.available ? "" : "disabled"}>Konvertierung starten</button>
        </form>
        ${renderMediaTable(request.csrfToken ?? "", tableEntries, { onlyMissingDerivatives })}
        ${renderMissingMediaReferences(report)}
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Uploads & Bilder",
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

  app.post("/admin/media/derivatives/backfill", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!verifySessionCsrfToken(request, body._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    const tooling = await getUploadDerivativeToolingStatus();
    if (!tooling.avifenc.available || !tooling.cwebp.available) {
      return reply.redirect(
        `/admin/media?error=${encodeURIComponent(
          `Konverter fehlen (avifenc=${tooling.avifenc.available ? "ok" : "fehlt"}, cwebp=${tooling.cwebp.available ? "ok" : "fehlt"}). Bitte Container neu bauen.`
        )}`
      );
    }

    const dryRun = readCheckbox(body.dryRun);
    const limit = Number.parseInt(body.limit ?? "500", 10);
    const concurrency = Number.parseInt(body.concurrency ?? "2", 10);
    const sinceRaw = (body.since ?? "").trim();
    const sinceCandidate = sinceRaw ? new Date(sinceRaw) : null;
    const since = sinceCandidate && Number.isFinite(sinceCandidate.getTime()) ? sinceCandidate : undefined;

    if (!Number.isFinite(limit) || limit < 1 || limit > 10_000) {
      return reply.redirect("/admin/media?error=Max.+Bilder+muss+zwischen+1+und+10000+liegen");
    }
    if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 8) {
      return reply.redirect("/admin/media?error=Gleichzeitig+muss+zwischen+1+und+8+liegen");
    }
    if (sinceRaw && !since) {
      return reply.redirect("/admin/media?error=Ung%C3%BCltiges+Datum+(YYYY-MM-DD)");
    }

    const summary = await backfillUploadDerivatives({
      uploadRootDir: config.uploadDir,
      dryRun,
      limit,
      concurrency,
      ...(since ? { since } : {})
    });

    await writeAuditLog({
      action: "admin_media_derivatives_backfill",
      actorId: request.currentUser?.id,
      details: {
        dryRun,
        limit,
        concurrency,
        ...(since ? { since: since.toISOString() } : {}),
        summary
      }
    });

    const notice = `Konvertierung ${dryRun ? "Testlauf" : "ausgeführt"}: eligible=${summary.eligible}, converted=${summary.converted}, skipped=${summary.skipped}, errors=${summary.errors}`;
    return reply.redirect(`/admin/media?notice=${encodeURIComponent(notice)}`);
  });

  app.get("/admin/import/wikitext", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const categories = await listCategories();
    const defaultCategory = await getDefaultCategory();

    const titleValue = readSingle(query.title);
    const slugValue = readSingle(query.slug);
    const tagsValue = readSingle(query.tags);
    const selectedCategoryId = readSingle(query.categoryId) || defaultCategory.id;
    const securityProfileValue = readSingle(query.securityProfile).trim().toLowerCase() === "confidential" ? "confidential" : "standard";

    const body = `
      ${renderAdminHeader({
        title: "Wikitext-Import",
        description: "MediaWiki/Wikitext in Markdown konvertieren und als FlatWiki-Artikel speichern.",
        active: "import"
      })}
      <section class="content-wrap stack">
        <p class="muted-note">
          Unterstützt unter anderem: Überschriften, Listen, Tabellen, externe Links, interne Wiki-Links, Datei/Bild-Links und
          <code>&lt;syntaxhighlight&gt;</code>-Blöcke.
        </p>
        <form method="post" action="/admin/import/wikitext" enctype="multipart/form-data" class="stack">
          <input type="hidden" name="_csrf" value="${escapeHtml(request.csrfToken ?? "")}" />
          <label>Titel (optional)
            <input type="text" name="title" value="${escapeHtml(titleValue)}" maxlength="120" placeholder="Wenn leer, aus der ersten Hauptüberschrift erkannt" />
          </label>
          <label>Seitenadresse (optional)
            <input type="text" name="slug" value="${escapeHtml(slugValue)}" pattern="[a-z0-9-]{1,80}" placeholder="Wird aus dem Titel erzeugt, wenn leer" />
          </label>
          <label>Kategorie
            <select name="categoryId" required>
              ${categories
                .map(
                  (category) =>
                    `<option value="${escapeHtml(category.id)}" ${category.id === selectedCategoryId ? "selected" : ""}>${escapeHtml(
                      category.name
                    )}</option>`
                )
                .join("")}
            </select>
          </label>
          <label>Tags (kommagetrennt)
            <input type="text" name="tags" value="${escapeHtml(tagsValue)}" placeholder="z. B. migration, wikitext, import" />
          </label>
          <label>Sicherheitsprofil
            <select name="securityProfile">
              <option value="standard" ${securityProfileValue === "standard" ? "selected" : ""}>Standard</option>
              <option value="confidential" ${securityProfileValue === "confidential" ? "selected" : ""}>Vertraulich (verschlüsselt)</option>
            </select>
          </label>
          <label>Wikitext einfügen
            <textarea name="wikitext" rows="14" placeholder="Wikitext hier einfügen ..."></textarea>
          </label>
          <label>Oder Wikitext-Datei hochladen
            <input type="file" name="sourceFile" accept=".txt,.wiki,.wikitext,.mediawiki,text/plain" />
          </label>
          <p class="muted-note small">
            Wenn Datei und Text vorhanden sind, wird die Datei verwendet.
          </p>
          <div class="action-row">
            <button type="submit">Wikitext importieren</button>
          </div>
        </form>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "Wikitext-Import",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
      })
    );
  });

  app.post("/admin/import/wikitext", { preHandler: [requireAdmin] }, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.redirect("/admin/import/wikitext?error=Bitte+Formular+als+Multipart+senden.");
    }

    const fields: Record<string, string> = {};
    let uploadedWikitext = "";
    let uploadedFileName = "";
    let parseError = "";
    let fileCount = 0;

    for await (const part of request.parts({ limits: { files: 1, fields: 24, fileSize: 5 * 1024 * 1024 } })) {
      if (part.type === "field") {
        const value = typeof part.value === "string" ? part.value : String(part.value ?? "");
        fields[part.fieldname] = value;
        continue;
      }

      if (part.fieldname !== "sourceFile") {
        part.file.resume();
        continue;
      }

      fileCount += 1;
      if (fileCount > 1) {
        part.file.resume();
        parseError = "Bitte höchstens eine Datei hochladen.";
        continue;
      }

      uploadedFileName = (part.filename ?? "").trim();
      uploadedWikitext = await readUploadPartAsText(part as unknown as { file: AsyncIterable<Buffer> });
      const streamWithMeta = part.file as unknown as { truncated?: boolean };
      if (streamWithMeta.truncated) {
        parseError = "Die Datei ist zu groß (max. 5 MB).";
      }
    }

    if (!verifySessionCsrfToken(request, fields._csrf ?? "")) {
      return reply.code(400).type("text/plain").send("Ungültiges CSRF-Token");
    }

    if (parseError) {
      return reply.redirect(`/admin/import/wikitext?error=${encodeURIComponent(parseError)}`);
    }

    const pastedWikitext = fields.wikitext ?? "";
    const sourceWikitext = uploadedWikitext.trim().length > 0 ? uploadedWikitext : pastedWikitext;
    if (sourceWikitext.trim().length < 1) {
      return reply.redirect("/admin/import/wikitext?error=Bitte+Wikitext+einfügen+oder+eine+Datei+hochladen.");
    }

    const conversion = convertWikitextToMarkdown(sourceWikitext);
    if (conversion.markdown.trim().length < 1) {
      return reply.redirect("/admin/import/wikitext?error=Der+importierte+Text+ergab+keinen+Inhalt.");
    }

    const requestedTitle = (fields.title ?? "").trim();
    const detectedTitle = conversion.detectedTitle.trim();
    const finalTitle = requestedTitle || detectedTitle || `Import ${new Date().toISOString().slice(0, 10)}`;
    const finalSlug = ((fields.slug ?? "").trim().toLowerCase() || slugifyTitle(finalTitle)).trim().toLowerCase();
    const selectedCategory = await findCategoryById(fields.categoryId ?? "");
    const fallbackCategory = await getDefaultCategory();
    const categoryId = selectedCategory?.id ?? fallbackCategory.id;
    const securityProfile = (fields.securityProfile ?? "").trim().toLowerCase() === "confidential" ? "confidential" : "standard";

    if (securityProfile === "confidential" && !config.contentEncryptionKey) {
      return reply.redirect("/admin/import/wikitext?error=Vertraulich+ist+ohne+CONTENT_ENCRYPTION_KEY+nicht+möglich.");
    }

    const actor = (request.currentUser?.username ?? "admin").trim().toLowerCase() || "admin";
    const result = await savePage({
      slug: finalSlug,
      title: finalTitle,
      tags: parseCsvTags(fields.tags ?? ""),
      content: conversion.markdown,
      updatedBy: actor,
      categoryId,
      securityProfile,
      visibility: securityProfile === "confidential" ? "restricted" : "all",
      allowedUsers: securityProfile === "confidential" ? [actor] : [],
      allowedGroups: [],
      encrypted: securityProfile === "confidential"
    });

    if (!result.ok) {
      const params = new URLSearchParams();
      params.set("error", result.error ?? "Import fehlgeschlagen.");
      params.set("title", finalTitle);
      params.set("slug", finalSlug);
      params.set("tags", fields.tags ?? "");
      params.set("categoryId", categoryId);
      params.set("securityProfile", securityProfile);
      return reply.redirect(`/admin/import/wikitext?${params.toString()}`);
    }

    await upsertSearchIndexBySlug(finalSlug);

    await writeAuditLog({
      action: "admin_wikitext_import",
      actorId: request.currentUser?.id,
      targetId: finalSlug,
      details: {
        source: uploadedFileName || "textarea",
        sourceLines: conversion.stats.sourceLines,
        markdownLines: conversion.stats.markdownLines,
        tables: conversion.stats.convertedTables,
        codeBlocks: conversion.stats.convertedCodeBlocks,
        warnings: conversion.warnings.length
      }
    });

    const noticeParts = [
      `Import abgeschlossen: ${conversion.stats.sourceLines} → ${conversion.stats.markdownLines} Zeilen.`,
      `${conversion.stats.convertedTables} Tabellen, ${conversion.stats.convertedCodeBlocks} Codeblöcke.`,
      conversion.warnings.length > 0 ? `${conversion.warnings.length} Hinweis(e), bitte Artikel prüfen.` : ""
    ].filter((entry) => entry.length > 0);

    return reply.redirect(`/wiki/${encodeURIComponent(finalSlug)}?notice=${encodeURIComponent(noticeParts.join(" "))}`);
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
        canonicalPath: (request.url.split("?")[0] ?? "/"),
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
        canonicalPath: (request.url.split("?")[0] ?? "/"),
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
        canonicalPath: (request.url.split("?")[0] ?? "/"),
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
        canonicalPath: (request.url.split("?")[0] ?? "/"),
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
        canonicalPath: (request.url.split("?")[0] ?? "/"),
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
        canonicalPath: (request.url.split("?")[0] ?? "/"),
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

  app.get("/admin/ssl", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = asRecord(request.query);
    const inspection = inspectSslStatus(request);

    const body = `
      ${renderAdminHeader({
        title: "TLS/SSL-Status",
        description: "Read-only Prüfung von Domain-, Proxy- und HTTPS-Signalen für externes Hosting.",
        active: "ssl"
      })}
      ${renderSslManagement(inspection)}
    `;

    return reply.type("text/html").send(
      renderLayout({
        canonicalPath: (request.url.split("?")[0] ?? "/"),
        title: "TLS/SSL-Status",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        notice: query.notice,
        error: query.error
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
        canonicalPath: (request.url.split("?")[0] ?? "/"),
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
        canonicalPath: (request.url.split("?")[0] ?? "/"),
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
        canonicalPath: (request.url.split("?")[0] ?? "/"),
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
          <label>E-Mail-Adresse <span class="muted-note small">(optional, für Benachrichtigungen)</span>
            <input type="email" name="email" value="${escapeHtml(query.email ?? user.email ?? "")}" autocomplete="email" />
          </label>
          <label>Rolle
            <select name="role">${roleOptions((query.role as "admin" | "user") ?? user.role)}</select>
          </label>
          <label>Theme
            <select name="theme">${themeOptions((query.theme as string) ?? user.theme ?? "system")}</select>
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
        canonicalPath: (request.url.split("?")[0] ?? "/"),
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
    const email = typeof body.email === "string" ? body.email : undefined;
    const themeRaw = body.theme;
    const theme = (typeof themeRaw === "string" && VALID_THEMES.has(themeRaw) ? themeRaw : undefined) as import("../types.js").Theme | undefined;

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
      disabled,
      ...(email !== undefined ? { email } : {}),
      ...(theme !== undefined ? { theme } : {})
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
