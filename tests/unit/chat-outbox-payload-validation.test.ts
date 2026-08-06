import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { importBuiltModule } from "../support/import-built-module.js";

const validation = await importBuiltModule<
  typeof import("../../src/core/chat/outbox-payload-validation.js")
>("dist/core/chat/outbox-payload-validation.js");

function validate(parts: any[], requireLocalFiles?: boolean) {
  return validation.validateChatOutboxPayloadParts(
    { parts },
    requireLocalFiles === undefined ? {} : { requireLocalFiles },
  );
}

test("outbox payload validation accepts every visible part contract", () => {
  const originalExistsSync = fs.existsSync;
  fs.existsSync = ((filePath: fs.PathLike) =>
    filePath === "/media/exists.png") as typeof fs.existsSync;
  try {
    assert.doesNotThrow(() =>
      validate([
        { type: "text", text: " hello " },
        { type: "markdown", text: "**hello**" },
        { type: "at", id: "owner" },
        { type: "quote", id: "message-1" },
        { type: "todo", items: [{ text: "ship" }] },
        { type: "image", path: "/media/exists.png" },
        { type: "file", url: "https://example.invalid/file" },
        { type: "video", url: "https://example.invalid/video" },
        { type: "audio", url: "https://example.invalid/audio" },
        { type: "sticker", url: "https://example.invalid/sticker" },
      ]),
    );
    assert.doesNotThrow(() =>
      validate([{ type: "image", path: "/media/missing.png" }], false),
    );
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test("outbox payload validation rejects malformed and invisible payloads", () => {
  for (const [parts, pattern] of [
    [[], /chat_outbox_empty_message/],
    [[null], /chat_outbox_empty_message/],
    [[42], /chat_outbox_invalid_part:unknown/],
    [[{ type: "text", text: " " }], /chat_outbox_empty_message/],
    [[{ type: "at", id: " " }], /chat_outbox_invalid_part:at/],
    [[{ type: "quote", id: " " }], /chat_outbox_invalid_part:quote/],
    [[{ type: "quote", id: "message-1" }], /chat_outbox_empty_message/],
    [[{ type: "todo", items: [] }], /chat_outbox_invalid_part:todo/],
    [[{ type: "unknown" }], /chat_outbox_invalid_part:unknown/],
    [[{ type: "image" }], /chat_outbox_invalid_part:image/],
    [
      [{ type: "image", path: "/media/missing.png" }],
      /chat_outbox_media_missing:image/,
    ],
  ] as const) {
    assert.throws(() => validate(parts as any[]), pattern);
  }
  assert.throws(
    () => validation.validateChatOutboxPayloadParts({ parts: undefined }),
    /chat_outbox_empty_message/,
  );
});
