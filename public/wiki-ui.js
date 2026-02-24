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
    const tagsChipInput = editorShell.querySelector("[data-tags-chip-input]");
    const tagsList = editorShell.querySelector("[data-tags-list]");
    const tagsNote = editorShell.querySelector("[data-tags-note]");
    const templateSelect = editorShell.querySelector("[data-template-select]");
    const editorForm = editorShell.querySelector(".editor-main-form");
    const submitButton = editorShell.querySelector("[data-submit-button]");
    const titleValidationMessage = editorShell.querySelector("[data-title-validation]");
    const uploadStatus = editorShell.querySelector("[data-upload-status]");
    const encryptionToggle = editorShell.querySelector('input[name="encrypted"][data-encrypted-toggle], input[name="encrypted"]');
    const encryptedForcedHidden = editorShell.querySelector("[data-encrypted-forced-hidden]");
    const visibilitySelect = editorShell.querySelector('select[name="visibility"]');
    const securityProfileInput = editorShell.querySelector('[data-security-profile-input]');
    const securityProfileSelect = editorShell.querySelector("[data-security-profile-select]");
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
    const uploadOpenButtons = Array.from(editorShell.querySelectorAll("[data-upload-open]")).filter(
      (entry) => entry instanceof HTMLButtonElement
    );
    const uploadFileInput = editorShell.querySelector("[data-upload-file-input]");
    const previewPanel = editorShell.querySelector(".editor-preview");
    const viewButtons = editorShell.querySelectorAll("[data-editor-view-btn]");

    const wizardRoot = editorShell.querySelector("[data-new-page-wizard]");
    const settingsShell = editorShell.querySelector(".settings-shell");
    const settingsTabButtons = Array.from(editorShell.querySelectorAll("[data-settings-tab-btn]")).filter(
      (entry) => entry instanceof HTMLButtonElement
    );
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
    const wizardVisibilityButtons = wizardRoot
      ? Array.from(wizardRoot.querySelectorAll("[data-wizard-visibility-set]")).filter((entry) => entry instanceof HTMLButtonElement)
      : [];
    const wizardEnabledToggle = editorShell.querySelector("[data-wizard-enabled]");
    const wizardCollapsible = wizardRoot instanceof HTMLElement ? wizardRoot.closest("[data-collapsible]") : null;
    const collapsibles = Array.from(editorShell.querySelectorAll("[data-collapsible]"))
      .map((root) => {
        if (!(root instanceof HTMLElement)) return null;
        const toggle = root.querySelector("[data-collapse-toggle]");
        const panel = root.querySelector("[data-collapse-panel]");
        if (!(toggle instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) return null;
        const initiallyOpen = (root.dataset.collapsibleOpen || "0") === "1";
        return { root, toggle, panel, initiallyOpen };
      })
      .filter((entry) => entry !== null);
    const settingsCollapsibles = collapsibles.filter(
      (entry) => entry.root instanceof HTMLElement && (entry.root.dataset.settingsSection || "").trim().length > 0
    );

    if (!(contentTextarea instanceof HTMLTextAreaElement)) return;

    const uploadEndpoint = "/api/uploads";
    const csrfToken = editorShell.dataset.csrf || "";
    const previewEndpoint = editorShell.dataset.previewEndpoint || "/api/markdown/preview";
    const pageSlug = (editorShell.dataset.pageSlug || "").trim().toLowerCase();
    const initialTemplateId = (editorShell.dataset.initialTemplateId || "").trim();
    const uiMode = String(editorShell.dataset.uiMode || "advanced").trim().toLowerCase() === "simple" ? "simple" : "advanced";
    const uploadDisabledMessage = "Bild-Upload ist derzeit nicht verfügbar.";

    const encryptionAvailable = !(encryptionToggle instanceof HTMLInputElement) || !encryptionToggle.disabled;

    // Single source of truth: quick assistant only writes into the same inputs used by manual settings.
    let previewTimer = null;
    let previewAbortController = null;
    let currentView = "write";
    let selectedTemplateId = "";
    let selectedSecurityProfile = normalizeSecurityProfile(editorShell.dataset.securityProfile || "standard");
    let tagValues = [];
    let wizardAutoCollapsed = false;
    let titleTouched = false;

    const normalizeTagValue = (value) =>
      String(value || "")
        .trim()
        .replace(/^,+|,+$/g, "")
        .replace(/\s+/g, " ");

    const parseTagCsv = (value) => {
      const seen = new Set();
      return String(value || "")
        .split(",")
        .map((tag) => normalizeTagValue(tag))
        .filter((tag) => {
          if (tag.length < 1) return false;
          const key = tag.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };

    const syncHiddenTagsValue = () => {
      if (!(tagsInput instanceof HTMLInputElement)) return;
      tagsInput.value = tagValues.join(", ");
    };

    const renderTagChips = () => {
      if (!(tagsList instanceof HTMLElement)) return;
      tagsList.textContent = "";

      tagValues.forEach((tag, index) => {
        const chip = document.createElement("span");
        chip.className = "editor-tag-pill";

        const text = document.createElement("span");
        text.textContent = tag;
        chip.append(text);

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.dataset.tagRemove = String(index);
        removeButton.setAttribute("aria-label", `Tag ${tag} entfernen`);
        removeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18 18 6M6 6l12 12"/></svg>';
        chip.append(removeButton);

        tagsList.append(chip);
      });
    };

    const addTagValue = (value) => {
      const normalized = normalizeTagValue(value);
      if (normalized.length < 1) return false;
      if (tagValues.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) return false;
      tagValues.push(normalized);
      syncHiddenTagsValue();
      renderTagChips();
      return true;
    };

    const removeTagValueAt = (index) => {
      if (index < 0 || index >= tagValues.length) return;
      tagValues.splice(index, 1);
      syncHiddenTagsValue();
      renderTagChips();
    };

    const syncTagStateFromHiddenInput = () => {
      if (!(tagsInput instanceof HTMLInputElement)) return;
      tagValues = parseTagCsv(tagsInput.value);
      syncHiddenTagsValue();
      renderTagChips();
    };

    const setCollapsibleState = (entry, isOpen) => {
      entry.root.dataset.collapsibleOpen = isOpen ? "1" : "0";
      entry.toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      entry.panel.hidden = !isOpen;
      entry.root.classList.toggle("is-open", isOpen);
    };

    const isCompactSettingsLayout = () => window.matchMedia("(max-width: 900px)").matches;

    const setActiveSettingsSection = (sectionId) => {
      const normalized = String(sectionId || "").trim();
      if (!normalized) return;
      if (settingsShell instanceof HTMLElement) {
        settingsShell.dataset.settingsActive = normalized;
      }

      for (const button of settingsTabButtons) {
        if (!(button instanceof HTMLButtonElement)) continue;
        const selected = (button.dataset.settingsTabBtn || "") === normalized;
        button.setAttribute("aria-selected", selected ? "true" : "false");
      }

      if (isCompactSettingsLayout()) {
        return;
      }

      for (const entry of settingsCollapsibles) {
        const isTarget = (entry.root.dataset.settingsSection || "") === normalized;
        setCollapsibleState(entry, isTarget);
      }
    };

    for (const entry of collapsibles) {
      setCollapsibleState(entry, entry.initiallyOpen);
      entry.toggle.addEventListener("click", () => {
        const sectionId = (entry.root.dataset.settingsSection || "").trim();
        if (!isCompactSettingsLayout() && sectionId.length > 0) {
          setActiveSettingsSection(sectionId);
          return;
        }
        const nextOpen = entry.toggle.getAttribute("aria-expanded") !== "true";
        setCollapsibleState(entry, nextOpen);
      });
    }

    for (const button of settingsTabButtons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.addEventListener("click", () => {
        const target = String(button.dataset.settingsTabBtn || "").trim();
        setActiveSettingsSection(target);
      });
    }

    if (!isCompactSettingsLayout()) {
      const initialSection =
        settingsShell instanceof HTMLElement ? String(settingsShell.dataset.settingsActive || "").trim() : "";
      if (initialSection.length > 0) {
        setActiveSettingsSection(initialSection);
      }
    }

    const isUploadHardDisabled = () =>
      uploadFileInput instanceof HTMLInputElement && uploadFileInput.dataset.uploadHardDisabled === "1";

    const isEncryptedSelected = () =>
      encryptionToggle instanceof HTMLInputElement && encryptionToggle.checked;

    const syncSubmitAvailability = () => {
      if (!(titleInput instanceof HTMLInputElement)) return;
      const titleValid = titleInput.value.trim().length >= 2;
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = !titleValid;
        submitButton.setAttribute("aria-disabled", titleValid ? "false" : "true");
      }
      if (titleValidationMessage instanceof HTMLElement) {
        titleValidationMessage.hidden = titleValid || !titleTouched;
      }
    };

    const setWizardEnabledState = (enabled) => {
      if (!(wizardRoot instanceof HTMLElement)) return;
      wizardRoot.hidden = !enabled;
      if (wizardEnabledToggle instanceof HTMLInputElement) {
        wizardEnabledToggle.checked = enabled;
      }
      if (wizardCollapsible instanceof HTMLElement) {
        const wizardEntry = collapsibles.find((entry) => entry.root === wizardCollapsible);
        if (wizardEntry) {
          if (enabled) {
            const sectionId = (wizardEntry.root.dataset.settingsSection || "").trim();
            if (!isCompactSettingsLayout() && sectionId.length > 0) {
              setActiveSettingsSection(sectionId);
            } else {
              setCollapsibleState(wizardEntry, true);
            }
          } else {
            setCollapsibleState(wizardEntry, false);
          }
        }
      }
    };

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
      const shouldDisable = isUploadHardDisabled();
      if (uploadFileInput instanceof HTMLInputElement) {
        uploadFileInput.disabled = shouldDisable;
      }
      if (uploadOpenButton instanceof HTMLButtonElement) {
        uploadOpenButton.disabled = shouldDisable;
      }
      if (shouldDisable) {
        setUploadStatus(uploadDisabledMessage, true);
      } else if (
        uploadStatus instanceof HTMLElement &&
        (uploadStatus.textContent || "").trim() === uploadDisabledMessage
      ) {
        setUploadStatus("");
      }
    };

    const setSecurityProfileNoteText = () => {
      const text =
        selectedSecurityProfile === "standard"
          ? "Freie Auswahl von Zugriff und Verschlüsselung."
          : "Für dieses Sicherheitsprofil ist Verschlüsselung zwingend aktiv.";
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
          encryptionToggle.setAttribute("aria-disabled", "true");
        } else {
          encryptionToggle.disabled = !encryptionAvailable;
          encryptionToggle.setAttribute("aria-disabled", encryptionToggle.disabled ? "true" : "false");
        }
      }
      if (encryptedForcedHidden instanceof HTMLInputElement) {
        const forced = selectedSecurityProfile !== "standard";
        encryptedForcedHidden.disabled = !forced;
      }

      if (securityProfileInput instanceof HTMLInputElement) {
        securityProfileInput.value = selectedSecurityProfile;
      }
      if (securityProfileSelect instanceof HTMLSelectElement) {
        securityProfileSelect.value = selectedSecurityProfile;
      }

      if (tagsInput instanceof HTMLInputElement) {
        const confidential = selectedSecurityProfile === "confidential";
        if (confidential) {
          tagValues = [];
          syncHiddenTagsValue();
          renderTagChips();
        }
        tagsInput.disabled = confidential;
        if (tagsChipInput instanceof HTMLInputElement) {
          tagsChipInput.disabled = confidential;
          if (confidential) {
            tagsChipInput.value = "";
          }
        }
      }
      if (tagsNote instanceof HTMLElement) {
        tagsNote.hidden = selectedSecurityProfile !== "confidential";
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
      if (wizardRoot.hidden) return;

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

      if (step3Done && !wizardAutoCollapsed && wizardCollapsible instanceof HTMLElement) {
        const wizardEntry = collapsibles.find((entry) => entry.root === wizardCollapsible);
        if (wizardEntry) {
          const wizardSectionId = String(wizardEntry.root.dataset.settingsSection || "").trim();
          if (wizardSectionId.length > 0 && !isCompactSettingsLayout()) {
            setActiveSettingsSection("access");
          } else {
            setCollapsibleState(wizardEntry, false);
          }
          wizardAutoCollapsed = true;
        }
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
      syncTagStateFromHiddenInput();
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
      if (templateSelect instanceof HTMLSelectElement) {
        templateSelect.value = resolvedTemplateId;
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

    if (tagsList instanceof HTMLElement) {
      tagsList.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest("button[data-tag-remove]");
        if (!(button instanceof HTMLButtonElement)) return;
        const index = Number.parseInt(button.dataset.tagRemove || "", 10);
        if (!Number.isFinite(index)) return;
        removeTagValueAt(index);
        if (tagsChipInput instanceof HTMLInputElement && !tagsChipInput.disabled) {
          tagsChipInput.focus();
        }
      });
    }

    if (tagsChipInput instanceof HTMLInputElement) {
      tagsChipInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          const added = addTagValue(tagsChipInput.value);
          if (added) {
            tagsChipInput.value = "";
          }
          return;
        }
        if (event.key === "Backspace" && tagsChipInput.value.length < 1 && tagValues.length > 0) {
          event.preventDefault();
          removeTagValueAt(tagValues.length - 1);
        }
      });

      tagsChipInput.addEventListener("blur", () => {
        const added = addTagValue(tagsChipInput.value);
        if (added) {
          tagsChipInput.value = "";
        }
      });
    }

    const setUploadStatus = (message, isError = false) => {
      if (!(uploadStatus instanceof HTMLElement)) return;
      uploadStatus.hidden = !message;
      uploadStatus.textContent = message || "";
      uploadStatus.classList.toggle("upload-status-error", Boolean(isError && message));
    };

    const performUpload = async (files) => {
      if (!files || files.length === 0) return;
      if (isUploadHardDisabled()) {
        setUploadStatus(uploadDisabledMessage, true);
        return;
      }

      const formData = new FormData();
      for (const file of files) {
        formData.append("images", file, file.name);
      }

      setUploadStatus("Upload läuft...");

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
        const currentSlug =
          slugInput instanceof HTMLInputElement
            ? String(slugInput.value || "").trim().toLowerCase()
            : pageSlug;
        if (currentSlug.length > 0) {
          params.set("slug", currentSlug);
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
          setUploadStatus(data.error || "Upload fehlgeschlagen.", true);
          return;
        }

        const markdown = String(data.markdown || "").trim();
        appendMarkdown(contentTextarea, markdown);
        setUploadStatus(markdown ? "Bild eingefügt." : "Upload abgeschlossen.");
      } catch (_error) {
        setUploadStatus("Upload fehlgeschlagen. Bitte erneut versuchen.", true);
      }
    };

    if (uploadOpenButtons.length > 0 && uploadFileInput instanceof HTMLInputElement) {
      for (const button of uploadOpenButtons) {
        if (!(button instanceof HTMLButtonElement)) continue;
        button.addEventListener("click", () => {
          uploadFileInput.click();
        });
      }

      uploadFileInput.addEventListener("change", async () => {
        const files = uploadFileInput.files;
        await performUpload(files);
        uploadFileInput.value = "";
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

    if (securityProfileSelect instanceof HTMLSelectElement) {
      securityProfileSelect.addEventListener("change", () => {
        applySecurityProfile(securityProfileSelect.value);
      });
    }

    for (const button of wizardTemplateButtons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.addEventListener("click", () => {
        applyTemplatePreset(button.dataset.templateId || "blank");
        contentTextarea.focus();
      });
    }

    if (templateSelect instanceof HTMLSelectElement) {
      templateSelect.addEventListener("change", () => {
        applyTemplatePreset(templateSelect.value || "blank");
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
        syncRestrictedVisibility();
        renderWizardStates();
      });
    }
    for (const button of wizardVisibilityButtons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.addEventListener("click", () => {
        if (!(visibilitySelect instanceof HTMLSelectElement)) return;
        const next = String(button.dataset.wizardVisibilitySet || "").trim();
        if (next !== "all" && next !== "restricted") return;
        visibilitySelect.value = next;
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
        titleTouched = true;
        syncSlugFromTitle();
        syncSubmitAvailability();
        renderWizardStates();
      });
      titleInput.addEventListener("blur", () => {
        titleTouched = true;
        syncSubmitAvailability();
      });
    }

    if (editorForm instanceof HTMLFormElement) {
      editorForm.addEventListener("submit", (event) => {
        if (!(titleInput instanceof HTMLInputElement)) return;
        if (titleInput.value.trim().length >= 2) return;
        titleTouched = true;
        syncSubmitAvailability();
        titleInput.focus();
        event.preventDefault();
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

    setUploadStatus("");

    syncSlugFromTitle();
    updateSlugAutoState();
    syncTagStateFromHiddenInput();
    applySecurityProfile(selectedSecurityProfile);
    syncSubmitAvailability();

    if (wizardEnabledToggle instanceof HTMLInputElement) {
      setWizardEnabledState(wizardEnabledToggle.checked);
      wizardEnabledToggle.addEventListener("change", () => {
        setWizardEnabledState(wizardEnabledToggle.checked);
      });
    }

    if (initialTemplateId) {
      applyTemplatePreset(initialTemplateId);
    } else if (templateSelect instanceof HTMLSelectElement && templateSelect.value.trim().length > 0) {
      selectedTemplateId = templateSelect.value.trim();
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
