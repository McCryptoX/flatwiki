(() => {
  "use strict";

  const { onReady } = window.FW;

  const hasActiveAdvancedFilters = (root) => {
    const fields = root.querySelectorAll(
      'input[name="tag"], input[name="author"], select[name="category"], select[name="timeframe"], select[name="scope"]'
    );
    for (const field of fields) {
      if (
        (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) &&
        field.name === "scope" &&
        field.value.trim().toLowerCase() === "all"
      ) {
        continue;
      }

      if (
        (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) &&
        field.value.trim().length > 0
      ) {
        return true;
      }
    }
    return false;
  };

  const getSelectLabel = (field) => {
    if (!(field instanceof HTMLSelectElement)) return "";
    const selected = field.options[field.selectedIndex];
    return selected && typeof selected.textContent === "string" ? selected.textContent.trim() : "";
  };

  const buildPreviewItems = (form) => {
    const items = [];
    const qInput = form.querySelector('input[name="q"]');
    const categorySelect = form.querySelector('select[name="category"]');
    const tagInput = form.querySelector('input[name="tag"]');
    const authorInput = form.querySelector('input[name="author"]');
    const timeframeSelect = form.querySelector('select[name="timeframe"]');
    const scopeSelect = form.querySelector('select[name="scope"]');

    if (qInput instanceof HTMLInputElement) {
      const value = qInput.value.trim();
      if (value.length > 0) {
        const terms = value
          .split(/\s+/)
          .map((term) => term.trim())
          .filter((term) => term.length > 0)
          .slice(0, 5);

        if (terms.length <= 1) {
          items.push(`Suche: ${value}`);
        } else {
          for (const term of terms) {
            items.push(`"${term}"`);
          }
        }
      }
    }

    if (categorySelect instanceof HTMLSelectElement && categorySelect.value.trim().length > 0) {
      const label = getSelectLabel(categorySelect);
      if (label) {
        items.push(`Kategorie: ${label}`);
      }
    }

    if (tagInput instanceof HTMLInputElement) {
      const value = tagInput.value.trim().replace(/^#+/, "");
      if (value.length > 0) {
        items.push(`#${value}`);
      }
    }

    if (authorInput instanceof HTMLInputElement) {
      const value = authorInput.value.trim();
      if (value.length > 0) {
        items.push(`Autor: ${value}`);
      }
    }

    if (timeframeSelect instanceof HTMLSelectElement && timeframeSelect.value.trim().length > 0) {
      const label = getSelectLabel(timeframeSelect);
      if (label) {
        items.push(`Zeitraum: ${label}`);
      }
    }

    if (scopeSelect instanceof HTMLSelectElement && scopeSelect.value.trim().toLowerCase() !== "all" && scopeSelect.value.trim().length > 0) {
      const label = getSelectLabel(scopeSelect);
      if (label) {
        items.push(`Bereich: ${label}`);
      }
    }

    return items;
  };

  const renderPreview = (target, items) => {
    target.innerHTML = "";
    if (!Array.isArray(items) || items.length < 1) {
      const hint = document.createElement("span");
      hint.className = "muted-note small";
      hint.textContent = "Keine zusätzlichen Filter aktiv.";
      target.append(hint);
      return;
    }

    for (const item of items) {
      const pill = document.createElement("span");
      pill.className = "dashboard-search-pill";
      pill.textContent = item;
      target.append(pill);
    }
  };

  onReady(() => {
    const searchForms = document.querySelectorAll("form[data-home-search]");
    if (searchForms.length < 1) return;

    for (const form of searchForms) {
      if (!(form instanceof HTMLFormElement)) continue;

      const toggle = form.querySelector("[data-home-search-toggle]");
      const panel = form.querySelector("[data-home-search-panel]");
      const preview = form.querySelector("[data-home-search-preview]");
      if (!(toggle instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) continue;

      const setOpen = (open) => {
        panel.hidden = !open;
        form.classList.toggle("is-advanced-open", open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      };

      setOpen(hasActiveAdvancedFilters(form));

      const syncPreview = () => {
        if (!(preview instanceof HTMLElement)) return;
        renderPreview(preview, buildPreviewItems(form));
      };
      syncPreview();

      const watchedFields = form.querySelectorAll(
        'input[name="q"], input[name="tag"], input[name="author"], select[name="category"], select[name="timeframe"], select[name="scope"]'
      );
      for (const field of watchedFields) {
        if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) continue;
        field.addEventListener("input", syncPreview);
        field.addEventListener("change", syncPreview);
      }

      toggle.addEventListener("click", () => {
        setOpen(panel.hidden);
      });

      form.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || panel.hidden) return;
        setOpen(false);
        toggle.focus();
      });

      document.addEventListener("click", (event) => {
        if (form.contains(event.target)) return;
        if (panel.hidden) return;
        setOpen(false);
      });
    }
  });
})();
