import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const settings = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/model-settings.js")
>("dist/core/rin-frontend-sdk/model-settings.js");

function createTarget(overrides: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const events: any[] = [];
  const target: any = {
    model: { provider: "openai", id: "gpt-5", reasoning: true },
    thinkingLevel: "medium",
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    autoCompactionEnabled: false,
    state: {
      thinkingLevel: "medium",
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      autoCompactionEnabled: false,
    },
    async call(type: string, command: unknown) {
      calls.push([type, command]);
      return { ok: true };
    },
    emitEvent(event: unknown) {
      events.push(event);
    },
    calls,
    events,
    ...overrides,
  };
  return target;
}

test("RPC model settings mutate daemon state before mirroring local state", async () => {
  const target = createTarget();
  const refreshes: number[] = [];
  const refresh = async () => {
    refreshes.push(refreshes.length + 1);
  };

  assert.equal(
    await settings.setRpcThinkingLevel(target, "invalid" as any),
    "high",
  );
  assert.equal(
    await settings.setRpcSteeringMode(target, "invalid" as any),
    "all",
  );
  assert.equal(
    await settings.setRpcFollowUpMode(target, "invalid" as any),
    "one-at-a-time",
  );
  assert.equal(await settings.setRpcAutoCompaction(target, 1 as any), true);
  await settings.setRpcModel(
    target,
    { provider: "anthropic", id: "sonnet" },
    refresh,
  );
  assert.deepEqual(await settings.cycleRpcModel(target, undefined, refresh), {
    ok: true,
  });

  assert.equal(target.thinkingLevel, "high");
  assert.equal(target.state.thinkingLevel, "high");
  assert.equal(target.steeringMode, "all");
  assert.equal(target.followUpMode, "one-at-a-time");
  assert.equal(target.autoCompactionEnabled, true);
  assert.deepEqual(target.events, [
    { type: "thinking_level_changed", level: "high" },
  ]);
  assert.equal(refreshes.length, 2);
  assert.deepEqual(target.calls.slice(-2), [
    [
      "set_model",
      { type: "set_model", provider: "anthropic", modelId: "sonnet" },
    ],
    ["cycle_model", { type: "cycle_model" }],
  ]);
});

test("RPC thinking levels follow Pi metadata instead of model names", async () => {
  const target = createTarget({
    model: {
      provider: "openai",
      id: "gpt-codex-max-latest",
      reasoning: true,
    },
  });

  assert.equal(await settings.setRpcThinkingLevel(target, "max"), "high");
  assert.deepEqual(target.calls, [
    ["set_thinking_level", { type: "set_thinking_level", level: "high" }],
  ]);
});

test("RPC settings use the dedicated mutation transport when available", async () => {
  const commands: unknown[] = [];
  const target = createTarget({
    state: undefined,
    async callRpcSettingsMutation(command: unknown) {
      commands.push(command);
    },
  });

  await settings.setRpcThinkingLevel(target, "low");
  await settings.setRpcSteeringMode(target, "one-at-a-time");
  await settings.setRpcFollowUpMode(target, "all");
  await settings.setRpcAutoCompaction(target, false);

  assert.deepEqual(commands, [
    { type: "set_thinking_level", level: "low" },
    { type: "set_steering_mode", mode: "one-at-a-time" },
    { type: "set_follow_up_mode", mode: "all" },
    { type: "set_auto_compaction", enabled: false },
  ]);
});

test("RPC thinking cycles supported levels and preserves order under delayed acknowledgements", async () => {
  const acknowledgements: Array<() => void> = [];
  const target = createTarget({
    async call() {
      await new Promise<void>((resolve) => acknowledgements.push(resolve));
    },
  });

  const first = settings.setRpcThinkingLevel(target, "high");
  const second = settings.setRpcThinkingLevel(target, "low");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acknowledgements.length, 1);
  assert.equal(target.thinkingLevel, "medium");
  acknowledgements.shift()?.();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acknowledgements.length, 1);
  acknowledgements.shift()?.();
  await second;
  assert.equal(target.thinkingLevel, "low");

  target.call = async () => undefined;
  assert.equal(await settings.cycleRpcThinkingLevel(target), "medium");
  target.model = { reasoning: false };
  assert.equal(await settings.cycleRpcThinkingLevel(target), undefined);
});

test("RPC setting failures leave local state unchanged and do not poison the queue", async () => {
  let fail = true;
  const target = createTarget({
    async call() {
      if (fail) throw new Error("offline");
    },
  });

  await assert.rejects(settings.setRpcThinkingLevel(target, "high"), /offline/);
  assert.equal(target.thinkingLevel, "medium");
  fail = false;
  assert.equal(await settings.setRpcThinkingLevel(target, "low"), "low");
});

test("persistent RPC settings use Rin's configured settings manager", async () => {
  const manager = await settings.getPersistentSettingsManager();
  let called = false;
  await settings.persistRpcSettingsMutation(async (value) => {
    called = value === manager;
  });
  assert.equal(called, true);
  assert.equal(await settings.getPersistentSettingsManager(), manager);
});
