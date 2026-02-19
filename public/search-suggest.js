(() => {
  "use strict";

  const { onReady } = window.FW;

  const clearSuggestions = (panel) => {
    panel.innerHTML = "";
    panel.hidden = true;
  };

  const renderSuggestions = (panel, suggestions) => {
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      clearSuggestions(panel);
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
    panel.hidden = false;
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

      let debounceTimer = null;
      let activeRequest = null;

      const fetchSuggestions = async (term) => {
        if (activeRequest) {
          activeRequest.abort();
        }

        activeRequest = new AbortController();
        try {
          const response = await fetch(`/api/search/suggest?q=${encodeURIComponent(term)}&limit=8`, {
            credentials: "same-origin",
            signal: activeRequest.signal,
            headers: {
              accept: "application/json"
            }
          });

          if (!response.ok) {
            clearSuggestions(panel);
            return;
          }

          const data = await response.json();
          renderSuggestions(panel, data.suggestions);
        } catch (error) {
          if (error.name !== "AbortError") {
            console.warn("Search suggestions failed:", error);
          }
          clearSuggestions(panel);
        }
      };

      const trigger = () => {
        const term = input.value.trim();
        if (term.length < 2) {
          clearSuggestions(panel);
          return;
        }

        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          void fetchSuggestions(term);
        }, 170);
      };

      input.addEventListener("input", trigger);
      input.addEventListener("focus", trigger);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          clearSuggestions(panel);
        }
      });
      input.addEventListener("blur", () => {
        setTimeout(() => clearSuggestions(panel), 140);
      });

      document.addEventListener("click", (event) => {
        if (!box.contains(event.target)) {
          clearSuggestions(panel);
        }
      });
    }
  });
})();
