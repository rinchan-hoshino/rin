import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import tokenUsageModule from "../../dist/core/token-usage/index.js";
import {
  openTokenUsageDb,
  queryTokenUsageEvents,
} from "../../dist/core/token-usage/store.js";

async function withTempAgent(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-token-index-"));
  const previous = process.env.RIN_DIR;
  process.env.RIN_DIR = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function context(id: string, overrides: Record<string, unknown> = {}) {
  return {
    frontend: { kind: "tui" },
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => `/tmp/${id}.jsonl`,
      getSessionName: () => `name-${id}`,
      getCwd: () => `/work/${id}`,
      isPersisted: () => true,
    },
    ...overrides,
  };
}

test("token usage capability records every runtime hook with stable session context", async () => {
  await withTempAgent(async (root) => {
    const capability = tokenUsageModule({
      getThinkingLevel: () => "medium",
    } as any);
    const ctx = context("owner-session", {
      getThinkingLevel: () => "high",
    });

    await capability.hooks.session_start[0]({ reason: "resume" }, ctx);
    await capability.hooks.model_select[0](
      {
        model: { provider: "openai", id: "gpt-owner" },
        previousModel: { provider: "other", name: "old-model" },
        source: "settings",
      },
      ctx,
    );
    await capability.hooks.turn_start[0](
      { turnIndex: 3, timestamp: 12345 },
      ctx,
    );

    const circular: any = { command: "npm test" };
    circular.self = circular;
    await capability.hooks.tool_execution_start[0](
      { toolCallId: "call-1", toolName: "bash", args: circular },
      ctx,
    );
    await capability.hooks.tool_execution_start[0]({}, ctx);
    await capability.hooks.tool_execution_end[0](
      {
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: "failed" },
        isError: true,
      },
      ctx,
    );

    const messages = [
      {
        id: "assistant-text",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        provider: "openai",
        model: "gpt-owner",
        stopReason: "stop",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_tokens: 2,
          cache_write_tokens: 1,
          total_tokens: 17,
          cost: { input: 0.1, output: 0.2, total: 0.3 },
        },
      },
      {
        id: "assistant-one-tool",
        role: "assistant",
        content: [{ type: "toolCall", name: "read" }],
      },
      {
        id: "assistant-many-tools",
        role: "assistant",
        content: [
          { type: "toolCall", name: "write" },
          { type: "toolCall", toolName: "bash" },
        ],
        stopReason: "error",
      },
      {
        id: "tool-result-named",
        role: "toolResult",
        toolName: "read",
        toolCallId: "call-read",
      },
      { id: "tool-result-plain", role: "toolResult" },
      { id: "user-message", role: "user" },
      {
        id: "unknown-role",
        role: "system",
        errorMessage: `runtime failed ${"x".repeat(300)}`,
      },
    ];
    for (const message of messages) {
      await capability.hooks.message_end[0]({ message }, ctx);
    }

    await capability.hooks.agent_end[0]({ messages }, ctx);
    await capability.hooks.agent_end[0]({}, ctx);
    await capability.hooks.session_compact[0](
      { fromExtension: true, compactionEntry: { id: "compact-1" } },
      ctx,
    );
    await capability.hooks.session_shutdown[0]({}, ctx);

    const rows = queryTokenUsageEvents({ agentDir: root, limit: 100 });
    assert.equal(rows.length, 17);
    assert.ok(
      rows.every(
        (row) =>
          row.session_id === "owner-session" &&
          row.session_file === "/tmp/owner-session.jsonl" &&
          row.source === "frontend:tui",
      ),
    );
    assert.equal(
      rows.find((row) => row.event_type === "model_select")?.model,
      "gpt-owner",
    );
    assert.equal(
      rows.find(
        (row) =>
          row.event_type === "message_end" && row.message_role === "assistant",
      )?.thinking_level,
      "high",
    );

    const db = openTokenUsageDb(root);
    const capabilityRows = db
      .prepare(
        "SELECT capability_kind, capability_key FROM telemetry_events WHERE event_type = 'message_end' ORDER BY timestamp, id",
      )
      .all() as Array<{ capability_kind: string; capability_key: string }>;
    assert.deepEqual(
      new Set(capabilityRows.map((row) => row.capability_kind)),
      new Set([
        "assistant_text",
        "assistant_tool_call",
        "assistant_multi_tool_call",
        "tool_result",
        "user_input",
        "runtime",
      ]),
    );
    assert.ok(
      capabilityRows.some((row) => row.capability_key === "tools:bash+write"),
    );
  });
});

test("token usage capability tolerates missing and throwing thinking-level providers", async () => {
  await withTempAgent(async (root) => {
    const fallback = tokenUsageModule({
      getThinkingLevel: () => "low",
    } as any);
    const throwingContext = context("thinking-fallback", {
      frontend: {},
      getThinkingLevel() {
        throw new Error("context unavailable");
      },
    });
    await fallback.hooks.session_start[0]({ reason: "new" }, throwingContext);

    const noThinking = tokenUsageModule({
      getThinkingLevel() {
        throw new Error("option unavailable");
      },
    } as any);
    await noThinking.hooks.session_start[0](
      { reason: "new" },
      { cwd: "/work/anonymous" },
    );

    const rows = queryTokenUsageEvents({ agentDir: root, limit: 10 });
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.thinking_level === "low"));
    assert.ok(rows.some((row) => !row.thinking_level));
    assert.ok(rows.some((row) => !row.source));
  });
});
