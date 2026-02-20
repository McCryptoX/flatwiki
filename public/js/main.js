(() => {
  "use strict";

  const onReady =
    window.FW && typeof window.FW.onReady === "function"
      ? window.FW.onReady
      : (callback) => {
          if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", callback, { once: true });
            return;
          }
          callback();
        };

  const getErrorMessage = (payload) => {
    if (!payload || typeof payload !== "object") return "Watch-Status konnte nicht aktualisiert werden.";
    const error = payload.error;
    return typeof error === "string" && error.trim().length > 0 ? error.trim() : "Watch-Status konnte nicht aktualisiert werden.";
  };

  const setWatchUiState = ({ button, label, feedback, watching, message, isError }) => {
    button.classList.toggle("is-watching", watching);
    button.setAttribute("aria-pressed", watching ? "true" : "false");
    if (label) {
      label.textContent = watching ? "Beobachtet" : "Beobachten";
    }

    if (feedback) {
      feedback.textContent = message || "";
      feedback.classList.toggle("is-error", Boolean(isError));
    }
  };

  onReady(() => {
    const mobileToggle = document.querySelector("[data-mobile-menu-toggle]");
    const mobileClose = document.querySelector("[data-mobile-menu-close]");
    const mobileSidebar = document.querySelector("[data-mobile-sidebar]");
    const mobileOverlay = document.querySelector("[data-mobile-overlay]");

    if (
      mobileToggle instanceof HTMLButtonElement &&
      mobileSidebar instanceof HTMLElement &&
      mobileOverlay instanceof HTMLElement
    ) {
      const setMobileMenu = (open) => {
        mobileSidebar.classList.toggle("open", open);
        mobileOverlay.hidden = !open;
        mobileToggle.setAttribute("aria-expanded", open ? "true" : "false");
        mobileSidebar.setAttribute("aria-hidden", open ? "false" : "true");
        document.body.classList.toggle("mobile-menu-open", open);
      };

      mobileToggle.addEventListener("click", () => {
        setMobileMenu(!mobileSidebar.classList.contains("open"));
      });

      if (mobileClose instanceof HTMLButtonElement) {
        mobileClose.addEventListener("click", () => setMobileMenu(false));
      }

      mobileOverlay.addEventListener("click", () => setMobileMenu(false));
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && mobileSidebar.classList.contains("open")) {
          setMobileMenu(false);
        }
      });
      window.addEventListener("resize", () => {
        if (window.innerWidth > 768 && mobileSidebar.classList.contains("open")) {
          setMobileMenu(false);
        }
      });
    }

    const watchForms = document.querySelectorAll("form[data-watch-form]");
    if (watchForms.length < 1 || typeof window.fetch !== "function") {
      return;
    }

    for (const formElement of watchForms) {
      if (!(formElement instanceof HTMLFormElement)) continue;

      const button = formElement.querySelector("[data-watch-button]");
      if (!(button instanceof HTMLButtonElement)) continue;

      const label = formElement.querySelector("[data-watch-label]");
      const feedback = formElement.querySelector("[data-watch-feedback]");

      let pending = false;

      formElement.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (pending) return;

        pending = true;
        button.disabled = true;
        button.classList.add("is-pending");

        const formData = new FormData(formElement);
        const body = new URLSearchParams();
        for (const [key, value] of formData.entries()) {
          if (typeof value === "string") {
            body.append(key, value);
          }
        }

        body.set("mode", "toggle");

        if (feedback instanceof HTMLElement) {
          feedback.textContent = "Speichern...";
          feedback.classList.remove("is-error");
        }

        try {
          const response = await fetch(formElement.action, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "X-Requested-With": "XMLHttpRequest"
            },
            body,
            credentials: "same-origin"
          });

          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error(getErrorMessage(payload));
          }

          setWatchUiState({
            button,
            label: label instanceof HTMLElement ? label : null,
            feedback: feedback instanceof HTMLElement ? feedback : null,
            watching: Boolean(payload.watching),
            message: typeof payload.message === "string" ? payload.message : "",
            isError: false
          });
        } catch (error) {
          setWatchUiState({
            button,
            label: label instanceof HTMLElement ? label : null,
            feedback: feedback instanceof HTMLElement ? feedback : null,
            watching: button.getAttribute("aria-pressed") === "true",
            message: error instanceof Error ? error.message : "Watch-Status konnte nicht aktualisiert werden.",
            isError: true
          });
        } finally {
          pending = false;
          button.disabled = false;
          button.classList.remove("is-pending");
        }
      });
    }
  });
})();
