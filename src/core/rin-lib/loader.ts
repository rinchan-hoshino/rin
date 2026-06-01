export async function loadRinSessionManagerModule() {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  return { SessionManager };
}

export async function loadRinInteractiveModeModule() {
  const { InteractiveMode } = await import("@earendil-works/pi-coding-agent");
  return { InteractiveMode };
}

export async function loadRinInteractiveFooterModule() {
  const { FooterComponent } = await import("@earendil-works/pi-coding-agent");
  return { FooterComponent };
}

export async function loadRinInteractiveThemeModule() {
  const { theme, initTheme } = await import("../pi/private-api.js");
  return { theme, initTheme };
}

export async function loadRinSessionSelectorModule() {
  const { SessionSelectorComponent } =
    await import("@earendil-works/pi-coding-agent");
  return {
    SessionSelectorComponent,
  };
}

export async function loadRinChangelogModule() {
  return await import("./changelog.js");
}
