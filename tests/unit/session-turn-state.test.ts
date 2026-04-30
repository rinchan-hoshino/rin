import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  listContinuableInterruptedTurnSessionFiles,
  shouldContinueInterruptedTurn,
} from "../../src/core/session/turn-state.js";

test("session turn recovery is decided by the last valid jsonl entry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-tail-"));
  try {
    const completed = path.join(dir, "completed.jsonl");
    const userTail = path.join(dir, "user-tail.jsonl");
    const assistantToolCall = path.join(dir, "assistant-tool-call.jsonl");
    const toolResultTail = path.join(dir, "tool-result-tail.jsonl");
    const metadataTail = path.join(dir, "metadata-tail.jsonl");

    await fs.writeFile(
      completed,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: "done" } })}\n`,
    );
    await fs.writeFile(
      userTail,
      `${JSON.stringify({ type: "message", message: { role: "user", content: "continue" } })}\n`,
    );
    await fs.writeFile(
      assistantToolCall,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "bash" }] } })}\n`,
    );
    await fs.writeFile(
      toolResultTail,
      `${JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "tool-1", content: [] } })}\n`,
    );
    await fs.writeFile(
      metadataTail,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-2", name: "read" }],
          },
        }),
        JSON.stringify({ type: "session_info" }),
        "",
      ].join("\n"),
    );

    assert.equal(shouldContinueInterruptedTurn(completed), false);
    assert.equal(shouldContinueInterruptedTurn(userTail), true);
    assert.equal(shouldContinueInterruptedTurn(assistantToolCall), true);
    assert.equal(shouldContinueInterruptedTurn(toolResultTail), true);
    assert.equal(shouldContinueInterruptedTurn(metadataTail), false);
    assert.deepEqual(listContinuableInterruptedTurnSessionFiles(dir), [
      assistantToolCall,
      toolResultTail,
      userTail,
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("terminal non-message entries after messages prevent restart recovery", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-tail-"));
  try {
    const abortedAfterMessage = path.join(dir, "aborted-after-message.jsonl");
    const completedAfterToolCall = path.join(
      dir,
      "completed-after-tool-call.jsonl",
    );

    await fs.writeFile(
      abortedAfterMessage,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "stop" },
        }),
        JSON.stringify({ type: "abort" }),
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      completedAfterToolCall,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-1", name: "bash" }],
          },
        }),
        JSON.stringify({ type: "completed" }),
        "",
      ].join("\n"),
    );

    assert.equal(shouldContinueInterruptedTurn(abortedAfterMessage), false);
    assert.equal(shouldContinueInterruptedTurn(completedAfterToolCall), false);
    assert.deepEqual(listContinuableInterruptedTurnSessionFiles(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("malformed lines are ignored when finding the last valid jsonl entry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-tail-"));
  try {
    const completed = path.join(dir, "completed.jsonl");
    const interrupted = path.join(dir, "interrupted.jsonl");
    await fs.writeFile(
      completed,
      [
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "done" },
        }),
        "{not-json}",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      interrupted,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "continue" },
        }),
        "{not-json}",
        "",
      ].join("\n"),
    );

    assert.equal(shouldContinueInterruptedTurn(completed), false);
    assert.equal(shouldContinueInterruptedTurn(interrupted), true);
    assert.deepEqual(listContinuableInterruptedTurnSessionFiles(dir), [
      interrupted,
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
