import path from "node:path";

import { resolveAgentDir } from "./agent-dir.js";

export const SELF_IMPROVE_DIR = "self_improve";
export const SELF_IMPROVE_PROMPTS_DIR = "prompts";
export const SELF_IMPROVE_SKILLS_DIR = "skills";
export const SELF_IMPROVE_STATE_DIR = "state";
export const INIT_STATE_FILE = "init-state.json";
export const MAINTENANCE_QUEUE_FILE = "maintenance-queue.json";
export const MAINTENANCE_HISTORY_FILE = "maintenance-history.jsonl";
export const MAINTENANCE_LOCK_FILE = "maintenance-worker.lock";

function resolveSelfImprovePath(agentDirOverride = "", ...segments: string[]) {
  return path.join(
    resolveAgentDir(agentDirOverride),
    SELF_IMPROVE_DIR,
    ...segments,
  );
}

function resolveSelfImproveStatePath(agentDirOverride = "", fileName = "") {
  return resolveSelfImprovePath(
    agentDirOverride,
    SELF_IMPROVE_STATE_DIR,
    fileName,
  );
}

export function resolveSelfImproveRoot(agentDirOverride = ""): string {
  return resolveSelfImprovePath(agentDirOverride);
}

export function selfImprovePromptsDir(agentDirOverride = ""): string {
  return resolveSelfImprovePath(agentDirOverride, SELF_IMPROVE_PROMPTS_DIR);
}

export function selfImproveSkillsDir(agentDirOverride = ""): string {
  return resolveSelfImprovePath(agentDirOverride, SELF_IMPROVE_SKILLS_DIR);
}

export function selfImproveStateDir(agentDirOverride = ""): string {
  return resolveSelfImprovePath(agentDirOverride, SELF_IMPROVE_STATE_DIR);
}

export function initStatePath(agentDirOverride = ""): string {
  return resolveSelfImproveStatePath(agentDirOverride, INIT_STATE_FILE);
}

export function maintenanceQueuePath(agentDirOverride = ""): string {
  return resolveSelfImproveStatePath(agentDirOverride, MAINTENANCE_QUEUE_FILE);
}

export function maintenanceHistoryPath(agentDirOverride = ""): string {
  return resolveSelfImproveStatePath(
    agentDirOverride,
    MAINTENANCE_HISTORY_FILE,
  );
}

export function maintenanceLockPath(agentDirOverride = ""): string {
  return resolveSelfImproveStatePath(agentDirOverride, MAINTENANCE_LOCK_FILE);
}
