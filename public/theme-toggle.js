(function () {
  "use strict";

  function getEffective() {
    var s = localStorage.getItem("fw-theme");
    if (s === "dark" || s === "light") return s;
    return matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light";
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("fw-theme", theme);
    updateIcons();
  }

  function updateIcons() {
    var isDark = document.documentElement.getAttribute("data-theme") === "dark";
    var icons = document.querySelectorAll(".theme-toggle-icon");
    for (var i = 0; i < icons.length; i++) {
      icons[i].textContent = isDark ? "\u2600\uFE0F" : "\uD83C\uDF19";
    }
  }

  // Persist theme server-side for logged-in users.
  // Reads CSRF token from the logout form (always present when user is logged in).
  function persistThemeToServer(theme) {
    var csrfInput = document.querySelector('input[name="_csrf"]');
    if (!csrfInput) return; // guest — no CSRF token available, skip
    var csrf = csrfInput.value;
    if (!csrf) return;

    fetch("/api/user/theme", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf
      },
      body: JSON.stringify({ theme: theme }),
      credentials: "same-origin"
    }).catch(function () {
      // Non-critical: ignore network errors; localStorage already updated
    });
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    var next = getEffective() === "dark" ? "light" : "dark";
    apply(next);
    persistThemeToServer(next);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateIcons);
  } else {
    updateIcons();
  }

  matchMedia("(prefers-color-scheme:dark)").addEventListener("change", function () {
    if (!localStorage.getItem("fw-theme")) {
      document.documentElement.setAttribute(
        "data-theme",
        matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light"
      );
      updateIcons();
    }
  });
})();
