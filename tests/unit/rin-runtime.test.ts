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

test("auto compaction emits Rin before-compact hooks without extension-runner bridging", async () => {
  const calls = [];
  const session = {
    __rinCapabilities: {
      hasHandlers(eventName) {
        calls.push(`has:${eventName}`);
        return eventName === "session_before_compact";
      },
      async emit(event) {
        calls.push(`emit:${event.reason}`);
      },
    },
    async _runAutoCompaction(reason, willRetry) {
      calls.push(`compact:${reason}:${willRetry}`);
    },
  };

  runtimeMod.applyRinBeforeCompactionHooks(session);
  await session._runAutoCompaction("threshold", false);

  assert.deepEqual(calls, [
    "has:session_before_compact",
    "emit:threshold",
    "compact:threshold:false",
  ]);
});

test("runtime session shutdown emits Rin capability hooks without extension-runner bridging", async () => {
  const calls = [];
  const runtime = {
    session: {
      __rinCapabilities: {
        hasHandlers(eventName) {
          calls.push(`has:${eventName}`);
          return eventName === "session_shutdown";
        },
        async emit(event) {
          calls.push(`emit:${event.reason}:${event.targetSessionFile || ""}`);
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
    "emit:new:/tmp/next-session.jsonl",
    "teardown:new:/tmp/next-session.jsonl",
    "has:session_shutdown",
    "emit:quit:",
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

test("applyRinCompactionSettingsTuning keeps more recent context for large models", () => {
  const session = {
    model: { contextWindow: 272_000 },
    settingsManager: {
      getCompactionSettings() {
        return {
          enabled: true,
          reserveTokens: 16_384,
          keepRecentTokens: 20_000,
        };
      },
    },
  };

  runtimeMod.applyRinCompactionSettingsTuning(session);
  const settings = session.settingsManager.getCompactionSettings();

  assert.equal(settings.reserveTokens, 21_760);
  assert.equal(settings.keepRecentTokens, 95_200);
});

test("applyRinCompactionConcurrencyGuard rejects overlapping manual compactions", async () => {
  let releaseFirst;
  let compactCalls = 0;
  const firstCompaction = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const session = {
    async compact() {
      compactCalls += 1;
      if (compactCalls === 1) await firstCompaction;
      return { summary: `ok ${compactCalls}` };
    },
    async abort() {},
  };

  runtimeMod.applyRinCompactionConcurrencyGuard(session);
  const first = session.compact();
  await assert.rejects(session.compact(), /Compaction already in progress/);
  assert.equal(compactCalls, 1);

  releaseFirst();
  await first;
  await session.compact();
  assert.equal(compactCalls, 2);
});

test("applyRinCompactionConcurrencyGuard aborts active compaction before normal abort", async () => {
  const calls = [];
  const session = {
    isCompacting: true,
    abortCompaction() {
      calls.push("abort-compaction");
    },
    async abort() {
      calls.push("abort");
    },
  };

  runtimeMod.applyRinCompactionConcurrencyGuard(session);
  await session.abort();

  assert.deepEqual(calls, ["abort-compaction", "abort"]);
});
