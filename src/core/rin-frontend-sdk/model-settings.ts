import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { resolveRuntimeProfile } from "../rin-lib/profile.js";
import { computeAvailableThinkingLevels } from "../session/helpers.js";

const RPC_MODE_VALUES = ["all", "one-at-a-time"] as const;
type RpcModeValue = (typeof RPC_MODE_VALUES)[number];
type RpcModeStateKey = "steeringMode" | "followUpMode";
const DEFAULT_RPC_MODE = "one-at-a-time";

let persistentSettingsManagerPromise: Promise<any> | null = null;
const rpcSettingsMutationQueues = new WeakMap<
  object,
  Map<string, Promise<unknown>>
>();

function setRpcTargetState(target: any, key: string, value: unknown) {
  target[key] = value;
  if (target?.state && typeof target.state === "object") {
    target.state[key] = value;
  }
}

async function callRpcSettingsMutation(
  target: any,
  command: Record<string, unknown> & { type: string },
) {
  return target.callRpcSettingsMutation
    ? await target.callRpcSettingsMutation(command)
    : await target.call(command.type, command);
}

async function enqueueRpcSettingsMutation<T>(
  target: object,
  key: string,
  mutate: () => Promise<T>,
): Promise<T> {
  let queues = rpcSettingsMutationQueues.get(target);
  if (!queues) {
    queues = new Map();
    rpcSettingsMutationQueues.set(target, queues);
  }
  const previous = queues.get(key) ?? Promise.resolve();
  const ready = previous.then(
    () => undefined,
    () => undefined,
  );
  const current = ready.then(mutate);
  queues.set(key, current);
  try {
    return await current;
  } finally {
    if (queues.get(key) === current) queues.delete(key);
    if (queues.size === 0) rpcSettingsMutationQueues.delete(target);
  }
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
      const [{ loadRinAgentRuntime }, { applyRinSettingsDefaults }] =
        await Promise.all([
          import("../rin-lib/agent-runtime.js"),
          import("../rin-lib/runtime.js"),
        ]);
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

async function applyRpcThinkingLevel(
  target: any,
  resolveNext: () => ThinkingLevel | undefined,
): Promise<ThinkingLevel | undefined> {
  return await enqueueRpcSettingsMutation(target, "thinkingLevel", async () => {
    const next = resolveNext();
    if (next === undefined) return undefined;
    await callRpcSettingsMutation(target, {
      type: "set_thinking_level",
      level: next,
    });
    setRpcTargetState(target, "thinkingLevel", next);
    target.emitEvent?.({ type: "thinking_level_changed", level: next });
    return next;
  });
}

export async function setRpcThinkingLevel(
  target: any,
  level: ThinkingLevel,
): Promise<ThinkingLevel> {
  return (await applyRpcThinkingLevel(target, () =>
    resolveRpcThinkingLevel(target, level),
  ))!;
}

export async function cycleRpcThinkingLevel(
  target: any,
): Promise<ThinkingLevel | undefined> {
  return await applyRpcThinkingLevel(target, () => {
    const levels = computeAvailableThinkingLevels(target.model);
    if (levels.length <= 1) return undefined;
    return levels[
      (Math.max(0, levels.indexOf(target.thinkingLevel)) + 1) % levels.length
    ];
  });
}

async function setRpcModeOption(
  target: any,
  options: {
    mode: RpcModeValue;
    stateKey: RpcModeStateKey;
    fallback: RpcModeValue;
    commandType: "set_steering_mode" | "set_follow_up_mode";
  },
) {
  return await enqueueRpcSettingsMutation(
    target,
    options.stateKey,
    async () => {
      const next = normalizeRpcMode(
        options.mode,
        normalizeRpcMode(target?.[options.stateKey], options.fallback),
      );
      await callRpcSettingsMutation(target, {
        type: options.commandType,
        mode: next,
      });
      setRpcTargetState(target, options.stateKey, next);
      return next;
    },
  );
}

export async function setRpcSteeringMode(
  target: any,
  mode: "all" | "one-at-a-time",
) {
  return await setRpcModeOption(target, {
    mode,
    stateKey: "steeringMode",
    fallback: "all",
    commandType: "set_steering_mode",
  });
}

export async function setRpcFollowUpMode(
  target: any,
  mode: "all" | "one-at-a-time",
) {
  return await setRpcModeOption(target, {
    mode,
    stateKey: "followUpMode",
    fallback: DEFAULT_RPC_MODE,
    commandType: "set_follow_up_mode",
  });
}

export async function setRpcAutoCompaction(target: any, enabled: boolean) {
  return await enqueueRpcSettingsMutation(
    target,
    "autoCompactionEnabled",
    async () => {
      const next = Boolean(enabled);
      await callRpcSettingsMutation(target, {
        type: "set_auto_compaction",
        enabled: next,
      });
      setRpcTargetState(target, "autoCompactionEnabled", next);
      return next;
    },
  );
}
