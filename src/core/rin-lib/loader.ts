import * as PiAgentRuntime from "@earendil-works/pi-coding-agent";

import * as Changelog from "./changelog.js";
export { loadRinAgentRuntime } from "./agent-runtime.js";

export async function loadRinSessionManagerModule() {
  return { SessionManager: PiAgentRuntime.SessionManager };
}

export async function loadRinInteractiveModeModule() {
  return { InteractiveMode: PiAgentRuntime.InteractiveMode };
}

export async function loadRinInteractiveFooterModule() {
  return { FooterComponent: PiAgentRuntime.FooterComponent };
}

export async function loadRinInteractiveThemeModule() {
  return {
    theme: PiAgentRuntime.Theme,
    initTheme: PiAgentRuntime.initTheme,
  };
}

export async function loadRinSessionSelectorModule() {
  return {
    SessionSelectorComponent: PiAgentRuntime.SessionSelectorComponent,
  };
}

export async function loadRinChangelogModule() {
  return Changelog;
}
