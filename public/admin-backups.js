(() => {
  const root = document.querySelector("[data-backup-admin]");
  if (!root) return;

  const startButton = root.querySelector("[data-backup-start]");
  const progress = root.querySelector("[data-backup-progress]");
  const state = root.querySelector("[data-backup-state]");
  const percent = root.querySelector("[data-backup-percent]");
  const message = root.querySelector("[data-backup-message]");
  const time = root.querySelector("[data-backup-time]");
  const target = root.querySelector("[data-backup-target]");
  const error = root.querySelector("[data-backup-error]");
  const filesBody = root.querySelector("[data-backup-files]");

  const restoreProgress = root.querySelector("[data-restore-progress]");
  const restoreState = root.querySelector("[data-restore-state]");
  const restorePercent = root.querySelector("[data-restore-percent]");
  const restoreMessage = root.querySelector("[data-restore-message]");
  const restoreTime = root.querySelector("[data-restore-time]");
  const restoreSource = root.querySelector("[data-restore-source]");
  const restoreError = root.querySelector("[data-restore-error]");
  const autoState = root.querySelector("[data-auto-state]");
  const autoInterval = root.querySelector("[data-auto-interval]");
  const autoNextRun = root.querySelector("[data-auto-next-run]");
  const autoLastRun = root.querySelector("[data-auto-last-run]");
  const autoLastResult = root.querySelector("[data-auto-last-result]");
  const autoRetention = root.querySelector("[data-auto-retention]");
  const autoLastRetention = root.querySelector("[data-auto-last-retention]");
  const autoMessage = root.querySelector("[data-auto-message]");
  const autoError = root.querySelector("[data-auto-error]");

  const csrf = root.getAttribute("data-csrf") || "";

  if (!startButton || !progress || !state || !percent || !message || !time || !target || !error || !filesBody) return;

  let pollHandle = 0;
  let requestInFlight = false;
  let backupRunning = false;
  let restoreRunning = false;

  const { escapeHtml, formatDate } = window.FW;

  const formatSize = (sizeBytes) => {
    const bytes = Number(sizeBytes || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const phaseLabel = (status) => {
    if (!status) return "Bereit";
    if (status.phase === "error") return "Fehler";
    if (status.running) return "Läuft";
    if (status.phase === "done") return "Fertig";
    return "Bereit";
  };

  const renderBackupStatus = (status, hasBackupKey) => {
    const current = status || {};
    const currentPercent = Number.isFinite(current.percent) ? Math.max(0, Math.min(100, current.percent)) : 0;

    state.textContent = phaseLabel(current);
    percent.textContent = `${currentPercent}%`;
    progress.value = currentPercent;
    message.textContent = String(current.message || "Bereit");
    time.textContent = `Start: ${formatDate(current.startedAt)} | Ende: ${formatDate(current.finishedAt)}`;
    target.innerHTML = `Datei: ${current.archiveFileName ? `<code>${escapeHtml(current.archiveFileName)}</code>` : "-"}`;

    const disableStart = Boolean(current.running) || restoreRunning || !hasBackupKey;
    startButton.disabled = disableStart;
    backupRunning = Boolean(current.running);

    if (current.error) {
      error.textContent = String(current.error);
      error.hidden = false;
    } else {
      error.textContent = "";
      error.hidden = true;
    }
  };

  const renderRestoreStatus = (status) => {
    if (!restoreProgress || !restoreState || !restorePercent || !restoreMessage || !restoreTime || !restoreSource || !restoreError) {
      return;
    }

    const current = status || {};
    const currentPercent = Number.isFinite(current.percent) ? Math.max(0, Math.min(100, current.percent)) : 0;

    restoreState.textContent = phaseLabel(current);
    restorePercent.textContent = `${currentPercent}%`;
    restoreProgress.value = currentPercent;
    restoreMessage.textContent = String(current.message || "Bereit");
    restoreTime.textContent = `Start: ${formatDate(current.startedAt)} | Ende: ${formatDate(current.finishedAt)}`;
    restoreSource.innerHTML = `Quelle: ${current.sourceFileName ? `<code>${escapeHtml(current.sourceFileName)}</code>` : "-"}`;

    restoreRunning = Boolean(current.running);

    if (current.error) {
      restoreError.textContent = String(current.error);
      restoreError.hidden = false;
    } else {
      restoreError.textContent = "";
      restoreError.hidden = true;
    }
  };

  const renderAutomationStatus = (status) => {
    if (
      !autoState ||
      !autoInterval ||
      !autoNextRun ||
      !autoLastRun ||
      !autoLastResult ||
      !autoRetention ||
      !autoLastRetention ||
      !autoMessage ||
      !autoError
    ) {
      return;
    }

    const current = status || {};
    autoState.textContent = current.enabled ? "Aktiv" : "Deaktiviert";
    autoInterval.textContent = `${Number(current.intervalHours || 0)} Stunde(n)`;
    autoNextRun.textContent = formatDate(current.nextRunAt);
    autoLastRun.textContent = formatDate(current.lastRunAt);
    const lastResultLabel =
      current.lastResult === "success"
        ? "Erfolgreich"
        : current.lastResult === "error"
          ? "Fehler"
          : current.lastResult === "skipped"
            ? "Übersprungen"
            : "Noch kein Lauf";
    autoLastResult.textContent = lastResultLabel;
    const retentionParts = [];
    if (Number(current.retentionMaxFiles || 0) > 0) {
      retentionParts.push(`max. ${Number(current.retentionMaxFiles)} Dateien`);
    }
    if (Number(current.retentionMaxAgeDays || 0) > 0) {
      retentionParts.push(`max. ${Number(current.retentionMaxAgeDays)} Tage`);
    }
    autoRetention.textContent = retentionParts.length > 0 ? retentionParts.join(", ") : "deaktiviert";
    autoLastRetention.textContent = current.lastRetentionAt
      ? `${formatDate(current.lastRetentionAt)} (${Number(current.lastRetentionDeletedFiles || 0)} gelöscht)`
      : "-";
    autoMessage.textContent = String(current.lastMessage || "");

    if (current.lastError) {
      autoError.textContent = String(current.lastError);
      autoError.hidden = false;
    } else {
      autoError.textContent = "";
      autoError.hidden = true;
    }
  };

  const renderFiles = (files, disableDelete) => {
    const rows = Array.isArray(files) ? files : [];
    if (rows.length < 1) {
      filesBody.innerHTML = '<tr><td colspan="5" class="muted-note">Noch keine Backup-Dateien vorhanden.</td></tr>';
      return;
    }

    filesBody.innerHTML = rows
      .slice(0, 50)
      .map((file) => {
        const safeName = escapeHtml(file.fileName || "");
        const encodedName = encodeURIComponent(file.fileName || "");
        const checksum = file.hasChecksum ? "ja" : "nein";
        return `
          <tr>
            <td><code>${safeName}</code></td>
            <td>${escapeHtml(formatDate(file.modifiedAt))}</td>
            <td>${escapeHtml(formatSize(file.sizeBytes))}</td>
            <td>${checksum}</td>
            <td>
              <div class="action-row">
                <a class="button tiny secondary" href="/admin/backups/download/${encodedName}">Download</a>
                <form method="post" action="/admin/backups/delete" data-confirm="Backup-Datei wirklich löschen?">
                  <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}" />
                  <input type="hidden" name="fileName" value="${safeName}" />
                  <button type="submit" class="danger tiny" ${disableDelete ? "disabled" : ""}>Löschen</button>
                </form>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  };

  const pollStatus = async () => {
    if (requestInFlight) return;
    requestInFlight = true;
    try {
      const response = await fetch("/admin/api/backups/status", {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) return;
      const payload = await response.json();
      if (!payload || !payload.status) return;

      renderRestoreStatus(payload.restoreStatus);
      renderAutomationStatus(payload.automation);
      const hasBackupKey = Boolean(payload.hasBackupKey);
      renderBackupStatus(payload.status, hasBackupKey);
      renderFiles(payload.files, Boolean(payload.status?.running) || Boolean(payload.restoreStatus?.running));
    } catch {
      // noop
    } finally {
      requestInFlight = false;
    }
  };

  const schedulePoll = (delayMs) => {
    window.clearTimeout(pollHandle);
    pollHandle = window.setTimeout(async () => {
      await pollStatus();
      schedulePoll(backupRunning || restoreRunning ? 1400 : 5000);
    }, delayMs);
  };

  startButton.addEventListener("click", async () => {
    startButton.disabled = true;
    try {
      const response = await fetch("/admin/api/backups/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: new URLSearchParams({ _csrf: csrf })
      });

      const payload = await response.json().catch(() => null);
      if (payload && payload.restoreStatus) {
        renderRestoreStatus(payload.restoreStatus);
      }
      if (payload && payload.automation) {
        renderAutomationStatus(payload.automation);
      }
      if (payload && payload.status) {
        renderBackupStatus(payload.status, Boolean(payload.hasBackupKey));
      }
      if (payload && Array.isArray(payload.files)) {
        renderFiles(payload.files, Boolean(payload.status?.running) || Boolean(payload.restoreStatus?.running));
      }

      if (!response.ok || (payload && payload.ok === false && payload.reason)) {
        error.textContent = String(payload?.reason || payload?.error || "Backup konnte nicht gestartet werden.");
        error.hidden = false;
      }
    } catch {
      error.textContent = "Backup konnte nicht gestartet werden.";
      error.hidden = false;
      startButton.disabled = false;
    } finally {
      schedulePoll(300);
    }
  });

  filesBody.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const message = form.dataset.confirm;
    if (message && !confirm(message)) {
      event.preventDefault();
    }
  });

  schedulePoll(300);
})();
