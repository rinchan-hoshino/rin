import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const messageContent = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "message-content.js")).href
);

test("message content helpers extract text with optional thinking and trimming", () => {
  assert.equal(
    messageContent.extractMessageText("  raw text  "),
    "  raw text  ",
  );
  assert.equal(
    messageContent.extractMessageText([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: " done " },
    ]),
    " done ",
  );
  assert.equal(
    messageContent.extractMessageText(
      [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: " done " },
      ],
      { includeThinking: true, trim: true },
    ),
    "plan done",
  );
  assert.equal(
    messageContent.extractMessageText([
      { type: "at", attrs: { id: "1" } },
      { type: "text", attrs: { content: " first line" } },
      { type: "br" },
      {
        type: "paragraph",
        children: [
          { type: "text", attrs: { content: "second line" } },
          { type: "br" },
          { type: "text", attrs: { content: " continue" } },
        ],
      },
    ]),
    " first line\nsecond line\n continue\n",
  );
  assert.equal(
    messageContent.normalizeMessageText(
      " first line\n\n\n  second line\t \nthird line  ",
    ),
    "first line\n\nsecond line\nthird line",
  );
  assert.equal(
    messageContent.renderMessageText(
      [
        { type: "thinking", thinking: "plan " },
        { type: "at", attrs: { name: "Rin" } },
        { type: "text", attrs: { content: " ready" } },
      ],
      {
        includeThinking: true,
        renderAt: (attrs) => `@${attrs.name}`,
      },
    ),
    "plan @Rin ready",
  );
});

test("message content helpers extract only text before the first tool call", () => {
  assert.equal(
    messageContent.extractTextBeforeFirstToolCall(
      [
        { type: "text", text: "I will check this" },
        { type: "toolCall", name: "read" },
        { type: "text", text: "ignored result-bound text" },
      ],
      { trim: true },
    ),
    "I will check this",
  );
  assert.equal(
    messageContent.extractTextBeforeFirstToolCall(
      [
        { type: "thinking", thinking: "hidden plan" },
        { type: "text", text: " visible " },
        { type: "TOOLCALL", name: "bash" },
      ],
      { includeThinking: false, trim: true },
    ),
    "visible",
  );
  assert.equal(
    messageContent.extractTextBeforeFirstToolCall(
      [
        { type: "toolCall", name: "bash" },
        { type: "text", text: "late" },
      ],
      { trim: true },
    ),
    "",
  );
});

test("message content helpers keep render dispatch and child normalization rules stable", () => {
  assert.equal(messageContent.renderMessageText(null), "");
  assert.equal(messageContent.renderMessageText(undefined), "");
  assert.equal(messageContent.renderMessageText(false), "");
  assert.equal(messageContent.renderMessageText(0), "");
  assert.equal(
    messageContent.renderMessageText({ type: "paragraph", children: [] }),
    "",
  );
  assert.equal(
    messageContent.renderMessageText({
      type: "p",
      children: [{ type: "text", text: "x" }],
    }),
    "x\n",
  );
  assert.equal(
    messageContent.renderMessageText(
      { type: "text", text: " x " },
      {
        normalizeChildren: (text) => text.trim().toUpperCase(),
      },
    ),
    " x ",
  );
  assert.equal(
    messageContent.renderMessageText(
      {
        type: "paragraph",
        children: [
          { type: "text", text: " x " },
          { type: "at", attrs: { name: "Rin" } },
        ],
      },
      {
        renderAt: (attrs) => ` @${attrs.name} `,
        normalizeChildren: (text) => text.replace(/\s+/g, " ").trim(),
      },
    ),
    "x @Rin\n",
  );
});

test("message content helpers extract valid image parts and default mime types", () => {
  assert.deepEqual(
    messageContent.extractImageParts([
      { type: "text", text: "ignore" },
      { type: " IMAGE ", data: "aaa" },
      { type: "image", data: "bbb", mimeType: "image/webp" },
      { type: "image", data: "" },
    ]),
    [
      { data: "aaa", mimeType: "image/png" },
      { data: "bbb", mimeType: "image/webp" },
    ],
  );
});

test("message content helpers extract tool call parts, names, and counts", () => {
  const bashCall = { type: " toolCall ", id: "1", name: "bash" };
  const readCall = { type: "TOOLCALL", id: "2", toolName: "read" };
  const unnamedCall = { type: "toolCall", id: "3", name: "   " };

  assert.deepEqual(
    messageContent.extractToolCallParts([
      { type: "text", text: "ignore" },
      bashCall,
      readCall,
      unnamedCall,
      { type: "toolCall", id: "4", name: "bash" },
    ]),
    [
      bashCall,
      readCall,
      unnamedCall,
      { type: "toolCall", id: "4", name: "bash" },
    ],
  );
  assert.deepEqual(
    messageContent.extractToolCallNames([
      bashCall,
      readCall,
      unnamedCall,
      { type: "toolCall", id: "4", name: "bash" },
    ]),
    ["bash", "read"],
  );
  assert.equal(
    messageContent.countToolCalls([
      { type: "text", text: "ignore" },
      bashCall,
      readCall,
      unnamedCall,
    ]),
    3,
  );
  assert.deepEqual(messageContent.extractToolCallParts("not-an-array"), []);
});

test("message content helpers keep tool-call name priority and blank-name filtering stable", () => {
  assert.deepEqual(
    messageContent.extractToolCallNames([
      { type: "toolCall", name: "named", toolName: "fallback" },
      { type: "toolCall", name: "   ", toolName: "ignored-fallback" },
      { type: "toolCall", toolName: "bash" },
      { type: "toolCall", toolName: "bash" },
    ]),
    ["named", "bash"],
  );
});

test("message content helpers classify assistant finals with chat-compatible tool-call rules", () => {
  assert.equal(
    messageContent.extractAssistantFinalText({
      role: "assistant",
      content: [{ type: "text", text: " done " }],
    }),
    "done",
  );
  assert.equal(
    messageContent.isAssistantFinalMessage({
      role: "assistant",
      content: [{ type: "text", text: " done " }],
    }),
    true,
  );
  assert.equal(
    messageContent.isAssistantFinalMessage({
      role: "assistant",
      content: [
        { type: "text", text: "I will check" },
        { type: "toolCall", name: "read" },
      ],
    }),
    false,
  );
  assert.equal(
    messageContent.isAssistantFinalMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider failed",
      content: [{ type: "text", text: "provider failed" }],
    }),
    false,
  );
  assert.equal(
    messageContent.isAssistantFinalMessage({
      role: "user",
      content: [{ type: "text", text: "user text" }],
    }),
    false,
  );
});
