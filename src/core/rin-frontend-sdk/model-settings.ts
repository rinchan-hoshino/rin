import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { loadRinAgentRuntime } from "../rin-lib/agent-runtime.js";
import {
  applyRinSettingsDefaults,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { computeAvailableThinkingLevels } from "./session-helpers.js";

const RPC_MODE_VALUES = ["all", "one-at-a-time"] as const;
type RpcModeValue = (typeof RPC_MODE_VALUES)[number];
type RpcModeStateKey = "steeringMode" | "followUpMode";
const DEFAULT_RPC_MODE = "one-at-a-time";

let persistentSettingsManagerPromise: Promise<any> | null = null;

function setRpcTargetState(target: any, key: string, value: unknown) {
  target[key] = value;
  if (target?.state && typeof target.state === "object") {
    target.state[key] = value;
  }
}

function sendRpcClientMessage(target: any, payload: Record<string, unknown>) {
  void target?.client?.send?.(payload).catch(() => {});
}

function normalizeRpcMode(
  mode: string,
  fallback: RpcModeValue = DEFAULT_RPC_MODE,
): RpcModeValue {
  return RPC_MODE_VALUES.includes(mode as RpcModeValue)
    ? (mode as RpcModeValue)
    : fallback;
}

function resolveRpcThinkingLevel(target: any, level: ThinkingLevel) {
  const available = computeAvailableThinkingLevels(target?.model);
  return (
    available.find((item) => item === level) ??
    available[available.length - 1] ??
    target?.thinkingLevel ??
    "off"
  );
}

async function runRpcModelMutation(
  target: any,
  command: Record<string, unknown>,
  refreshModels: () => Promise<any>,
) {
  const data = await target.call(command.type, command);
  await refreshModels();
  return data ?? undefined;
}

export async function getPersistentSettingsManager() {
  if (!persistentSettingsManagerPromise) {
    persistentSettingsManagerPromise = (async () => {
      const agentRuntimeModule: any = await loadRinAgentRuntime();
      const SettingsManager = agentRuntimeModule?.SettingsManager;
      if (!SettingsManager?.create) {
        throw new Error("rin_missing_settings_manager");
      }
      const profile = resolveRuntimeProfile();
      const settings = SettingsManager.create(profile.cwd, profile.agentDir);
      applyRinSettingsDefaults(settings);
      return settings;
    })().catch((error) => {
      persistentSettingsManagerPromise = null;
      throw error;
    });
  }
  return await persistentSettingsManagerPromise;
}

export async function persistRpcSettingsMutation(
  mutate: (settings: any) => void | Promise<void>,
) {
  const settings = await getPersistentSettingsManager();
  await mutate(settings);
  await settings.flush?.();
}

export async function setRpcModel(
  target: any,
  model: any,
  refreshModels: () => Promise<any>,
) {
  await runRpcModelMutation(
    target,
    {
      type: "set_model",
      provider: model?.provider,
      modelId: model?.id,
    },
    refreshModels,
  );
}

export async function cycleRpcModel(
  target: any,
  _direction: "forward" | "backward" | undefined,
  refreshModels: () => Promise<any>,
) {
  return await runRpcModelMutation(
    target,
    { type: "cycle_model" },
    refreshModels,
  );
}

export function setRpcThinkingLevel(target: any, level: ThinkingLevel) {
  const next = resolveRpcThinkingLevel(target, level);
  setRpcTargetState(target, "thinkingLevel", next);
  sendRpcClientMessage(target, { type: "set_thinking_level", level: next });
}

export function cycleRpcThinkingLevel(target: any): ThinkingLevel | undefined {
  const levels = computeAvailableThinkingLevels(target.model);
  if (levels.length <= 1) return undefined;
  const next =
    levels[
      (Math.max(0, levels.indexOf(target.thinkingLevel)) + 1) % levels.length
    ];
  setRpcThinkingLevel(target, next);
  return next;
}

function setRpcModeOption(
  target: any,
  options: {
    mode: RpcModeValue;
    stateKey: RpcModeStateKey;
    fallback: RpcModeValue;
    settingsSetter: "setSteeringMode" | "setFollowUpMode";
    commandType: "set_steering_mode" | "set_follow_up_mode";
  },
) {
  const next = normalizeRpcMode(
    options.mode,
    normalizeRpcMode(target?.[options.stateKey], options.fallback),
  );
  setRpcTargetState(target, options.stateKey, next);
  target?.settingsManager?.[options.settingsSetter]?.(next);
  sendRpcClientMessage(target, { type: options.commandType, mode: next });
}

export function setRpcSteeringMode(target: any, mode: "all" | "one-at-a-time") {
  setRpcModeOption(target, {
    mode,
    stateKey: "steeringMode",
    fallback: "all",
    settingsSetter: "setSteeringMode",
    commandType: "set_steering_mode",
  });
}

export function setRpcFollowUpMode(target: any, mode: "all" | "one-at-a-time") {
  setRpcModeOption(target, {
    mode,
    stateKey: "followUpMode",
    fallback: DEFAULT_RPC_MODE,
    settingsSetter: "setFollowUpMode",
    commandType: "set_follow_up_mode",
  });
}

export function setRpcAutoCompaction(target: any, enabled: boolean) {
  setRpcTargetState(target, "autoCompactionEnabled", Boolean(enabled));
  sendRpcClientMessage(target, {
    type: "set_auto_compaction",
    enabled: Boolean(enabled),
  });
}
