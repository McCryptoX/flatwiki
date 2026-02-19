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

  const normalizeSecurityProfile = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "sensitive") return "sensitive";
    if (normalized === "confidential") return "confidential";
    return "standard";
  };

  const loadTemplatePresets = (editorShell) => {
    const fallback = [
      {
        id: "blank",
        defaultTitle: "",
        defaultTags: [],
        defaultContent: "",
        securityProfile: "standard"
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
            securityProfile: normalizeSecurityProfile(entry.securityProfile)
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
    const tagsNote = editorShell.querySelector("[data-tags-note]");
    const uploadForm = editorShell.querySelector(".image-upload-form");
    const output = editorShell.querySelector(".upload-markdown-output");
    const encryptionToggle = editorShell.querySelector('input[name="encrypted"][data-encrypted-toggle], input[name="encrypted"]');
    const visibilitySelect = editorShell.querySelector('select[name="visibility"]');
    const securityProfileInput = editorShell.querySelector('[data-security-profile-input]');
    const securityProfileButtons = Array.from(editorShell.querySelectorAll("[data-security-profile]"));
    const securityProfileNotes = Array.from(editorShell.querySelectorAll("[data-security-profile-note]"));
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
    const wizardVisibilitySelect = wizardRoot ? wizardRoot.querySelector("[data-wizard-visibility]") : null;

    if (!(contentTextarea instanceof HTMLTextAreaElement)) return;

    const uploadEndpoint = uploadForm instanceof HTMLFormElement ? uploadForm.dataset.uploadEndpoint || "/api/uploads" : "/api/uploads";
    const csrfToken = editorShell.dataset.csrf || (uploadForm instanceof HTMLFormElement ? uploadForm.dataset.csrf || "" : "");
    const previewEndpoint = editorShell.dataset.previewEndpoint || "/api/markdown/preview";
    const pageSlug = (editorShell.dataset.pageSlug || "").trim().toLowerCase();
    const initialTemplateId = (editorShell.dataset.initialTemplateId || "").trim();
    const uiMode = String(editorShell.dataset.uiMode || "advanced").trim().toLowerCase() === "simple" ? "simple" : "advanced";
    const uploadDisabledMessage = "Bild-Upload ist für verschlüsselte Artikel deaktiviert.";

    const encryptionAvailable = !(encryptionToggle instanceof HTMLInputElement) || !encryptionToggle.disabled;

    let previewTimer = null;
    let previewAbortController = null;
    let currentView = "write";
    let selectedTemplateId = "";
    let selectedSecurityProfile = normalizeSecurityProfile(editorShell.dataset.securityProfile || "standard");

    const isUploadHardDisabled = () =>
      uploadForm instanceof HTMLFormElement && uploadForm.dataset.uploadHardDisabled === "1";

    const isEncryptedSelected = () =>
      encryptionToggle instanceof HTMLInputElement && encryptionToggle.checked;

    const setView = (nextView) => {
      const hasPreview = previewPanel instanceof HTMLElement;
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
      if (!(previewPanel instanceof HTMLElement)) return;

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
          previewPanel.textContent = "";
          const msg = document.createElement("p");
          msg.className = "muted-note";
          msg.textContent = data.error || "Vorschau konnte nicht geladen werden.";
          previewPanel.append(msg);
          return;
        }

        const wrapper = document.createElement("article");
        wrapper.className = "wiki-content";
        wrapper.innerHTML = String(data.html || "");
        previewPanel.textContent = "";
        previewPanel.append(wrapper);
      } catch (_error) {
        previewPanel.textContent = "";
        const msg = document.createElement("p");
        msg.className = "muted-note";
        msg.textContent = "Vorschau konnte nicht geladen werden.";
        previewPanel.append(msg);
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

    const setSecurityProfileNoteText = () => {
      const text =
        selectedSecurityProfile === "confidential"
          ? "Vertraulich: Zugriff nur ausgewählt und immer verschlüsselt. Tags werden entfernt und die Seite erscheint nicht in Live-Vorschlägen."
          : selectedSecurityProfile === "sensitive"
            ? uiMode === "simple"
              ? "Sensibel ist aktiv (Bestandsartikel). Im Einfach-Modus kannst du zu Standard oder Vertraulich wechseln."
              : "Sensibel: Zugriff nur ausgewählt und immer verschlüsselt. Metadaten bleiben in Suche/Listen sichtbar."
            : "Standard: freie Auswahl von Zugriff und Verschlüsselung.";
      for (const element of securityProfileNotes) {
        if (element instanceof HTMLElement) {
          element.textContent = text;
        }
      }
    };

    const renderSecurityProfileButtons = () => {
      for (const button of securityProfileButtons) {
        if (!(button instanceof HTMLButtonElement)) continue;
        const profile = normalizeSecurityProfile(button.dataset.securityProfile || "standard");
        button.classList.toggle("is-selected", profile === selectedSecurityProfile);
      }
    };

    const enforceProfileRules = () => {
      if (!(visibilitySelect instanceof HTMLSelectElement)) return;

      if (selectedSecurityProfile !== "standard") {
        visibilitySelect.value = "restricted";
      }

      if (encryptionToggle instanceof HTMLInputElement) {
        if (selectedSecurityProfile !== "standard") {
          encryptionToggle.checked = true;
          encryptionToggle.disabled = true;
        } else {
          encryptionToggle.disabled = !encryptionAvailable;
        }
      }

      if (securityProfileInput instanceof HTMLInputElement) {
        securityProfileInput.value = selectedSecurityProfile;
      }

      if (tagsInput instanceof HTMLInputElement) {
        const confidential = selectedSecurityProfile === "confidential";
        if (confidential) {
          tagsInput.value = "";
        }
        tagsInput.disabled = confidential;
      }
      if (tagsNote instanceof HTMLElement) {
        tagsNote.hidden = selectedSecurityProfile !== "confidential";
      }

      if (wizardVisibilitySelect instanceof HTMLSelectElement) {
        wizardVisibilitySelect.value = visibilitySelect.value;
      }

      setSecurityProfileNoteText();
      renderSecurityProfileButtons();
      syncRestrictedVisibility();
      syncUploadAvailability();
    };

    const applySecurityProfile = (nextProfile) => {
      const normalized = normalizeSecurityProfile(nextProfile);
      if (normalized !== "standard" && !encryptionAvailable) {
        selectedSecurityProfile = "standard";
      } else {
        selectedSecurityProfile = normalized;
      }
      enforceProfileRules();
      renderWizardStates();
    };

    const renderWizardStates = () => {
      if (!wizardRoot || !wizardStepElements) return;

      const step1Done =
        selectedTemplateId.length > 0 ||
        (titleInput instanceof HTMLInputElement && titleInput.value.trim().length > 0) ||
        contentTextarea.value.trim().length > 0;
      const step2Done =
        selectedSecurityProfile.length > 0 &&
        visibilitySelect instanceof HTMLSelectElement &&
        visibilitySelect.value.trim().length > 0;
      const step3Done =
        titleInput instanceof HTMLInputElement && titleInput.value.trim().length > 1 && contentTextarea.value.trim().length > 0;
      const firstOpenStep = !step1Done ? 1 : !step2Done ? 2 : 3;

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

    const templatePresets = loadTemplatePresets(editorShell);
    const templatePresetMap = new Map(templatePresets.map((preset) => [preset.id, preset]));
    const blankPreset =
      templatePresetMap.get("blank") || {
        id: "blank",
        defaultTitle: "",
        defaultTags: [],
        defaultContent: "",
        securityProfile: "standard"
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
      applySecurityProfile(preset.securityProfile || "standard");

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

    for (const button of securityProfileButtons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.addEventListener("click", () => {
        const profile = button.dataset.securityProfile || "standard";
        applySecurityProfile(profile);
      });
    }

    for (const button of wizardTemplateButtons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.addEventListener("click", () => {
        applyTemplatePreset(button.dataset.templateId || "blank");
      });
    }

    contentTextarea.addEventListener("input", schedulePreview);
    setView("write");

    for (const picker of accessPickers) {
      applyPickerFilter(picker);
      syncPickerCount(picker);

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

    if (visibilitySelect instanceof HTMLSelectElement) {
      visibilitySelect.addEventListener("change", () => {
        if (selectedSecurityProfile !== "standard" && visibilitySelect.value !== "restricted") {
          visibilitySelect.value = "restricted";
        }
        if (wizardVisibilitySelect instanceof HTMLSelectElement) {
          wizardVisibilitySelect.value = visibilitySelect.value;
        }
        syncRestrictedVisibility();
        renderWizardStates();
      });
    }

    if (wizardVisibilitySelect instanceof HTMLSelectElement && visibilitySelect instanceof HTMLSelectElement) {
      wizardVisibilitySelect.value = visibilitySelect.value;
      wizardVisibilitySelect.addEventListener("change", () => {
        visibilitySelect.value = wizardVisibilitySelect.value;
        visibilitySelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    if (encryptionToggle instanceof HTMLInputElement) {
      encryptionToggle.addEventListener("change", () => {
        if (selectedSecurityProfile !== "standard") {
          encryptionToggle.checked = true;
        }
        syncUploadAvailability();
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
          if (securityProfileInput instanceof HTMLInputElement && securityProfileInput.value.trim().length > 0) {
            params.set("securityProfile", normalizeSecurityProfile(securityProfileInput.value));
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

    syncSlugFromTitle();
    updateSlugAutoState();
    applySecurityProfile(selectedSecurityProfile);

    if (initialTemplateId) {
      applyTemplatePreset(initialTemplateId);
    } else {
      renderWizardStates();
    }

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
