(() => {
  const root = document.querySelector("[data-index-admin]");
  if (!root) return;

  const startButton = root.querySelector("[data-index-start]");
  const progress = root.querySelector("[data-index-progress]");
  const state = root.querySelector("[data-index-state]");
  const percent = root.querySelector("[data-index-percent]");
  const message = root.querySelector("[data-index-message]");
  const time = root.querySelector("[data-index-time]");
  const error = root.querySelector("[data-index-error]");
  const csrf = root.getAttribute("data-csrf") || "";

  if (!startButton || !progress || !state || !percent || !message || !time || !error) return;

  let pollHandle = 0;
  let requestInFlight = false;

  const phaseLabel = (status) => {
    if (!status) return "Bereit";
    if (status.phase === "error") return "Fehler";
    if (status.running) return "Läuft";
    if (status.phase === "done") return "Fertig";
    return "Bereit";
  };

  const formatDate = (value) => {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("de-DE", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  };

  const render = (status) => {
    const current = status || {};
    const currentPercent = Number.isFinite(current.percent) ? Math.max(0, Math.min(100, current.percent)) : 0;

    state.textContent = phaseLabel(current);
    percent.textContent = `${currentPercent}%`;
    progress.value = currentPercent;
    message.textContent = String(current.message || "Bereit");
    time.textContent = `Start: ${formatDate(current.startedAt)} | Ende: ${formatDate(current.finishedAt)}`;
    startButton.disabled = Boolean(current.running);

    if (current.error) {
      error.textContent = String(current.error);
      error.hidden = false;
    } else {
      error.textContent = "";
      error.hidden = true;
    }
  };

  const pollStatus = async () => {
    if (requestInFlight) return;
    requestInFlight = true;
    try {
      const response = await fetch("/admin/api/index/status", {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) return;
      const payload = await response.json();
      if (!payload || !payload.status) return;
      render(payload.status);
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
      const running = startButton.disabled;
      schedulePoll(running ? 1200 : 4500);
    }, delayMs);
  };

  startButton.addEventListener("click", async () => {
    startButton.disabled = true;
    try {
      const response = await fetch("/admin/api/index/rebuild", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: new URLSearchParams({ _csrf: csrf })
      });

      const payload = await response.json().catch(() => null);
      if (payload && payload.status) {
        render(payload.status);
      }

      if (!response.ok && payload && payload.error) {
        error.textContent = String(payload.error);
        error.hidden = false;
      }
    } catch {
      error.textContent = "Index konnte nicht gestartet werden.";
      error.hidden = false;
      startButton.disabled = false;
    } finally {
      schedulePoll(300);
    }
  });

  schedulePoll(300);
})();
