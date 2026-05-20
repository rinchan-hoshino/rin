import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const turnResult = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "turn-result.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-result-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("turn result builder assembles text, images, and file references from the last assistant message", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "demo.txt");
    await fs.writeFile(filePath, "hello");

    const result = turnResult.buildTurnResultFromMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `done file://${filePath}`,
          },
          {
            type: "image",
            data: Buffer.from("abc").toString("base64"),
            mimeType: "image/png",
          },
        ],
      },
    ]);

    assert.deepEqual(result, {
      messages: [
        { type: "text", text: `done file://${filePath}` },
        {
          type: "image",
          data: Buffer.from("abc").toString("base64"),
          mimeType: "image/png",
        },
        { type: "file", path: filePath, name: "demo.txt" },
      ],
    });
  });
});

test("turn result builder returns empty messages when there is no assistant output", () => {
  assert.deepEqual(turnResult.buildTurnResultFromMessages([]), {
    messages: [],
  });
});

test("turn result builder ignores compaction and session summaries as non-final output", () => {
  assert.deepEqual(
    turnResult.resolveTurnCompletion({
      messages: [
        {
          type: "compaction",
          summary: "## Goal\nraw compacted summary must not be delivered",
        },
        {
          role: "compactionSummary",
          content: [
            { type: "text", text: "raw compaction summary must not leak" },
          ],
        },
        {
          role: "assistant",
          customType: "session_summary",
          content: [{ type: "text", text: "session summary must not leak" }],
        },
        {
          role: "assistant",
          summaryEntry: { id: "summary" },
          content: [{ type: "text", text: "summary entry must not leak" }],
        },
      ],
    }),
    { finalText: "", result: { messages: [] } },
  );
});

test("turn result builder ignores assistant tool-call prefaces as non-final output", () => {
  assert.deepEqual(
    turnResult.buildTurnResultFromMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will check this" },
          { type: "toolCall", name: "read", id: "call-1" },
        ],
      },
    ]),
    { messages: [] },
  );

  assert.deepEqual(
    turnResult.resolveTurnCompletion({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "working preface" },
            { type: "toolCall", name: "bash", id: "call-2" },
          ],
        },
      ],
    }),
    { finalText: "", result: { messages: [] } },
  );
});

test("turn result final text extractor returns the first non-empty text message", () => {
  assert.equal(
    turnResult.extractFinalTextFromTurnResult({
      messages: [
        null,
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "text", text: "   " },
        { type: "text", text: " final text " },
        { type: "text", text: "later text" },
      ],
    }),
    "final text",
  );
});

test("turn result final text extractor returns empty string when no text message exists", () => {
  assert.equal(
    turnResult.extractFinalTextFromTurnResult({
      messages: [{ type: "file", path: "/tmp/demo.txt", name: "demo.txt" }],
    }),
    "",
  );
  assert.equal(turnResult.extractFinalTextFromTurnResult(undefined), "");
});

test("turn completion resolver prefers canonical result text over payload finalText", () => {
  assert.deepEqual(
    turnResult.resolveTurnCompletion({
      finalText: "stale payload text",
      result: {
        messages: [{ type: "text", text: "canonical result text" }],
      },
    }),
    {
      finalText: "canonical result text",
      result: {
        messages: [{ type: "text", text: "canonical result text" }],
      },
    },
  );
});

test("turn completion resolver falls back to messages and payload text when needed", () => {
  assert.deepEqual(
    turnResult.resolveTurnCompletion({
      result: { messages: [] },
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "from session messages" }],
        },
      ],
      finalText: "payload fallback",
    }),
    {
      finalText: "from session messages",
      result: {
        messages: [{ type: "text", text: "from session messages" }],
      },
    },
  );

  assert.deepEqual(
    turnResult.resolveTurnCompletion({
      result: {
        messages: [null, { type: "file", path: "/tmp/demo.txt" }],
      },
      finalText: "payload fallback",
    }),
    {
      finalText: "payload fallback",
      result: {
        messages: [
          { type: "text", text: "payload fallback" },
          { type: "file", path: "/tmp/demo.txt" },
        ],
      },
    },
  );

  assert.deepEqual(
    turnResult.resolveTurnCompletion({
      messages: [
        { role: "assistant", content: [{ type: "image", data: "abc" }] },
      ],
      finalText: "",
    }),
    {
      finalText: "",
      result: {
        messages: [{ type: "image", data: "abc", mimeType: "image/png" }],
      },
    },
  );
});
