for (const switcher of document.querySelectorAll("[data-project-versions]")) {
  const project = switcher.closest(".project-card");
  const buttons = [...switcher.querySelectorAll("[data-version]")];
  const panels = [...project.querySelectorAll("[data-version-panel]")];

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const selected = button.dataset.version;
      for (const item of buttons) {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      }
      for (const panel of panels) {
        panel.hidden = panel.dataset.versionPanel !== selected;
      }
    });
  }
}

const projectTrack = document.querySelector("[data-project-track]");
if (projectTrack) {
  const items = [...projectTrack.querySelectorAll(".project-browser-item")];
  const previous = document.querySelector("[data-project-prev]");
  const next = document.querySelector("[data-project-next]");
  const position = document.querySelector("[data-project-position]");
  let current = 0;

  function updateProjectPosition() {
    const maxScroll = Math.max(0, projectTrack.scrollWidth - projectTrack.clientWidth);
    current = maxScroll > 0
      ? Math.round((projectTrack.scrollLeft / maxScroll) * (items.length - 1))
      : 0;
    position.textContent = `${String(current + 1).padStart(2, "0")} / ${String(items.length).padStart(2, "0")}`;
    previous.disabled = current === 0;
    next.disabled = current >= items.length - 1 || maxScroll === 0;
  }

  function scrollToProject(index) {
    const maxScroll = Math.max(0, projectTrack.scrollWidth - projectTrack.clientWidth);
    const target = Math.max(0, Math.min(items.length - 1, index));
    projectTrack.scrollLeft = maxScroll * target / Math.max(1, items.length - 1);
    updateProjectPosition();
  }

  previous.addEventListener("click", () => scrollToProject(current - 1));
  next.addEventListener("click", () => scrollToProject(current + 1));
  projectTrack.addEventListener("scroll", updateProjectPosition, { passive: true });
  window.addEventListener("resize", updateProjectPosition);
  updateProjectPosition();
}
