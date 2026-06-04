import fs from "node:fs";
import path from "node:path";

import { nowIso } from "./core/utils.js";
import { initStatePath } from "./paths.js";

const REQUIRED_INIT_SLOTS = ["agent_profile", "user_profile"];
const OPTIONAL_INIT_SLOTS = ["core_doctrine"];

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
    };
  } catch {
    return {
      version: 2,
      promptedAt: "",
      completedAt: "",
      lastTrigger: "",
      pending: false,
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

export async function getOnboardingStatus(
  resolveAgentDir: () => string,
  loadSelfImproveStore: () => Promise<any>,
) {
  const service = await loadSelfImproveStore();
  const docs = await service.loadActiveSelfImproveDocs(resolveAgentDir());
  const missing = REQUIRED_INIT_SLOTS.concat(OPTIONAL_INIT_SLOTS).filter(
    (slot, index, all) =>
      all.indexOf(slot) === index &&
      !docs.some(
        (doc: any) =>
          doc?.exposure === "self_improve_prompts" &&
          doc?.self_improve_prompt_slot === slot,
      ),
  );
  const requiredMissing = REQUIRED_INIT_SLOTS.filter((slot) =>
    missing.includes(slot),
  );
  const optionalMissing = OPTIONAL_INIT_SLOTS.filter((slot) =>
    missing.includes(slot),
  );
  const state = readInitState(resolveAgentDir);
  const complete = requiredMissing.length === 0;
  return { state, requiredMissing, optionalMissing, complete };
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
  };
  writeInitState(resolveAgentDir, next);
  return next;
}

export async function refreshOnboardingCompletion(
  resolveAgentDir: () => string,
  loadSelfImproveStore: () => Promise<any>,
) {
  const status = await getOnboardingStatus(
    resolveAgentDir,
    loadSelfImproveStore,
  );
  if (status.complete) {
    const next = {
      ...status.state,
      version: 2,
      completedAt: nowIso(),
      pending: false,
    };
    writeInitState(resolveAgentDir, next);
    return { ...status, state: next, complete: true };
  }
  return status;
}
