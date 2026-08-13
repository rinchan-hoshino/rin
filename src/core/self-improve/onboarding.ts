import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "../platform/fs.js";
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
  writeJsonAtomic(resolveInitStatePath(resolveAgentDir), next, 0o600, true);
}

export function buildOnboardingPrompt(
  mode: "auto" | "manual" = "manual",
  agentDir = path.join("~", ".rin"),
): string {
  const initiation =
    mode === "auto"
      ? "Rin detected that initialization is incomplete and started this initialization flow."
      : "The user explicitly requested Rin initialization.";
  const manualPath = path.join(
    agentDir,
    "docs",
    "rin",
    "docs",
    "initialization.md",
  );
  return [
    initiation,
    `Use ${manualPath} as the initialization contract for this flow.`,
  ].join("\n");
}

export function getOnboardingState(resolveAgentDir: () => string) {
  return readInitState(resolveAgentDir);
}

export async function prepareOnboardingStartup(
  resolveAgentDir: () => string,
  trigger = "tui_startup",
) {
  const current = readInitState(resolveAgentDir);
  if (current.initialized) {
    return { state: current, shouldStart: false };
  }
  const state = {
    ...current,
    version: 2,
    promptedAt: nowIso(),
    completedAt: "",
    lastTrigger: trigger,
    pending: false,
    initialized: true,
  };
  writeInitState(resolveAgentDir, state);
  return { state, shouldStart: true };
}
