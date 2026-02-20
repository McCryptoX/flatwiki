(() => {
  "use strict";

  const { onReady } = window.FW;

  // ── DOM builder ───────────────────────────────────────────────────────
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  // ── State ─────────────────────────────────────────────────────────────
  let backdrop = null;
  let selectedIndex = -1;
  let currentResults = [];
  let debounceTimer = null;
  let abortController = null;

  // ── Build palette DOM ─────────────────────────────────────────────────
  const buildPalette = () => {
    const bd = el("div", "cmd-palette-backdrop");
    bd.setAttribute("role", "dialog");
    bd.setAttribute("aria-modal", "true");
    bd.setAttribute("aria-label", "Schnellsuche");

    const palette = el("div", "cmd-palette");

    const inputWrap = el("div", "cmd-palette-input-wrap");
    const input = el("input", "cmd-palette-input");
    input.type = "text";
    input.placeholder = "Artikel suchen \u2026";
    input.setAttribute("aria-label", "Suchbegriff");
    input.autocomplete = "off";
    input.spellcheck = false;
    const hint = el("span", "cmd-palette-hint", "ESC");
    inputWrap.append(input, hint);

    const resultsList = el("ul", "cmd-palette-results");
    resultsList.setAttribute("role", "listbox");

    const footer = el("div", "cmd-palette-footer");
    const kbUp = el("kbd", null, "\u2191");
    const kbDown = el("kbd", null, "\u2193");
    const navHint = document.createTextNode("\u00a0navigieren\u00a0\u00a0");
    const kbEnter = el("kbd", null, "\u21b5");
    const enterHint = document.createTextNode("\u00a0\u00f6ffnen");
    footer.append(kbUp, kbDown, navHint, kbEnter, enterHint);

    palette.append(inputWrap, resultsList, footer);
    bd.append(palette);

    return { bd, input, resultsList };
  };

  // ── Render results ────────────────────────────────────────────────────
  const renderResults = (resultsList, suggestions) => {
    resultsList.innerHTML = "";
    currentResults = Array.isArray(suggestions) ? suggestions : [];
    selectedIndex = -1;

    if (currentResults.length === 0) {
      resultsList.append(el("li", "cmd-palette-empty", "Keine Treffer gefunden."));
      return;
    }

    for (let i = 0; i < currentResults.length; i++) {
      const s = currentResults[i];
      const item = el("li");
      const link = el("a", "cmd-palette-result");
      link.href = String(s.url || "#");
      link.setAttribute("role", "option");
      link.dataset.idx = String(i);

      const title = el("span", "cmd-palette-result-title", String(s.title || s.slug || "Artikel"));
      link.append(title);

      const tags = Array.isArray(s.tags) ? s.tags.slice(0, 3) : [];
      if (tags.length > 0) {
        link.append(el("span", "cmd-palette-result-tags", `#${tags.join(" #")}`));
      }

      item.append(link);
      resultsList.append(item);
    }
  };

  const renderMessage = (resultsList, msg) => {
    resultsList.innerHTML = "";
    currentResults = [];
    selectedIndex = -1;
    resultsList.append(el("li", "cmd-palette-empty", msg));
  };

  // ── Keyboard selection ────────────────────────────────────────────────
  const updateSelection = (resultsList, nextIndex) => {
    const links = resultsList.querySelectorAll("a.cmd-palette-result");
    for (const link of links) {
      link.removeAttribute("aria-selected");
    }
    selectedIndex = Math.max(-1, Math.min(currentResults.length - 1, nextIndex));
    if (selectedIndex >= 0) {
      const target = links[selectedIndex];
      if (target instanceof HTMLAnchorElement) {
        target.setAttribute("aria-selected", "true");
        target.scrollIntoView({ block: "nearest" });
      }
    }
  };

  // ── Fetch suggestions ─────────────────────────────────────────────────
  const fetchSuggestions = async (term, resultsList) => {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    try {
      const response = await fetch(
        `/api/search/suggest?q=${encodeURIComponent(term)}&limit=8`,
        { credentials: "same-origin", signal: abortController.signal, headers: { accept: "application/json" } }
      );
      if (!response.ok) {
        renderMessage(resultsList, "Suche fehlgeschlagen.");
        return;
      }
      const data = await response.json();
      renderResults(resultsList, data.suggestions);
    } catch (err) {
      if (err.name !== "AbortError") {
        renderMessage(resultsList, "Suche fehlgeschlagen.");
      }
    }
  };

  const scheduleSearch = (term, resultsList) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (term.length < 2) {
      renderMessage(resultsList, "Mindestens 2 Zeichen eingeben \u2026");
      return;
    }
    debounceTimer = setTimeout(() => void fetchSuggestions(term, resultsList), 170);
  };

  // ── Open / close ──────────────────────────────────────────────────────
  const close = () => {
    if (!backdrop) return;
    if (abortController) abortController.abort();
    if (debounceTimer) clearTimeout(debounceTimer);
    backdrop.remove();
    backdrop = null;
    selectedIndex = -1;
    currentResults = [];
  };

  const open = () => {
    if (backdrop) return;

    const { bd, input, resultsList } = buildPalette();
    backdrop = bd;
    document.body.append(bd);
    renderMessage(resultsList, "Mindestens 2 Zeichen eingeben \u2026");

    requestAnimationFrame(() => input.focus());

    input.addEventListener("input", () => {
      scheduleSearch(input.value.trim(), resultsList);
    });

    bd.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        updateSelection(resultsList, selectedIndex + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        updateSelection(resultsList, selectedIndex - 1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (selectedIndex >= 0 && currentResults[selectedIndex]) {
          window.location.href = String(currentResults[selectedIndex].url || "#");
        } else {
          const term = input.value.trim();
          if (term.length > 0) {
            window.location.href = `/search?q=${encodeURIComponent(term)}`;
          }
        }
      }
    });

    bd.addEventListener("click", (e) => {
      if (e.target === bd) close();
    });
  };

  // ── Global shortcut: Cmd+K / Ctrl+K ──────────────────────────────────
  onReady(() => {
    document.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;

      const active = document.activeElement;
      const isEditor =
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement &&
          active.type !== "button" &&
          active.type !== "submit" &&
          active.type !== "checkbox" &&
          active.type !== "radio");
      if (isEditor) return; // preserve wiki-ui Ctrl+K (link shortcut)

      e.preventDefault();
      if (backdrop) {
        close();
      } else {
        open();
      }
    });
  });
})();
