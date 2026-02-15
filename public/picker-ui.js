(() => {
  "use strict";

  const onReady = (callback) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  };

  const applyFilter = (picker) => {
    const labels = picker.list.querySelectorAll("label[data-search]");
    const term = picker.filter instanceof HTMLInputElement ? picker.filter.value.trim().toLowerCase() : "";
    for (const label of labels) {
      if (!(label instanceof HTMLElement)) continue;
      const haystack = (label.dataset.search || "").toLowerCase();
      label.hidden = term.length > 0 && !haystack.includes(term);
    }
  };

  const syncCount = (picker) => {
    if (!(picker.count instanceof HTMLElement)) return;
    const allCount = picker.list.querySelectorAll('input[type="checkbox"]').length;
    const selectedCount = picker.list.querySelectorAll('input[type="checkbox"]:checked').length;
    const visibleCount = picker.list.querySelectorAll("label[data-search]:not([hidden])").length;
    picker.count.textContent = `${selectedCount}/${allCount} ausgewählt, ${visibleCount} sichtbar`;
  };

  onReady(() => {
    const sections = Array.from(document.querySelectorAll(".access-user-picker"));
    for (const section of sections) {
      if (!(section instanceof HTMLElement)) continue;
      const list = section.querySelector("[data-picker-list]");
      if (!(list instanceof HTMLElement)) continue;

      const picker = {
        list,
        filter: section.querySelector("[data-picker-filter]"),
        count: section.querySelector("[data-picker-count]")
      };

      applyFilter(picker);
      syncCount(picker);

      if (picker.filter instanceof HTMLInputElement) {
        picker.filter.addEventListener("input", () => {
          applyFilter(picker);
          syncCount(picker);
        });
      }

      picker.list.addEventListener("change", (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.type === "checkbox") {
          syncCount(picker);
        }
      });
    }
  });
})();
