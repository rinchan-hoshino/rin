import fs from "node:fs";
import path from "node:path";

import { nowIso } from "./core/utils.js";
import { initStatePath } from "./paths.js";

function resolveInitStatePath(resolveAgentDir: () => string) {
  return initStatePath(resolveAgentDir());
}

function readInitState(resolveAgentDir: () => string) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(resolveInitStatePath(resolveAgentDir), "utf8"),
    ) as Record<string, any>;
    return {
      version: 2,
      promptedAt: "",
      completedAt: "",
      lastTrigger: "",
      pending: false,
      ...parsed,
      initialized: Boolean(parsed?.initialized || parsed?.completedAt),
    };
  } catch {
    return {
      version: 2,
      promptedAt: "",
      completedAt: "",
      lastTrigger: "",
      pending: false,
      initialized: false,
    };
  }
}

function writeInitState(
  resolveAgentDir: () => string,
  next: Record<string, any>,
) {
  fs.mkdirSync(path.dirname(resolveInitStatePath(resolveAgentDir)), {
    recursive: true,
  });
  fs.writeFileSync(
    resolveInitStatePath(resolveAgentDir),
    JSON.stringify(next, null, 2),
    "utf8",
  );
}

export function buildOnboardingPrompt(
  _mode: "auto" | "manual" = "manual",
): string {
  return [
    "The user is requesting Rin initialization.",
    "Use `~/.rin/docs/rin/docs/initialization.md` as the initialization contract for this flow.",
    "The initialization completed state is false; follow the initialization document through its completion-state update step.",
  ].join("\n");
}

export function getOnboardingState(resolveAgentDir: () => string) {
  return readInitState(resolveAgentDir);
}

export function isOnboardingActive(
  resolveAgentDir: () => string,
  state = readInitState(resolveAgentDir),
) {
  return Boolean(state?.pending);
}

export function setOnboardingInitialized(
  resolveAgentDir: () => string,
  initialized: boolean,
  trigger: string,
) {
  const state = readInitState(resolveAgentDir);
  const next = {
    ...state,
    version: 2,
    completedAt: initialized ? state.completedAt || nowIso() : "",
    lastTrigger: trigger,
    pending: false,
    initialized,
  };
  writeInitState(resolveAgentDir, next);
  return next;
}

export async function markOnboardingPrompted(
  resolveAgentDir: () => string,
  trigger: string,
) {
  const state = readInitState(resolveAgentDir);
  const next = {
    ...state,
    version: 2,
    promptedAt: nowIso(),
    completedAt: "",
    lastTrigger: trigger,
    pending: true,
    initialized: false,
  };
  writeInitState(resolveAgentDir, next);
  return next;
}

export async function prepareOnboardingStartup(
  resolveAgentDir: () => string,
  trigger = "tui_startup",
) {
  const current = readInitState(resolveAgentDir);
  if (current.initialized) {
    return { state: current, shouldStart: false, complete: true };
  }
  const state = await markOnboardingPrompted(resolveAgentDir, trigger);
  return {
    state,
    shouldStart: true,
    complete: false,
  };
}
