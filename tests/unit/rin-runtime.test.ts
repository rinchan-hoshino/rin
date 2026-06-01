import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);
function waitForTimers() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

test("getManagedSkillPaths includes agent memory skills and builtin skills", () => {
  const paths = runtimeMod.getManagedSkillPaths("/tmp/rin-home");
  assert.deepEqual(paths, [
    "/tmp/rin-home/self_improve/skills",
    "/tmp/rin-home/docs/rin/builtin-skills",
  ]);
});

test("compaction reason tracking annotates native before-compact hooks", async () => {
  const calls = [];
  const session = {
    async compact() {
      calls.push(`manual:${this.__rinCurrentCompactionReason}`);
    },
    async _runAutoCompaction(reason, willRetry) {
      calls.push(
        `auto:${reason}:${willRetry}:${this.__rinCurrentCompactionReason}`,
      );
    },
  };

  runtimeMod.applyRinCompactionReasonTracking(session);
  await session.compact();
  await session._runAutoCompaction("threshold", false);

  assert.deepEqual(calls, ["manual:manual", "auto:threshold:false:threshold"]);
  assert.equal(session.__rinCurrentCompactionReason, undefined);
});

test("Rin percent compaction defaults to 85 percent", async () => {
  let contextTokens = 849;
  let nativeChecks = 0;
  let autoCompactions = 0;
  const session = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true };
      },
    },
    model: { contextWindow: 1000 },
    sessionManager: {
      getBranch() {
        return [];
      },
    },
    async _checkCompaction() {
      nativeChecks += 1;
      return false;
    },
    async _runAutoCompaction(reason: string, retry: boolean) {
      autoCompactions += 1;
      return `${reason}:${retry}`;
    },
  };

  runtimeMod.applyRinCompactionPercentThreshold(session, {
    calculateContextTokens: () => contextTokens,
    estimateContextTokens: () => ({ tokens: contextTokens }),
    getLatestCompactionEntry: () => undefined,
  });

  assert.equal(
    await session._checkCompaction({ timestamp: Date.now() }),
    false,
  );
  assert.equal(nativeChecks, 0);
  assert.equal(autoCompactions, 0);

  contextTokens = 850;
  assert.equal(
    await session._checkCompaction({ timestamp: Date.now() }),
    "threshold:false",
  );
  assert.equal(nativeChecks, 0);
  assert.equal(autoCompactions, 1);
});

test("Rin percent compaction estimates error fallback from pruned context", async () => {
  let autoCompactions = 0;
  let nativeChecks = 0;
  const session = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true };
      },
    },
    model: { provider: "test", id: "model", contextWindow: 1000 },
    sessionManager: {
      getBranch() {
        return [];
      },
    },
    agent: {
      state: {
        messages: [
          { role: "user", content: "old" },
          { role: "toolResult", content: "huge old output" },
          { role: "user", content: "recent 1" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "recent 2" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "recent 3" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "recent 4" },
          { role: "assistant", content: "temporary upstream error" },
        ],
      },
    },
    async _checkCompaction() {
      nativeChecks += 1;
      return "native";
    },
    async _runAutoCompaction() {
      autoCompactions += 1;
      return "compacted";
    },
  };

  runtimeMod.applyRinCompactionPercentThreshold(session, {
    calculateContextTokens: () => 0,
    estimateContextTokens: (messages: any[]) => ({
      tokens: messages.some((message) => message.content === "huge old output")
        ? 900
        : 10,
    }),
    getLatestCompactionEntry: () => undefined,
  });

  assert.equal(
    await session._checkCompaction({
      stopReason: "error",
      provider: "test",
      model: "model",
      timestamp: Date.now(),
      content: "temporary upstream error",
    }),
    false,
  );
  assert.equal(nativeChecks, 0);
  assert.equal(autoCompactions, 0);
});

