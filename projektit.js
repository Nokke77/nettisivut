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
