(() => {
  "use strict";

  const { onReady } = window.FW;

  const ACTIVE_FILTER_SELECTOR =
    'input[name="tag"], input[name="author"], select[name="category"], select[name="timeframe"], select[name="scope"]';

  const hasActiveFilters = (root) => {
    if (!(root instanceof HTMLElement)) return false;
    const fields = root.querySelectorAll(ACTIVE_FILTER_SELECTOR);
    for (const field of fields) {
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) continue;
      if (field.name === "scope" && field.value.trim().toLowerCase() === "all") continue;
      if (field.value.trim().length > 0) return true;
    }
    return false;
  };

  const setExpanded = (input, panel, expanded) => {
    input.setAttribute("aria-expanded", expanded ? "true" : "false");
    panel.hidden = !expanded;
  };

  const clearSuggestions = (panel) => {
    panel.innerHTML = "";
  };

  const renderStatus = (panel, input, text, className) => {
    clearSuggestions(panel);
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const status = document.createElement("span");
    status.className = className || "search-suggest-status";
    status.textContent = text;
    item.append(status);
    list.append(item);
    panel.append(list);
    setExpanded(input, panel, true);
  };

  const renderSuggestions = (panel, input, suggestions, withActiveFilters) => {
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      renderStatus(
        panel,
        input,
        withActiveFilters
          ? "Keine Treffer. Filter anpassen oder Suchbegriff erweitern."
          : "Keine Treffer. Anderen Suchbegriff versuchen.",
        "search-suggest-status"
      );
      return;
    }

    const list = document.createElement("ul");

    for (const suggestion of suggestions) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = String(suggestion.url || "#");
      link.className = "search-suggest-link";

      const title = document.createElement("span");
      title.className = "search-suggest-title";
      title.textContent = String(suggestion.title || suggestion.slug || "Treffer");

      const meta = document.createElement("span");
      meta.className = "search-suggest-meta";
      const tags = Array.isArray(suggestion.tags) ? suggestion.tags : [];
      meta.textContent = tags.length > 0 ? `#${tags.slice(0, 3).join(" #")}` : "";

      link.append(title);
      if (meta.textContent) {
        link.append(meta);
      }

      item.append(link);
      list.append(item);
    }

    panel.innerHTML = "";
    panel.append(list);
    setExpanded(input, panel, true);
  };

  onReady(() => {
    const searchBoxes = document.querySelectorAll(".search-box[data-search-suggest]");
    if (searchBoxes.length === 0) return;

    for (const box of searchBoxes) {
      const input = box.querySelector('input[name="q"]');
      const panel = box.querySelector(".search-suggest");
      if (!(input instanceof HTMLInputElement) || !(panel instanceof HTMLDivElement)) {
        continue;
      }

      const ownerForm = box.closest("form");
      const panelId = panel.id || `search-suggest-${Math.random().toString(36).slice(2, 10)}`;
      panel.id = panelId;
      input.setAttribute("role", "combobox");
      input.setAttribute("aria-controls", panelId);
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-expanded", "false");

      let debounceTimer = null;
      let activeRequest = null;
      let requestToken = 0;

      const fetchSuggestions = async (term) => {
        if (activeRequest) {
          activeRequest.abort();
        }

        const currentRequest = ++requestToken;
        activeRequest = new AbortController();
        renderStatus(panel, input, "Suche läuft …", "search-suggest-status is-loading");
        try {
          const response = await fetch(`/api/search/suggest?q=${encodeURIComponent(term)}&limit=8`, {
            credentials: "same-origin",
            signal: activeRequest.signal,
            headers: {
              accept: "application/json"
            }
          });

          if (!response.ok) {
            renderStatus(panel, input, "Suche aktuell nicht verfügbar.", "search-suggest-status");
            return;
          }

          const data = await response.json();
          if (currentRequest !== requestToken) return;
          renderSuggestions(panel, input, data.suggestions, hasActiveFilters(ownerForm));
        } catch (error) {
          if (error.name !== "AbortError") {
            console.warn("Search suggestions failed:", error);
            renderStatus(panel, input, "Suche aktuell nicht verfügbar.", "search-suggest-status");
          } else if (currentRequest === requestToken) {
            setExpanded(input, panel, false);
          }
        } finally {
          activeRequest = null;
        }
      };

      const trigger = () => {
        const term = input.value.trim();
        if (term.length < 2) {
          clearSuggestions(panel);
          setExpanded(input, panel, false);
          return;
        }

        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          void fetchSuggestions(term);
        }, 200);
      };

      input.addEventListener("input", trigger);
      input.addEventListener("focus", trigger);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          clearSuggestions(panel);
          setExpanded(input, panel, false);
        }
      });
      input.addEventListener("blur", () => {
        setTimeout(() => {
          clearSuggestions(panel);
          setExpanded(input, panel, false);
        }, 140);
      });

      document.addEventListener("click", (event) => {
        if (!box.contains(event.target)) {
          clearSuggestions(panel);
          setExpanded(input, panel, false);
        }
      });

      window.addEventListener("fw:escape", () => {
        if (activeRequest) activeRequest.abort();
        if (debounceTimer) clearTimeout(debounceTimer);
        clearSuggestions(panel);
        setExpanded(input, panel, false);
      });
    }
  });
})();
