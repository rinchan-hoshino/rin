export async function loadRinSessionManagerModule() {
  const { SessionManager } =
    await import("../../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js");
  return { SessionManager };
}

export async function loadRinInteractiveModeModule() {
  const { InteractiveMode } =
    await import("../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js");
  return { InteractiveMode };
}

export async function loadRinInteractiveFooterModule() {
  const { FooterComponent } =
    await import("../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js");
  return { FooterComponent };
}

export async function loadRinInteractiveThemeModule() {
  const { theme, initTheme } =
    await import("../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
  return { theme, initTheme };
}

export async function loadRinSessionSelectorModule() {
  const { SessionSelectorComponent } =
    await import("../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js");
  return {
    SessionSelectorComponent,
  };
}

export async function loadRinChangelogModule() {
  return await import("./changelog.js");
}
