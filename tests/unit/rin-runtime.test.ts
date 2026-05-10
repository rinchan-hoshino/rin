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
const sessionForkMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "fork.js")).href
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

test("applyDisableEndTurnThresholdCompaction preserves overflow and skips normal threshold checks", async () => {
  let originalCalls = 0;
  const overflowMessage = {
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    stopReason: "error",
    errorMessage: "prompt is too long",
    timestamp: new Date().toISOString(),
  };
  const normalMessage = {
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    stopReason: "done",
    usage: { totalTokens: 999 },
    timestamp: new Date().toISOString(),
  };

  const session = {
    model: { provider: "openai", id: "gpt-test", contextWindow: 1000 },
    async _checkCompaction() {
      originalCalls += 1;
    },
  };

  runtimeMod.applyDisableEndTurnThresholdCompaction(session);
  await session._checkCompaction(normalMessage);
  assert.equal(originalCalls, 0);
  await session._checkCompaction(overflowMessage);
  assert.equal(originalCalls, 1);
});

test("applyMidTurnCompaction compacts before a provider call and injects continuation cue", async () => {
  let compactCalls = 0;
  let seenContext;
  const sourceMessages = [
    {
      role: "user",
      content: [{ type: "text", text: "x".repeat(400) }],
    },
  ];

  const agent = {
    state: { messages: [...sourceMessages] },
    async convertToLlm(messages) {
      return messages;
    },
    async streamFn(_model, context) {
      seenContext = context;
      return { fake: true };
    },
  };

  const session = {
    model: { provider: "openai", id: "gpt-test", contextWindow: 100 },
    agent,
    async _runAutoCompaction(reason, willRetry) {
      compactCalls += 1;
      assert.equal(reason, "threshold");
      assert.equal(willRetry, false);
      agent.state.messages = [
        {
          role: "user",
          content: [{ type: "text", text: "compacted" }],
        },
      ];
    },
  };

  runtimeMod.applyMidTurnCompaction(session, 50);
  const transformed = await agent.transformContext(sourceMessages, undefined);
  assert.equal(compactCalls, 1);
  assert.equal(transformed[0].content[0].text, "compacted");
  assert.equal(sourceMessages[0].content[0].text, "compacted");

  await agent.streamFn(session.model, {
    systemPrompt: "base prompt",
    messages: transformed,
    tools: [],
  });
  assert.ok(
    seenContext.systemPrompt.includes(
      "Context compacted; treat this as a routine internal checkpoint.",
    ),
  );
});

test("applyMidTurnCompaction defaults to an 88 percent threshold", async () => {
  let compactCalls = 0;
  const sourceMessages = [
    {
      role: "user",
      content: [{ type: "text", text: "x".repeat(360) }],
    },
  ];

  const agent = {
    state: { messages: [...sourceMessages] },
    async streamFn() {
      return { fake: true };
    },
  };

  const session = {
    model: { provider: "openai", id: "gpt-test", contextWindow: 100 },
    agent,
    async _runAutoCompaction(reason, willRetry) {
      compactCalls += 1;
      assert.equal(reason, "threshold");
      assert.equal(willRetry, false);
      agent.state.messages = [
        {
          role: "user",
          content: [{ type: "text", text: "compacted" }],
        },
      ];
    },
  };

  await runtimeMod.applyMidTurnCompaction(session);
  const transformed = await agent.transformContext(sourceMessages, undefined);

  assert.equal(compactCalls, 1);
  assert.equal(transformed[0].content[0].text, "compacted");
});

test("applyMidTurnCompaction ignores provider-shaped reasoning payload inflation", async () => {
  let compactCalls = 0;
  const sourceMessages = [
    {
      role: "assistant",
      stopReason: "done",
      usage: { input: 140165 },
      content: [{ type: "text", text: "done" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "continue" }],
    },
  ];

  const agent = {
    state: { messages: [...sourceMessages] },
    async convertToLlm() {
      return [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              encrypted_content: "x".repeat(500_000),
            },
          ],
        },
      ];
    },
    async streamFn() {
      return { fake: true };
    },
  };

  const session = {
    model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 272000 },
    agent,
    async _runAutoCompaction() {
      compactCalls += 1;
    },
  };

  runtimeMod.applyMidTurnCompaction(session, 88);
  const transformed = await agent.transformContext(sourceMessages, undefined);
  assert.equal(compactCalls, 0);
  assert.equal(transformed, sourceMessages);
});

test("applyMidTurnCompaction skips routine compaction for marked temporary forks", async () => {
  let compactCalls = 0;
  const sourceMessages = [
    {
      role: "user",
      content: [{ type: "text", text: "x".repeat(400) }],
    },
  ];

  const agent = {
    state: { messages: [...sourceMessages] },
    async streamFn() {
      return { fake: true };
    },
  };

  const session = {
    [sessionForkMod.EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY]: true,
    autoCompactionEnabled: true,
    model: { provider: "openai", id: "gpt-test", contextWindow: 100 },
    agent,
    async _runAutoCompaction() {
      compactCalls += 1;
    },
  };

  runtimeMod.applyMidTurnCompaction(session, 50);
  const transformed = await agent.transformContext(sourceMessages, undefined);
  assert.equal(compactCalls, 0);
  assert.equal(transformed, sourceMessages);
});

test("applyMidTurnCompaction respects disabled auto compaction", async () => {
  let compactCalls = 0;
  const sourceMessages = [
    {
      role: "user",
      content: [{ type: "text", text: "x".repeat(400) }],
    },
  ];

  const agent = {
    state: { messages: [...sourceMessages] },
    async streamFn() {
      return { fake: true };
    },
  };

  const session = {
    autoCompactionEnabled: false,
    model: { provider: "openai", id: "gpt-test", contextWindow: 100 },
    agent,
    async _runAutoCompaction() {
      compactCalls += 1;
    },
  };

  runtimeMod.applyMidTurnCompaction(session, 50);
  const transformed = await agent.transformContext(sourceMessages, undefined);
  assert.equal(compactCalls, 0);
  assert.equal(transformed, sourceMessages);
});

test("applyOverflowContinuationPrompt writes marker only for overflow compaction", async () => {
  const listeners = [];
  const session = {
    sessionManager: {
      getSessionId() {
        return "session-overflow-marker";
      },
    },
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
  };

  runtimeMod.clearCompactionContinuationMarker(session);
  runtimeMod.applyOverflowContinuationPrompt(session);
  listeners[0]({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    result: { summary: "threshold" },
  });
  assert.equal(
    runtimeMod.consumeCompactionContinuationMarker(session),
    undefined,
  );

  listeners[0]({
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    result: { summary: "overflow" },
  });
  const marker = runtimeMod.consumeCompactionContinuationMarker(session);
  assert.equal(marker.reason, "overflow");
});
