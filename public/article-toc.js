(() => {
  "use strict";

  const tocRoot = document.querySelector(".article-toc");
  if (!(tocRoot instanceof HTMLElement)) return;

  const links = Array.from(tocRoot.querySelectorAll("a[href*='#']"))
    .map((entry) => (entry instanceof HTMLAnchorElement ? entry : null))
    .filter((entry) => entry !== null);

  if (links.length < 1) return;

  const entries = links
    .map((link) => {
      const href = link.getAttribute("href") || "";
      const hashIndex = href.indexOf("#");
      if (hashIndex < 0) return null;
      const rawId = href.slice(hashIndex + 1).trim();
      if (!rawId) return null;
      const id = decodeURIComponent(rawId);
      const heading = document.getElementById(id);
      if (!(heading instanceof HTMLElement)) return null;
      return { id, link, heading };
    })
    .filter((entry) => entry !== null);

  if (entries.length < 1) return;

  let activeId = "";
  let frameHandle = 0;
  const topOffset = 150;

  const setActive = (id) => {
    if (!id || id === activeId) return;
    activeId = id;

    for (const entry of entries) {
      const isActive = entry.id === id;
      entry.link.classList.toggle("is-active", isActive);
      if (isActive) {
        entry.link.setAttribute("aria-current", "location");
        entry.link.scrollIntoView({ block: "nearest", inline: "nearest" });
      } else {
        entry.link.removeAttribute("aria-current");
      }
    }
  };

  const computeActiveId = () => {
    const threshold = window.scrollY + topOffset;
    let current = entries[0]?.id || "";

    for (const entry of entries) {
      if (entry.heading.offsetTop <= threshold) {
        current = entry.id;
      } else {
        break;
      }
    }

    return current;
  };

  const syncActive = () => {
    frameHandle = 0;
    setActive(computeActiveId());
  };

  const scheduleSync = () => {
    if (frameHandle) return;
    frameHandle = window.requestAnimationFrame(syncActive);
  };

  for (const entry of entries) {
    entry.link.addEventListener("click", () => {
      setActive(entry.id);
      window.setTimeout(scheduleSync, 50);
    });
  }

  window.addEventListener("scroll", scheduleSync, { passive: true });
  window.addEventListener("resize", scheduleSync);
  window.addEventListener(
    "hashchange",
    () => {
      const hashId = decodeURIComponent((window.location.hash || "").replace(/^#/, ""));
      if (hashId) {
        setActive(hashId);
      }
      scheduleSync();
    },
    { passive: true }
  );
  window.addEventListener("load", scheduleSync, { once: true });

  const initialHashId = decodeURIComponent((window.location.hash || "").replace(/^#/, ""));
  if (initialHashId && entries.some((entry) => entry.id === initialHashId)) {
    setActive(initialHashId);
  } else {
    setActive(computeActiveId());
  }

  window.setTimeout(scheduleSync, 220);
})();
