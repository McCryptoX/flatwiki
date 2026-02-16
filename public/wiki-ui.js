(() => {
  "use strict";

  const onReady = (callback) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  };

  const appendMarkdown = (textarea, markdownBlock) => {
    if (!markdownBlock) return;
    const value = textarea.value;
    const separator = value.trim().length === 0 ? "" : "\n\n";
    textarea.value = `${value}${separator}${markdownBlock}`.trimStart();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const wrapSelection = (textarea, prefix, suffix, placeholder) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    const content = selected || placeholder;
    const next = `${prefix}${content}${suffix}`;

    textarea.setRangeText(next, start, end, "select");
    const cursorStart = start + prefix.length;
    const cursorEnd = cursorStart + content.length;
    textarea.focus();
    textarea.setSelectionRange(cursorStart, cursorEnd);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const prefixSelectionLines = (textarea, prefix) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const full = textarea.value;
    const lineStart = full.lastIndexOf("\n", start - 1) + 1;
    const lineEndPos = full.indexOf("\n", end);
    const lineEnd = lineEndPos === -1 ? full.length : lineEndPos;
    const selectedBlock = full.slice(lineStart, lineEnd);
    const transformed = selectedBlock
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");

    textarea.setRangeText(transformed, lineStart, lineEnd, "select");
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const applyMarkdownAction = (textarea, action) => {
    switch (action) {
      case "h2":
        prefixSelectionLines(textarea, "## ");
        break;
      case "h3":
        prefixSelectionLines(textarea, "### ");
        break;
      case "bold":
        wrapSelection(textarea, "**", "**", "fett");
        break;
      case "italic":
        wrapSelection(textarea, "_", "_", "kursiv");
        break;
      case "quote":
        prefixSelectionLines(textarea, "> ");
        break;
      case "ul":
        prefixSelectionLines(textarea, "- ");
        break;
      case "ol":
        prefixSelectionLines(textarea, "1. ");
        break;
      case "code":
        wrapSelection(textarea, "\n```\n", "\n```\n", "Code");
        break;
      case "link":
        wrapSelection(textarea, "[", "](https://example.com)", "Linktext");
        break;
      case "table":
        appendMarkdown(
          textarea,
          "| Spalte A | Spalte B |\n| --- | --- |\n| Wert 1 | Wert 2 |"
        );
        break;
      default:
        break;
    }
  };

  const slugify = (value) =>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

  const loadTemplatePresets = (editorShell) => {
    const fallback = [
      {
        id: "blank",
        defaultTitle: "",
        defaultTags: [],
        defaultContent: "",
        sensitivity: "normal"
      }
    ];

    const script = editorShell.querySelector("script[data-template-presets]");
    if (!(script instanceof HTMLScriptElement)) {
      return fallback;
    }

    try {
      const parsed = JSON.parse(script.textContent || "[]");
      if (!Array.isArray(parsed)) return fallback;

      const presets = parsed
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const id = String(entry.id || "").trim();
          if (!id) return null;
          const defaultTags = Array.isArray(entry.defaultTags)
            ? entry.defaultTags
                .map((tag) => String(tag || "").trim())
                .filter((tag) => tag.length > 0)
            : [];
          return {
            id,
            defaultTitle: String(entry.defaultTitle || ""),
            defaultTags,
            defaultContent: String(entry.defaultContent || ""),
            sensitivity: entry.sensitivity === "sensitive" ? "sensitive" : "normal"
          };
        })
        .filter((entry) => entry !== null);

      if (presets.length < 1) return fallback;
      if (!presets.some((entry) => entry.id === "blank")) {
        presets.push(fallback[0]);
      }
      return presets;
    } catch {
      return fallback;
    }
  };

  onReady(() => {
    const editorShell = document.querySelector(".editor-shell");
    if (!editorShell) return;

    const contentTextarea = editorShell.querySelector('[data-editor-textarea], textarea[name="content"]');
    const titleInput = editorShell.querySelector('input[name="title"][data-title-input], input[name="title"]');
    const slugInput = editorShell.querySelector('input[name="slug"][data-slug-input], input[name="slug"]');
    const tagsInput = editorShell.querySelector('input[name="tags"]');
    const uploadForm = editorShell.querySelector(".image-upload-form");
    const output = editorShell.querySelector(".upload-markdown-output");
    const encryptionToggle = editorShell.querySelector('input[name="encrypted"][data-encrypted-toggle], input[name="encrypted"]');
    const visibilitySelect = editorShell.querySelector('select[name="visibility"]');
    const restrictedSections = Array.from(editorShell.querySelectorAll("[data-restricted-only]"));
    const accessPickers = restrictedSections
      .map((section) => {
        if (!(section instanceof HTMLElement)) return null;
        const list = section.querySelector("[data-picker-list]");
        if (!(list instanceof HTMLElement)) return null;

        const filter = section.querySelector("[data-picker-filter]");
        const count = section.querySelector("[data-picker-count]");

        return {
          section,
          list,
          filter: filter instanceof HTMLInputElement ? filter : null,
          count: count instanceof HTMLElement ? count : null
        };
      })
      .filter((entry) => entry !== null);
    const categorySelect = editorShell.querySelector('select[name="categoryId"]');
    const toolbarButtons = editorShell.querySelectorAll("[data-md-action]");
    const previewPanel = editorShell.querySelector(".editor-preview");
    const viewButtons = editorShell.querySelectorAll("[data-editor-view-btn]");
    const wizardRoot = editorShell.querySelector("[data-new-page-wizard]");
    const wizardCategorySelect = wizardRoot ? wizardRoot.querySelector("[data-wizard-category]") : null;
    const wizardSensitivityNote = wizardRoot ? wizardRoot.querySelector("[data-wizard-sensitivity-note]") : null;
    const wizardStepElements = wizardRoot
      ? {
          one: wizardRoot.querySelector('[data-wizard-step="1"]'),
          two: wizardRoot.querySelector('[data-wizard-step="2"]'),
          three: wizardRoot.querySelector('[data-wizard-step="3"]')
        }
      : null;
    const wizardTemplateButtons = wizardRoot
      ? Array.from(wizardRoot.querySelectorAll("[data-template-id]")).filter((entry) => entry instanceof HTMLButtonElement)
      : [];
    const wizardSensitivityButtons = wizardRoot
      ? Array.from(wizardRoot.querySelectorAll("[data-wizard-sensitivity]")).filter((entry) => entry instanceof HTMLButtonElement)
      : [];

    if (!(contentTextarea instanceof HTMLTextAreaElement)) return;

    const hasPreview = previewPanel instanceof HTMLElement;
    if (!hasPreview) {
      for (const button of viewButtons) {
        if (!(button instanceof HTMLButtonElement)) continue;
        if ((button.dataset.editorViewBtn || "write") === "preview") {
          button.disabled = true;
        }
      }
    }

    const uploadEndpoint = uploadForm instanceof HTMLFormElement ? uploadForm.dataset.uploadEndpoint || "/api/uploads" : "/api/uploads";
    const csrfToken = editorShell.dataset.csrf || (uploadForm instanceof HTMLFormElement ? uploadForm.dataset.csrf || "" : "");
    const previewEndpoint = editorShell.dataset.previewEndpoint || "/api/markdown/preview";
    const pageSlug = (editorShell.dataset.pageSlug || "").trim().toLowerCase();
    const uploadDisabledMessage = "Bild-Upload ist für verschlüsselte Artikel deaktiviert.";

    let previewTimer = null;
    let previewAbortController = null;
    let currentView = "write";

    const setView = (nextView) => {
      currentView = nextView === "preview" && hasPreview ? "preview" : "write";

      for (const button of viewButtons) {
        if (!(button instanceof HTMLButtonElement)) continue;
        const mode = button.dataset.editorViewBtn || "write";
        button.classList.toggle("is-active", mode === currentView);
      }

      if (hasPreview) {
        const previewMode = currentView === "preview";
        contentTextarea.hidden = previewMode;
        previewPanel.hidden = !previewMode;

        if (previewMode) {
          void refreshPreview();
        }
      } else {
        contentTextarea.hidden = false;
      }
    };

    const refreshPreview = async () => {
      if (!hasPreview) return;

      if (previewAbortController) {
        previewAbortController.abort();
      }
      previewAbortController = new AbortController();

      try {
        const response = await fetch(previewEndpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrfToken
          },
          signal: previewAbortController.signal,
          body: JSON.stringify({
            markdown: contentTextarea.value
          })
        });

        const data = await response.json();
        if (!response.ok || !data.ok) {
          previewPanel.innerHTML = `<p class="muted-note">${data.error || "Vorschau konnte nicht geladen werden."}</p>`;
          return;
        }

        previewPanel.innerHTML = `<article class="wiki-content">${String(data.html || "")}</article>`;
      } catch (_error) {
        previewPanel.innerHTML = '<p class="muted-note">Vorschau konnte nicht geladen werden.</p>';
      }
    };

    const schedulePreview = () => {
      if (previewTimer) {
        clearTimeout(previewTimer);
      }
      previewTimer = setTimeout(() => {
        if (currentView === "preview") {
          void refreshPreview();
        }
      }, 180);
    };

    const syncRestrictedVisibility = () => {
      if (!(visibilitySelect instanceof HTMLSelectElement)) return;
      const restricted = visibilitySelect.value === "restricted";
      for (const picker of accessPickers) {
        picker.section.hidden = !restricted;
      }
    };

    const syncSlugFromTitle = () => {
      if (!(titleInput instanceof HTMLInputElement) || !(slugInput instanceof HTMLInputElement) || slugInput.readOnly) return;
      if ((slugInput.dataset.slugAuto || "1") !== "1") return;
      slugInput.value = slugify(titleInput.value);
    };

    const updateSlugAutoState = () => {
      if (!(titleInput instanceof HTMLInputElement) || !(slugInput instanceof HTMLInputElement) || slugInput.readOnly) return;
      const current = slugInput.value.trim();
      const titleBased = slugify(titleInput.value);
      const isAuto = current.length === 0 || current === titleBased;
      slugInput.dataset.slugAuto = isAuto ? "1" : "0";
    };

    const templatePresets = loadTemplatePresets(editorShell);
    const templatePresetMap = new Map(templatePresets.map((preset) => [preset.id, preset]));
    const blankPreset =
      templatePresetMap.get("blank") || {
        id: "blank",
        defaultTitle: "",
        defaultTags: [],
        defaultContent: "",
        sensitivity: "normal"
      };

    let selectedTemplateId = "";
    let selectedSensitivity = "";

    const renderWizardStates = () => {
      if (!wizardRoot || !wizardStepElements) return;

      const step1Done =
        selectedTemplateId.length > 0 ||
        (titleInput instanceof HTMLInputElement && titleInput.value.trim().length > 0) ||
        contentTextarea.value.trim().length > 0;
      const step2Done = categorySelect instanceof HTMLSelectElement && categorySelect.value.trim().length > 0;
      const step3Done = selectedSensitivity.length > 0;
      const firstOpenStep = !step1Done ? 1 : !step2Done ? 2 : !step3Done ? 3 : 3;

      const states = [
        { element: wizardStepElements.one, done: step1Done, active: firstOpenStep === 1 },
        { element: wizardStepElements.two, done: step2Done, active: firstOpenStep === 2 },
        { element: wizardStepElements.three, done: step3Done, active: firstOpenStep === 3 }
      ];

      for (const state of states) {
        if (!(state.element instanceof HTMLElement)) continue;
        state.element.classList.toggle("is-done", state.done);
        state.element.classList.toggle("is-active", state.active);
      }
    };

    const setSensitivityVisual = (mode) => {
      if (!wizardRoot) return;
      for (const button of wizardSensitivityButtons) {
        if (!(button instanceof HTMLButtonElement)) continue;
        button.classList.toggle("is-selected", (button.dataset.wizardSensitivity || "") === mode);
      }
      if (wizardSensitivityNote instanceof HTMLElement) {
        if (mode === "sensitive") {
          wizardSensitivityNote.textContent =
            encryptionToggle instanceof HTMLInputElement && !encryptionToggle.disabled
              ? "Sensibel aktiv: Zugriff nur ausgewählt + Verschlüsselung aktiviert."
              : "Sensibel aktiv: Zugriff nur ausgewählt. Verschlüsselung ist aktuell nicht verfügbar.";
        } else {
          wizardSensitivityNote.textContent = "Standard aktiv: Alle angemeldeten Benutzer mit Zugriff.";
        }
      }
    };

    const applySensitivity = (mode) => {
      if (!(visibilitySelect instanceof HTMLSelectElement)) return;
      selectedSensitivity = mode === "sensitive" ? "sensitive" : "normal";
      visibilitySelect.value = selectedSensitivity === "sensitive" ? "restricted" : "all";
      visibilitySelect.dispatchEvent(new Event("change", { bubbles: true }));

      if (encryptionToggle instanceof HTMLInputElement && !encryptionToggle.disabled) {
        encryptionToggle.checked = selectedSensitivity === "sensitive";
        encryptionToggle.dispatchEvent(new Event("change", { bubbles: true }));
      }

      setSensitivityVisual(selectedSensitivity);
      renderWizardStates();
    };

    const syncSensitivityFromForm = () => {
      if (!(visibilitySelect instanceof HTMLSelectElement)) return;
      selectedSensitivity = visibilitySelect.value === "restricted" ? "sensitive" : "normal";
      setSensitivityVisual(selectedSensitivity);
      renderWizardStates();
    };

    const applyTemplatePreset = (templateId) => {
      if (!(titleInput instanceof HTMLInputElement) || !(tagsInput instanceof HTMLInputElement)) return;
      const normalizedTemplateId = String(templateId || "").trim();
      const preset = templatePresetMap.get(normalizedTemplateId) || blankPreset;
      const resolvedTemplateId = templatePresetMap.has(normalizedTemplateId)
        ? normalizedTemplateId
        : blankPreset.id;

      const shouldConfirmReplace =
        contentTextarea.value.trim().length > 0 &&
        contentTextarea.value.trim() !== String(preset.defaultContent || "").trim();
      if (shouldConfirmReplace && !window.confirm("Vorlage anwenden und vorhandenen Inhalt ersetzen?")) {
        return;
      }

      selectedTemplateId = resolvedTemplateId;
      titleInput.value = preset.defaultTitle || "";
      tagsInput.value = Array.isArray(preset.defaultTags) ? preset.defaultTags.join(", ") : "";
      contentTextarea.value = preset.defaultContent || "";
      contentTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      applySensitivity(preset.sensitivity === "sensitive" ? "sensitive" : "normal");

      if (slugInput instanceof HTMLInputElement && !slugInput.readOnly) {
        slugInput.dataset.slugAuto = "1";
        slugInput.value = slugify(titleInput.value);
      }

      for (const button of wizardTemplateButtons) {
        if (!(button instanceof HTMLButtonElement)) continue;
        button.classList.toggle("is-selected", (button.dataset.templateId || "") === resolvedTemplateId);
      }

      renderWizardStates();
      if (currentView === "preview") {
        void refreshPreview();
      }
    };

    const isUploadHardDisabled = () =>
      uploadForm instanceof HTMLFormElement && uploadForm.dataset.uploadHardDisabled === "1";

    const isEncryptedSelected = () =>
      encryptionToggle instanceof HTMLInputElement && !encryptionToggle.disabled && encryptionToggle.checked;

    const syncUploadAvailability = () => {
      if (!(uploadForm instanceof HTMLFormElement)) return;
      const shouldDisable = isUploadHardDisabled() || isEncryptedSelected();
      const fileInput = uploadForm.querySelector('input[type="file"][name="images"]');
      const submitButton = uploadForm.querySelector('button[type="submit"]');

      if (fileInput instanceof HTMLInputElement) {
        fileInput.disabled = shouldDisable;
      }
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = shouldDisable;
      }

      if (output instanceof HTMLTextAreaElement && shouldDisable) {
        output.value = uploadDisabledMessage;
      }
      if (output instanceof HTMLTextAreaElement && !shouldDisable && output.value.trim() === uploadDisabledMessage) {
        output.value = "";
      }
    };

    const applyPickerFilter = (picker) => {
      const labels = picker.list.querySelectorAll("label[data-search]");
      const term = picker.filter instanceof HTMLInputElement ? picker.filter.value.trim().toLowerCase() : "";
      for (const label of labels) {
        if (!(label instanceof HTMLElement)) continue;
        const haystack = (label.dataset.search || "").toLowerCase();
        const visible = term.length === 0 || haystack.includes(term);
        label.hidden = !visible;
      }
    };

    const syncPickerCount = (picker) => {
      if (!(picker.count instanceof HTMLElement)) return;
      const checkboxes = picker.list.querySelectorAll('input[type="checkbox"]');
      const allCount = checkboxes.length;
      const selectedCount = picker.list.querySelectorAll('input[type="checkbox"]:checked').length;
      const visibleCount = picker.list.querySelectorAll("label[data-search]:not([hidden])").length;
      picker.count.textContent = `${selectedCount}/${allCount} ausgewählt, ${visibleCount} sichtbar`;
    };

    for (const button of toolbarButtons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.addEventListener("click", () => {
        const action = button.dataset.mdAction || "";
        applyMarkdownAction(contentTextarea, action);
      });
    }

    for (const button of viewButtons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.addEventListener("click", () => {
        const nextView = button.dataset.editorViewBtn || "write";
        setView(nextView);
      });
    }

    contentTextarea.addEventListener("input", schedulePreview);
    setView("write");
    syncRestrictedVisibility();
    for (const picker of accessPickers) {
      applyPickerFilter(picker);
      syncPickerCount(picker);
    }

    if (visibilitySelect instanceof HTMLSelectElement) {
      visibilitySelect.addEventListener("change", () => {
        syncRestrictedVisibility();
        syncSensitivityFromForm();
        for (const picker of accessPickers) {
          syncPickerCount(picker);
        }
      });
    }

    if (encryptionToggle instanceof HTMLInputElement) {
      encryptionToggle.addEventListener("change", () => {
        syncUploadAvailability();
      });
    }

    for (const picker of accessPickers) {
      if (picker.filter instanceof HTMLInputElement) {
        picker.filter.addEventListener("input", () => {
          applyPickerFilter(picker);
          syncPickerCount(picker);
        });
      }

      picker.list.addEventListener("change", (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.type === "checkbox") {
          syncPickerCount(picker);
        }
      });
    }

    if (titleInput instanceof HTMLInputElement) {
      titleInput.addEventListener("input", () => {
        syncSlugFromTitle();
        renderWizardStates();
      });
    }

    if (slugInput instanceof HTMLInputElement && !slugInput.readOnly) {
      slugInput.addEventListener("input", () => {
        updateSlugAutoState();
        renderWizardStates();
      });
      slugInput.addEventListener("blur", () => {
        updateSlugAutoState();
      });
    }

    if (categorySelect instanceof HTMLSelectElement) {
      categorySelect.addEventListener("change", () => {
        if (wizardCategorySelect instanceof HTMLSelectElement) {
          wizardCategorySelect.value = categorySelect.value;
        }
        renderWizardStates();
      });
    }

    if (wizardCategorySelect instanceof HTMLSelectElement && categorySelect instanceof HTMLSelectElement) {
      wizardCategorySelect.addEventListener("change", () => {
        categorySelect.value = wizardCategorySelect.value;
        categorySelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      wizardCategorySelect.value = categorySelect.value;
    }

    for (const button of wizardTemplateButtons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.addEventListener("click", () => {
        applyTemplatePreset(button.dataset.templateId || "blank");
      });
    }

    for (const button of wizardSensitivityButtons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.addEventListener("click", () => {
        const mode = button.dataset.wizardSensitivity || "normal";
        applySensitivity(mode);
      });
    }

    if (uploadForm instanceof HTMLFormElement && output instanceof HTMLTextAreaElement) {
      uploadForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (isUploadHardDisabled() || isEncryptedSelected()) {
          output.value = uploadDisabledMessage;
          return;
        }

        const fileInput = uploadForm.querySelector('input[type="file"][name="images"]');
        if (!(fileInput instanceof HTMLInputElement) || !fileInput.files || fileInput.files.length === 0) {
          output.value = "Bitte mindestens ein Bild auswählen.";
          return;
        }

        const formData = new FormData();
        for (const file of fileInput.files) {
          formData.append("images", file, file.name);
        }

        output.value = "Upload läuft...";

        try {
          let resolvedUploadEndpoint = uploadEndpoint;
          const params = new URLSearchParams();
          if (categorySelect instanceof HTMLSelectElement && categorySelect.value.trim().length > 0) {
            params.set("categoryId", categorySelect.value.trim());
          }
          if (isEncryptedSelected()) {
            params.set("encrypted", "1");
          }
          if (pageSlug.length > 0) {
            params.set("slug", pageSlug);
          }
          const queryString = params.toString();
          if (queryString.length > 0) {
            const separator = resolvedUploadEndpoint.includes("?") ? "&" : "?";
            resolvedUploadEndpoint = `${resolvedUploadEndpoint}${separator}${queryString}`;
          }

          const response = await fetch(resolvedUploadEndpoint, {
            method: "POST",
            headers: {
              "x-csrf-token": csrfToken
            },
            credentials: "same-origin",
            body: formData
          });

          const data = await response.json();
          if (!response.ok || !data.ok) {
            output.value = data.error || "Upload fehlgeschlagen.";
            return;
          }

          const markdown = String(data.markdown || "").trim();
          appendMarkdown(contentTextarea, markdown);
          output.value = markdown || "Upload abgeschlossen.";
          fileInput.value = "";
        } catch (_error) {
          output.value = "Upload fehlgeschlagen. Bitte erneut versuchen.";
        }
      });
    }

    syncUploadAvailability();
    syncSlugFromTitle();
    updateSlugAutoState();
    syncSensitivityFromForm();
    renderWizardStates();

    contentTextarea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        applyMarkdownAction(contentTextarea, "bold");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "i") {
        event.preventDefault();
        applyMarkdownAction(contentTextarea, "italic");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        applyMarkdownAction(contentTextarea, "link");
      }
    });
  });
})();