test("Rin context usage reports the pruned provider-bound estimate", () => {
  const session = {
    model: { contextWindow: 1000 },
    messages: [
      { role: "user", content: "old" },
      { role: "toolResult", content: "huge old output" },
      { role: "user", content: "recent 1" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "recent 2" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "recent 3" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "recent 4" },
      { role: "assistant", content: "ok" },
    ],
    getContextUsage() {
      return { tokens: 900, contextWindow: 1000, percent: 90 };
    },
  };

  runtimeMod.applyRinPrunedContextUsage(session, {
    estimateContextTokens: (messages: any[]) => ({
      tokens: messages.some((message) => message.content === "huge old output")
        ? 900
        : 10,
    }),
  });

  assert.deepEqual(session.getContextUsage(), {
    tokens: 10,
    contextWindow: 1000,
    percent: 1,
  });
});

test("runtime session shutdown emits Rin capability hooks without extension-runner bridging", async () => {
  const calls = [];
  const runtime = {
    session: {
      sessionManager: {
        __rinFrontend: { kind: "test", key: "stable-owner" },
      },
      __rinCapabilities: {
        hasHandlers(eventName) {
          calls.push(`has:${eventName}`);
          return eventName === "session_shutdown";
        },
        async emit(event) {
          calls.push(
            `emit:${event.reason}:${event.targetSessionFile || ""}:${event.frontend?.key || ""}`,
          );
        },
      },
    },
    async teardownCurrent(reason, targetSessionFile) {
      calls.push(`teardown:${reason}:${targetSessionFile}`);
    },
    async dispose() {
      calls.push("dispose");
    },
  };

  runtimeMod.patchRinRuntimeSessionShutdown(runtime);
  await runtime.teardownCurrent("new", "/tmp/next-session.jsonl");
  await runtime.dispose();

  assert.deepEqual(calls, [
    "has:session_shutdown",
    "emit:new:/tmp/next-session.jsonl:stable-owner",
    "teardown:new:/tmp/next-session.jsonl",
    "has:session_shutdown",
    "emit:quit::stable-owner",
    "dispose",
  ]);
});

test("applyAutoReloadAfterCompaction reloads after successful compaction only once per session", async () => {
  const listeners = [];
  let subscribeCount = 0;
  let reloadCount = 0;

  const session = {
    subscribe(listener) {
      subscribeCount += 1;
      listeners.push(listener);
      return () => {};
    },
    async reload() {
      reloadCount += 1;
    },
  };

  runtimeMod.applyAutoReloadAfterCompaction(session);
  runtimeMod.applyAutoReloadAfterCompaction(session);

  assert.equal(subscribeCount, 1);

  listeners[0]({ type: "compaction_end", aborted: true, result: undefined });
  await waitForTimers();
  assert.equal(reloadCount, 0);

  listeners[0]({
    type: "compaction_end",
    aborted: false,
    result: { summary: "ok" },
  });
  await waitForTimers();
  assert.equal(reloadCount, 1);
});

test("applyAutoReloadAfterCompaction queues one extra reload while a reload is in flight", async () => {
  const listeners = [];
  let releaseReload;
  let reloadCount = 0;

  const firstReload = new Promise((resolve) => {
    releaseReload = resolve;
  });

  const session = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    async reload() {
      reloadCount += 1;
      if (reloadCount === 1) {
        await firstReload;
      }
    },
  };

  runtimeMod.applyAutoReloadAfterCompaction(session);

  listeners[0]({
    type: "compaction_end",
    aborted: false,
    result: { summary: "first" },
  });
  listeners[0]({
    type: "compaction_end",
    aborted: false,
    result: { summary: "second" },
  });

  await waitForTimers();
  assert.equal(reloadCount, 1);

  releaseReload();
  await waitForTimers();
  await waitForTimers();
  assert.equal(reloadCount, 2);
});

test("manual compaction waits for refresh before returning", async () => {
  const listeners = [];
  let reloadCount = 0;
  const sequence = [];
  const session = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    async reload() {
      reloadCount += 1;
      sequence.push("reload");
    },
    async compact() {
      for (const listener of listeners) {
        listener({
          type: "compaction_end",
          reason: "manual",
          aborted: false,
          result: { summary: "ok" },
        });
      }
      sequence.push("compact-done");
      return { summary: "ok" };
    },
  };

  runtimeMod.applyAutoReloadAfterCompaction(session);
  await session.compact();

  assert.equal(reloadCount, 1);
  assert.deepEqual(sequence, ["compact-done", "reload"]);
});
