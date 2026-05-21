import * as PiAgentRuntime from "@earendil-works/pi-coding-agent";

import * as Changelog from "./changelog.js";
import { createRinDefaultResourceLoader } from "./extension-loader.js";

let rinAgentRuntimeModule: any;

export async function loadPiAgentRuntime() {
  rinAgentRuntimeModule ??= {
    ...PiAgentRuntime,
    DefaultResourceLoader: createRinDefaultResourceLoader(PiAgentRuntime),
  };
  return rinAgentRuntimeModule;
}

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

export function resolvePiAgentRuntimeDistDir() {
  return undefined;
}
