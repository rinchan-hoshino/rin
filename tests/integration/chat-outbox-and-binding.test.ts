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
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
);
const boot = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "boot.js")).href
);
const support = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href
);
const transport = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "transport.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-outbox-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(assertion, timeoutMs = 1000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) throw lastError;
}

test("chat outbox async dispatch is selected by platform list", () => {
  assert.equal(
    transport.chatOutboxPayloadUsesAsyncDispatch({ chatKey: "onebot/1:2" }),
    true,
  );
  assert.equal(
    transport.chatOutboxPayloadUsesAsyncDispatch({ chatKey: "telegram/1:2" }),
    true,
  );
  assert.equal(
    transport.chatOutboxPayloadUsesAsyncDispatch({ chatKey: "unknown/1:2" }),
    false,
  );
});

test("chat outbox rejects SDK-style empty payloads before enqueue", async () => {
  await withTempDir(async (dir) => {
    assert.throws(
      () => outbox.enqueueChatOutboxPayload(dir, { chatKey: "telegram/777:1" }),
      /chat_outbox_invalid_payload/,
    );
    assert.deepEqual(outbox.listChatOutboxItems(dir), []);
  });
});

test("chat assistant delivery stores session only for conversation binding", async () => {
  await withTempDir(async (dir) => {
    transport.recordDeliveredAssistantMessages(dir, {
      chatKey: "telegram/777:1",
      deliveryResult: ["m1"],
      text: "tool send",
      sessionFile: "/tmp/ignored.jsonl",
    });
    transport.recordDeliveredAssistantMessages(dir, {
      chatKey: "telegram/777:1",
      deliveryResult: ["m2"],
      text: "normal reply",
      sessionFile: "/tmp/kept.jsonl",
      sessionBinding: "conversation",
    });

    assert.equal(
      messageStore.getChatMessage(dir, "telegram/777:1", "m1")?.sessionFile,
      undefined,
    );
    assert.equal(
      messageStore.getChatMessage(dir, "telegram/777:1", "m2")?.sessionFile,
      "/tmp/kept.jsonl",
    );
  });
});

test("chat state paths stay stable", () => {
  const statePath = support.chatStatePath("/tmp/rin-data", "telegram/777:1");
  assert.ok(
    statePath.endsWith(
      path.join("chat", "session-state", "telegram", "777", "1", "state.json"),
    ),
  );
});

test("chat state rejects unqualified telegram chat keys", () => {
  assert.throws(
    () => support.chatStatePath("/tmp/rin-data", "telegram:1"),
    /invalid_chatKey:telegram:1/,
  );
});

test("chat state discovery only includes bot-qualified state dirs", async () => {
  await withTempDir(async (dir) => {
    const chatsRoot = path.join(dir, "chats");
    await fs.mkdir(path.join(chatsRoot, "telegram", "legacy-chat"), {
      recursive: true,
    });
    await fs.mkdir(path.join(chatsRoot, "telegram", "777", "scoped-chat"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(chatsRoot, "telegram", "legacy-chat", "state.json"),
      "{}\n",
    );
    await fs.writeFile(
      path.join(chatsRoot, "telegram", "777", "scoped-chat", "state.json"),
      "{}\n",
    );

    assert.deepEqual(support.listChatStateFiles(chatsRoot), [
      {
        chatKey: "telegram/777:scoped-chat",
        statePath: path.join(
          chatsRoot,
          "telegram",
          "777",
          "scoped-chat",
          "state.json",
        ),
      },
    ]);
  });
});
