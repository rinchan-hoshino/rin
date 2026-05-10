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

test("Rin classifies Codex WebSocket failures by recovery path", () => {
  const close1009 = {
    stopReason: "error",
    errorMessage: "WebSocket closed 1009",
  };
  const generic = {
    stopReason: "error",
    errorMessage: "WebSocket error",
  };

  assert.equal(runtimeMod.isRinContextOverflow(close1009, 272000), true);
  assert.equal(runtimeMod.isRinRetryableProviderError(close1009), false);
  assert.equal(runtimeMod.isRinContextOverflow(generic, 272000), false);
  assert.equal(runtimeMod.isRinRetryableProviderError(generic), true);
});

test("Rin overflow compaction patch compacts and retries WebSocket 1009", async () => {
  const assistant = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "WebSocket closed 1009",
    provider: "openai-codex",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };

  const calls: Array<[string, boolean]> = [];
  const session: any = {
    model: { provider: "openai-codex", id: "gpt-5.5", contextWindow: 272000 },
    agent: { state: { messages: [{ role: "user" }, assistant] } },
    _checkCompaction: async () => {
      throw new Error("upstream detector should not handle WebSocket 1009");
    },
    _runAutoCompaction: async (reason: string, willRetry: boolean) => {
      calls.push([reason, willRetry]);
    },
  };

  runtimeMod.applyDisableEndTurnThresholdCompaction(session);
  await session._checkCompaction(assistant, false);

  assert.deepEqual(calls, [["overflow", true]]);
  assert.deepEqual(session.agent.state.messages, [{ role: "user" }]);
  assert.equal(session._overflowRecoveryAttempted, true);
});

test("Rin tracks current auto-compaction reason while compaction runs", async () => {
  const seen: string[] = [];
  const session: any = {
    _runAutoCompaction: async () => {
      seen.push(session.__rinCurrentCompactionReason);
    },
  };

  runtimeMod.applyRinCompactionReasonTracking(session);
  await session._runAutoCompaction("overflow", true);

  assert.deepEqual(seen, ["overflow"]);
  assert.equal(session.__rinCurrentCompactionReason, undefined);
});

test("Rin retry patch treats generic WebSocket failures as retryable", () => {
  const session: any = {
    _isRetryableError: () => false,
  };

  runtimeMod.applyRinRetryableProviderErrors(session);

  assert.equal(
    session._isRetryableError({
      stopReason: "error",
      errorMessage: "WebSocket error",
    }),
    true,
  );
  assert.equal(
    session._isRetryableError({
      stopReason: "error",
      errorMessage: "WebSocket closed 1009",
    }),
    false,
  );
});
