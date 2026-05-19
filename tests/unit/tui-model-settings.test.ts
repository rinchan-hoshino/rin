import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const modelSettings = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);

function createTarget(overrides = {}) {
  const sent = [];
  const target = {
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
    settingsManager: {
      setSteeringMode(mode) {
        this.steeringMode = mode;
      },
      setFollowUpMode(mode) {
        this.followUpMode = mode;
      },
    },
    client: {
      send(payload) {
        sent.push(payload);
        return Promise.resolve();
      },
    },
    call(command, payload) {
      sent.push({ command, payload });
      return Promise.resolve({ ok: true, command, payload });
    },
    sent,
    ...overrides,
  };
  return target;
}

test("tui model settings normalize local rpc state updates", async () => {
  const target = createTarget();

  modelSettings.setRpcThinkingLevel(target, "invalid");
  modelSettings.setRpcSteeringMode(target, "invalid");
  modelSettings.setRpcFollowUpMode(target, "invalid");
  modelSettings.setRpcAutoCompaction(target, 1);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(target.thinkingLevel, "high");
  assert.equal(target.state.thinkingLevel, "high");
  assert.equal(target.steeringMode, "all");
  assert.equal(target.state.steeringMode, "all");
  assert.equal(target.followUpMode, "one-at-a-time");
  assert.equal(target.state.followUpMode, "one-at-a-time");
  assert.equal(target.autoCompactionEnabled, true);
  assert.equal(target.state.autoCompactionEnabled, true);
  assert.deepEqual(target.sent.slice(0, 4), [
    { type: "set_thinking_level", level: "high" },
    { type: "set_steering_mode", mode: "all" },
    { type: "set_follow_up_mode", mode: "one-at-a-time" },
    { type: "set_auto_compaction", enabled: true },
  ]);
});

test("tui model settings refresh models after rpc model mutations", async () => {
  const target = createTarget();
  const calls = [];
  target.call = async (command, payload) => {
    calls.push([command, payload]);
    return { ok: true };
  };
  let refreshCount = 0;
  const refreshModels = async () => {
    refreshCount += 1;
  };

  await modelSettings.setRpcModel(
    target,
    { provider: "anthropic", id: "claude-sonnet" },
    refreshModels,
  );
  const cycleResult = await modelSettings.cycleRpcModel(
    target,
    "forward",
    refreshModels,
  );

  assert.deepEqual(calls, [
    [
      "set_model",
      { type: "set_model", provider: "anthropic", modelId: "claude-sonnet" },
    ],
    ["cycle_model", { type: "cycle_model" }],
  ]);
  assert.equal(refreshCount, 2);
  assert.deepEqual(cycleResult, { ok: true });
});

test("tui model settings tolerate missing settings manager and client send failures", async () => {
  const target = createTarget({
    settingsManager: undefined,
    client: {
      send() {
        return Promise.reject(new Error("offline"));
      },
    },
  });

  modelSettings.setRpcSteeringMode(target, "one-at-a-time");
  modelSettings.setRpcFollowUpMode(target, "all");
  modelSettings.setRpcAutoCompaction(target, false);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(target.steeringMode, "one-at-a-time");
  assert.equal(target.followUpMode, "all");
  assert.equal(target.autoCompactionEnabled, false);
});
