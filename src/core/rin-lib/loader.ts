async function loadModule(specifier: string) {
  return await import(specifier);
}

export async function loadRinSessionManagerModule() {
  const { SessionManager } = await loadModule(
    "@earendil-works/pi-coding-agent",
  );
  return { SessionManager };
}

export async function loadRinInteractiveModeModule() {
  const { InteractiveMode } = await loadModule(
    "@earendil-works/pi-coding-agent",
  );
  return { InteractiveMode };
}

export async function loadRinInteractiveFooterModule() {
  const { FooterComponent } = await loadModule(
    "@earendil-works/pi-coding-agent",
  );
  return { FooterComponent };
}

export async function loadRinInteractiveThemeModule() {
  const { theme, initTheme } = await loadModule("../pi/private-api.js");
  return { theme, initTheme };
}

export async function loadRinSessionSelectorModule() {
  const { SessionSelectorComponent } = await loadModule(
    "@earendil-works/pi-coding-agent",
  );
  return {
    SessionSelectorComponent,
  };
}

export async function loadRinChangelogModule() {
  return await loadModule("./changelog.js");
}
