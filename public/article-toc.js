(() => {
  "use strict";

  const MAX_RETRIES = 10;
  const RETRY_MS = 100;

  const article = document.querySelector(".article-page");
  if (!(article instanceof HTMLElement)) return;

  const slugify = (value) =>
    String(value || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section";

  const ensureHeadingIds = (headings) => {
    const used = new Set();
    for (const heading of headings) {
      const currentId = (heading.id || "").trim();
      if (currentId && !used.has(currentId)) {
        used.add(currentId);
        continue;
      }
      let base = slugify(heading.textContent || "");
      let next = base;
      let index = 2;
      while (used.has(next) || document.getElementById(next)) {
        next = `${base}-${index}`;
        index += 1;
      }
      heading.id = next;
      used.add(next);
    }
  };

  const ensureTocShell = () => {
    const main = article.querySelector(".article-main");
    if (!(main instanceof HTMLElement)) return null;

    let tocRoot = article.querySelector(".article-toc");
    if (!(tocRoot instanceof HTMLElement)) {
      tocRoot = document.createElement("aside");
      tocRoot.className = "article-toc";
      tocRoot.setAttribute("aria-label", "Inhaltsverzeichnis");
      article.insertBefore(tocRoot, main);
      article.classList.add("article-layout");
    }

    if (!tocRoot.querySelector(".toc-toggle")) {
      tocRoot.innerHTML = `<button type="button" class="toc-toggle" aria-expanded="false">Inhaltsverzeichnis</button><div class="toc-body"><h2>Inhaltsverzeichnis</h2><ul></ul></div>`;
    }

    const toggle = tocRoot.querySelector(".toc-toggle");
    if (toggle instanceof HTMLButtonElement && toggle.dataset.bound !== "1") {
      toggle.dataset.bound = "1";
      toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      });
    }

    return tocRoot;
  };

  const buildToc = () => {
    const content = article.querySelector(".wiki-content");
    if (!(content instanceof HTMLElement)) return null;

    const headings = Array.from(content.querySelectorAll("h2, h3")).filter((el) => el instanceof HTMLElement);
    if (headings.length < 2) return null;

    ensureHeadingIds(headings);
    const tocRoot = ensureTocShell();
    if (!(tocRoot instanceof HTMLElement)) return null;

    const list = tocRoot.querySelector("ul");
    if (!(list instanceof HTMLElement)) return null;

    list.innerHTML = headings
      .map((heading) => `<li class="depth-${heading.tagName.toLowerCase() === "h3" ? 3 : 2}"><a href="#${encodeURIComponent(heading.id)}">${heading.textContent || ""}</a></li>`)
      .join("");

    return { tocRoot, entries: Array.from(list.querySelectorAll("a[href^='#']")) };
  };

  const setupActiveState = (tocRoot, links) => {
    if (!Array.isArray(links) || links.length < 1) return;

    const entries = links
      .map((link) => {
        if (!(link instanceof HTMLAnchorElement)) return null;
        const id = decodeURIComponent((link.getAttribute("href") || "").replace(/^#/, ""));
        const heading = id ? document.getElementById(id) : null;
        if (!(heading instanceof HTMLElement)) return null;
        return { id, link, heading };
      })
      .filter((entry) => entry !== null);

    if (entries.length < 1) return;

    let activeId = "";
    let raf = 0;
    const topOffset = 132;

    const setActive = (id) => {
      if (!id || id === activeId) return;
      activeId = id;
      for (const entry of entries) {
        const active = entry.id === id;
        entry.link.classList.toggle("is-active", active);
        if (active) entry.link.setAttribute("aria-current", "location");
        else entry.link.removeAttribute("aria-current");
      }
    };

    const computeActive = () => {
      let current = entries[0].id;
      for (const entry of entries) {
        if (entry.heading.getBoundingClientRect().top <= topOffset) current = entry.id;
        else break;
      }
      return current;
    };

    const sync = () => {
      raf = 0;
      setActive(computeActive());
    };

    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(sync);
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule, { passive: true });
    schedule();
  };

  let attempt = 0;
  const init = () => {
    attempt += 1;
    const toc = buildToc();
    if (toc) {
      setupActiveState(toc.tocRoot, toc.entries);
      return;
    }
    if (attempt < MAX_RETRIES) {
      window.setTimeout(init, RETRY_MS);
    }
  };

  init();
})();
