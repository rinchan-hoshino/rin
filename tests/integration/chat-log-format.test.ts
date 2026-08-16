import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const chatLog = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-log.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-chat-log-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("chat log rejects invalid records and fills optional defaults", async () => {
  await withTempRoot(async (root) => {
    assert.throws(
      () =>
        chatLog.appendChatLog(root, {
          timestamp: "",
          chatKey: "invalid",
          role: "user",
          text: "hello",
          messageId: "m1",
        }),
      /invalid_chatKey/,
    );
    assert.equal(
      chatLog.appendChatLog(root, {
        timestamp: "",
        chatKey: "telegram/123:456",
        role: "invalid" as any,
        text: "hello",
        messageId: "m1",
      }),
      null,
    );
    assert.equal(
      chatLog.appendChatLog(root, {
        timestamp: "",
        chatKey: "telegram/123:456",
        role: "user",
        text: " ",
        messageId: "m1",
      }),
      null,
    );
    assert.equal(
      chatLog.appendChatLog(root, {
        timestamp: "",
        chatKey: "telegram/123:456",
        role: "user",
        text: "hello",
        messageId: " ",
      }),
      null,
    );

    const appended = chatLog.appendChatLog(root, {
      timestamp: "",
      chatKey: "telegram/123:456",
      role: "assistant",
      text: "hello",
      messageId: "assistant-1",
    });
    assert.ok(appended?.entry.timestamp);
    assert.equal(appended?.entry.replyToMessageId, undefined);
    assert.equal(appended?.entry.sessionFile, undefined);
  });
});

test("chat log formatter handles user and unknown labels", () => {
  assert.equal(
    chatLog.formatChatLog([
      { timestamp: "t1", role: "user", nickname: "", text: " hello " },
      { timestamp: "", role: "" as any, text: "value" },
    ] as any),
    "[t1] user: hello\n[] assistant: value",
  );
});
