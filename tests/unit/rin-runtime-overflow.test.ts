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

test("Rin treats WebSocket close 1009 as context overflow", () => {
  assert.equal(
    runtimeMod.isRinContextOverflow(
      { stopReason: "error", errorMessage: "WebSocket closed 1009" },
      272000,
    ),
    true,
  );
  assert.equal(
    runtimeMod.isRinContextOverflow(
      { stopReason: "error", errorMessage: "WebSocket error" },
      272000,
    ),
    false,
  );
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
