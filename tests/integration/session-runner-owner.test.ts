import assert from "node:assert/strict";
import test from "node:test";

import "../support/register-session-runner-fixture.js";

const runner = await import("../../dist/core/session/runner.js");

type RunnerFixture = {
  openOptions?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  bound: {
    session: Record<string, any>;
    runtime: { dispose: () => Promise<void> };
  };
};

declare global {
  var __rinSessionRunnerFixture: RunnerFixture;
}

function installFixture(options: {
  finalContent?: unknown;
  subscribeResult?: "function" | "other";
  cleanupThrows?: boolean;
  omitAssistant?: boolean;
  assistantError?: string;
}) {
  const calls: string[] = [];
  const branch: any[] = [];
  let listener: ((event: unknown) => void) | undefined;
  const session = {
    sessionManager: {
      getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
    subscribe(callback: (event: unknown) => void) {
      calls.push("subscribe");
      listener = callback;
      if (options.subscribeResult === "other") return { subscribed: true };
      return () => {
        calls.push("unsubscribe");
        if (options.cleanupThrows) throw new Error("unsubscribe failed");
      };
    },
    async prompt(prompt: string, promptOptions: Record<string, unknown>) {
      calls.push(`prompt:${prompt}`);
      assert.deepEqual(promptOptions, {
        expandPromptTemplates: false,
        source: "rpc",
      });
      const userMessage = { role: "user", content: prompt };
      const assistantMessage = {
        role: "assistant",
        content: options.finalContent,
        ...(options.assistantError
          ? { stopReason: "error", errorMessage: options.assistantError }
          : {}),
      };
      branch.push({
        type: "message",
        id: "owner-user",
        parentId: null,
        message: userMessage,
      });
      listener?.({ type: "message_end", message: userMessage });
      if (!options.omitAssistant) {
        branch.push({
          type: "message",
          id: "owner-assistant",
          parentId: "owner-user",
          message: assistantMessage,
        });
        listener?.({ type: "message_start", message: assistantMessage });
        listener?.({ type: "message_end", message: assistantMessage });
      }
    },
    agent: {
      async waitForIdle() {
        calls.push("idle");
      },
    },
    async abort() {
      calls.push("abort");
      if (options.cleanupThrows) throw new Error("abort failed");
    },
  };
  const fixture: RunnerFixture = {
    metadata: {
      sessionFile: "/tmp/session-runner.jsonl",
      sessionId: "runner-session",
    },
    bound: {
      session,
      runtime: {
        async dispose() {
          calls.push("dispose");
          if (options.cleanupThrows) throw new Error("dispose failed");
        },
      },
    },
  };
  globalThis.__rinSessionRunnerFixture = fixture;
  return { fixture, calls };
}

test("session runner returns the final assistant text and releases resources", async () => {
  const { fixture, calls } = installFixture({
    finalContent: [
      { type: "text", text: "  first  " },
      { type: "text", text: "answer" },
    ],
  });
  const result = await runner.runSessionPrompt({
    cwd: "/work/demo",
    agentDir: "/tmp/agent",
    prompt: "hello",
    additionalExtensionPaths: ["/tmp/ext"],
    sessionFile: "/tmp/input.jsonl",
  });

  assert.equal(result.session, fixture.bound.session);
  assert.equal(result.sessionFile, "/tmp/session-runner.jsonl");
  assert.equal(result.sessionId, "runner-session");
  assert.equal(result.finalText, "first  answer");
  assert.deepEqual(fixture.openOptions, {
    cwd: "/work/demo",
    agentDir: "/tmp/agent",
    prompt: "hello",
    additionalExtensionPaths: ["/tmp/ext"],
    sessionFile: "/tmp/input.jsonl",
  });
  assert.deepEqual(calls, [
    "subscribe",
    "prompt:hello",
    "idle",
    "unsubscribe",
    "abort",
    "dispose",
  ]);
});

test("session runner rejects an empty final while cleanup failures stay contained", async () => {
  const { calls } = installFixture({
    finalContent: [{ type: "text", text: "   " }],
    cleanupThrows: true,
  });
  await assert.rejects(
    runner.runSessionPrompt({
      cwd: "/work/demo",
      agentDir: "/tmp/agent",
      prompt: "no final",
    }),
    /Agent returned an empty response/,
  );
  assert.deepEqual(calls, [
    "subscribe",
    "prompt:no final",
    "idle",
    "unsubscribe",
    "abort",
    "dispose",
  ]);
});

test("session runner accepts subscription APIs without an unsubscribe callback", async () => {
  const { calls, fixture } = installFixture({
    finalContent: "plain final",
    subscribeResult: "other",
  });
  fixture.metadata = {};
  const result = await runner.runSessionPrompt({
    cwd: "/work/demo",
    agentDir: "/tmp/agent",
    prompt: "plain",
  });
  assert.equal(result.finalText, "plain final");
  assert.equal(result.sessionFile, undefined);
  assert.equal(result.sessionId, undefined);
  assert.deepEqual(calls, [
    "subscribe",
    "prompt:plain",
    "idle",
    "abort",
    "dispose",
  ]);
});

test("session runner rejects turns that settle without a terminal message", async () => {
  const { calls } = installFixture({ omitAssistant: true });
  await assert.rejects(
    () =>
      runner.runSessionPrompt({
        cwd: "/work/demo",
        agentDir: "/tmp/agent",
        prompt: "missing terminal",
      }),
    /rin_turn_settled_without_terminal/,
  );
  assert.deepEqual(calls, [
    "subscribe",
    "prompt:missing terminal",
    "idle",
    "unsubscribe",
    "abort",
    "dispose",
  ]);
});

test("session runner surfaces the producer error from a failed terminal", async () => {
  const { calls } = installFixture({
    finalContent: [{ type: "text", text: "partial" }],
    assistantError: "provider unavailable",
  });
  await assert.rejects(
    () =>
      runner.runSessionPrompt({
        cwd: "/work/demo",
        agentDir: "/tmp/agent",
        prompt: "failed terminal",
      }),
    /provider unavailable/,
  );
  assert.deepEqual(calls, [
    "subscribe",
    "prompt:failed terminal",
    "idle",
    "unsubscribe",
    "abort",
    "dispose",
  ]);
});
