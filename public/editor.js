"use strict";

const { onReady } = window.FW;

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

onReady(() => {
  const editorShell = document.querySelector(".editor-shell");
  if (!editorShell) return;

  const contentTextarea = editorShell.querySelector('[data-editor-textarea], textarea[name="content"]');
  const uploadForm = editorShell.querySelector(".image-upload-form");
  const output = editorShell.querySelector(".upload-markdown-output");
  const toolbarButtons = editorShell.querySelectorAll("[data-md-action]");
  const previewPanel = editorShell.querySelector(".editor-preview");
  const viewButtons = editorShell.querySelectorAll("[data-editor-view-btn]");

  if (!(contentTextarea instanceof HTMLTextAreaElement)) return;
  if (!(previewPanel instanceof HTMLElement)) return;

  const uploadEndpoint = uploadForm instanceof HTMLFormElement ? uploadForm.dataset.uploadEndpoint || "/api/uploads" : "/api/uploads";
  const csrfToken = editorShell.dataset.csrf || (uploadForm instanceof HTMLFormElement ? uploadForm.dataset.csrf || "" : "");
  const previewEndpoint = editorShell.dataset.previewEndpoint || "/api/markdown/preview";

  let previewTimer = null;
  let previewAbortController = null;
  let currentView = "write";

  const setView = (nextView) => {
    currentView = nextView === "preview" ? "preview" : "write";

    for (const button of viewButtons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      const mode = button.dataset.editorViewBtn || "write";
      button.classList.toggle("is-active", mode === currentView);
    }

    const previewMode = currentView === "preview";
    contentTextarea.hidden = previewMode;
    previewPanel.hidden = !previewMode;

    if (previewMode) {
      void refreshPreview();
    }
  };

  const refreshPreview = async () => {
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

  if (uploadForm instanceof HTMLFormElement && output instanceof HTMLTextAreaElement) {
    uploadForm.addEventListener("submit", async (event) => {
      event.preventDefault();

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
        const response = await fetch(uploadEndpoint, {
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
