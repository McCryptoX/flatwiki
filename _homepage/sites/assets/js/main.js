(() => {
  const copyButtons = Array.from(document.querySelectorAll(".quickstart-copy-btn[data-copy-target]"));
  const writeClipboard = async (text) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  };

  const showCopyFeedback = (button, ok) => {
    const wrapper = button.closest(".quickstart-code");
    const status = wrapper?.querySelector(".quickstart-status");
    if (!status) return;

    status.textContent = ok ? "Kopiert ✓" : "Kopieren fehlgeschlagen";
    if (ok) {
      window.setTimeout(() => {
        status.textContent = "";
      }, 2000);
    }
  };

  copyButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const targetId = button.getAttribute("data-copy-target");
      if (!targetId) return;
      const target = document.getElementById(targetId);
      const text = target?.innerText?.trim();
      if (!text) {
        showCopyFeedback(button, false);
        return;
      }

      const ok = await writeClipboard(text).catch(() => false);
      showCopyFeedback(button, ok);
    });
  });

  const navToggle = document.querySelector(".nav-toggle");
  const headerNav = document.querySelector("#primary-nav");
  if (navToggle && headerNav) {
    navToggle.addEventListener("click", () => {
      const isOpen = headerNav.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
    headerNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        headerNav.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  const revealNodes = Array.from(document.querySelectorAll("[data-reveal]"));
  if (revealNodes.length === 0) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion || !("IntersectionObserver" in window)) {
    revealNodes.forEach((node) => node.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.15, rootMargin: "0px 0px -32px 0px" }
  );

  revealNodes.forEach((node, index) => {
    const rect = node.getBoundingClientRect();
    const inInitialViewport = rect.top < window.innerHeight * 0.92;
    if (inInitialViewport) {
      node.classList.add("is-visible");
      return;
    }

    node.style.transitionDelay = `${Math.min(index, 5) * 40}ms`;
    observer.observe(node);
  });
})();
