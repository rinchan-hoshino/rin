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
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
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

test("tui model settings update local state after rpc acknowledgement", async () => {
  const target = createTarget();

  await Promise.all([
    modelSettings.setRpcThinkingLevel(target, "invalid"),
    modelSettings.setRpcSteeringMode(target, "invalid"),
    modelSettings.setRpcFollowUpMode(target, "invalid"),
    modelSettings.setRpcAutoCompaction(target, 1),
  ]);

  assert.equal(target.thinkingLevel, "high");
  assert.equal(target.state.thinkingLevel, "high");
  assert.equal(target.steeringMode, "all");
  assert.equal(target.state.steeringMode, "all");
  assert.equal(target.followUpMode, "one-at-a-time");
  assert.equal(target.state.followUpMode, "one-at-a-time");
  assert.equal(target.autoCompactionEnabled, true);
  assert.equal(target.state.autoCompactionEnabled, true);
  assert.deepEqual(target.sent.slice(0, 4), [
    {
      command: "set_thinking_level",
      payload: { type: "set_thinking_level", level: "high" },
    },
    {
      command: "set_steering_mode",
      payload: { type: "set_steering_mode", mode: "all" },
    },
    {
      command: "set_follow_up_mode",
      payload: { type: "set_follow_up_mode", mode: "one-at-a-time" },
    },
    {
      command: "set_auto_compaction",
      payload: { type: "set_auto_compaction", enabled: true },
    },
  ]);
});

test("tui thinking level stays unchanged until the daemon confirms persistence", async () => {
  let acknowledge;
  const target = createTarget({
    call(command, payload) {
      this.sent.push({ command, payload });
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    },
  });

  const mutation = modelSettings.setRpcThinkingLevel(target, "high");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(target.thinkingLevel, "medium");
  assert.equal(target.state.thinkingLevel, "medium");
  assert.deepEqual(target.sent, [
    {
      command: "set_thinking_level",
      payload: { type: "set_thinking_level", level: "high" },
    },
  ]);

  acknowledge({ level: "high" });
  await mutation;

  assert.equal(target.thinkingLevel, "high");
  assert.equal(target.state.thinkingLevel, "high");
});

test("tui thinking mutations preserve user order when acknowledgements are delayed", async () => {
  const acknowledgements = [];
  const target = createTarget({
    call(command, payload) {
      this.sent.push({ command, payload });
      return new Promise((resolve) => acknowledgements.push(resolve));
    },
  });

  const first = modelSettings.setRpcThinkingLevel(target, "high");
  const second = modelSettings.setRpcThinkingLevel(target, "low");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(acknowledgements.length, 1);
  assert.deepEqual(target.sent, [
    {
      command: "set_thinking_level",
      payload: { type: "set_thinking_level", level: "high" },
    },
  ]);

  acknowledgements[0]({ level: "high" });
  await first;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(acknowledgements.length, 2);
  assert.deepEqual(target.sent[1], {
    command: "set_thinking_level",
    payload: { type: "set_thinking_level", level: "low" },
  });

  acknowledgements[1]({ level: "low" });
  await second;

  assert.equal(target.thinkingLevel, "low");
  assert.equal(target.state.thinkingLevel, "low");
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

test("rpc interactive session reports setting persistence failures", async () => {
  const session = new RpcInteractiveSession({
    send() {
      return Promise.reject(new Error("rin_disconnected:req_7"));
    },
    subscribe() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  });
  session.model = { provider: "openai", id: "gpt-5", reasoning: true };
  session.state.model = session.model;
  const events = [];
  session.subscribe((event) => events.push(event));

  const mutation = session.setThinkingLevel("high");
  await assert.rejects(mutation, /rin_disconnected:req_7/);

  assert.equal(session.thinkingLevel, "medium");
  assert.deepEqual(
    events.filter((event) => event.type === "rpc_settings_mutation_error"),
    [
      {
        type: "rpc_settings_mutation_error",
        error: "disconnected: req_7",
      },
    ],
  );
});

test("tui model settings reject rpc failures without optimistic local state", async () => {
  const target = createTarget({
    settingsManager: undefined,
    call() {
      return Promise.reject(new Error("offline"));
    },
  });

  await assert.rejects(
    modelSettings.setRpcThinkingLevel(target, "high"),
    /offline/,
  );
  await assert.rejects(
    modelSettings.setRpcSteeringMode(target, "one-at-a-time"),
    /offline/,
  );
  await assert.rejects(
    modelSettings.setRpcFollowUpMode(target, "all"),
    /offline/,
  );
  await assert.rejects(
    modelSettings.setRpcAutoCompaction(target, true),
    /offline/,
  );

  assert.equal(target.thinkingLevel, "medium");
  assert.equal(target.state.thinkingLevel, "medium");
  assert.equal(target.steeringMode, "all");
  assert.equal(target.state.steeringMode, "all");
  assert.equal(target.followUpMode, "one-at-a-time");
  assert.equal(target.state.followUpMode, "one-at-a-time");
  assert.equal(target.autoCompactionEnabled, false);
  assert.equal(target.state.autoCompactionEnabled, false);
});
