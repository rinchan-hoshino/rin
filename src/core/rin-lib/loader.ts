import * as PiCodingAgent from "@earendil-works/pi-coding-agent";

import * as Changelog from "./changelog.js";

export async function loadRinCodingAgent() {
  return PiCodingAgent;
}

export async function loadRinSessionManagerModule() {
  return { SessionManager: PiCodingAgent.SessionManager };
}

export async function loadRinInteractiveModeModule() {
  return { InteractiveMode: PiCodingAgent.InteractiveMode };
}

export async function loadRinInteractiveFooterModule() {
  return { FooterComponent: PiCodingAgent.FooterComponent };
}

export async function loadRinInteractiveThemeModule() {
  return {
    theme: PiCodingAgent.Theme,
    initTheme: PiCodingAgent.initTheme,
  };
}

export async function loadRinSessionSelectorModule() {
  return { SessionSelectorComponent: PiCodingAgent.SessionSelectorComponent };
}

export async function loadRinChangelogModule() {
  return Changelog;
}

export function resolveRinCodingAgentDistDir() {
  return undefined;
}
