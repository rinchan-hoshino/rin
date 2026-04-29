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
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
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

test("chat outbox enqueues payload on disk", async () => {
  await withTempDir(async (dir) => {
    const filePath = outbox.enqueueChatOutboxPayload(dir, {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/777:1",
      text: "hello",
    });
    const stat = await fs.stat(filePath);
    assert.ok(stat.isFile());
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
      path.join("chats", "telegram", "777", "1", "state.json"),
    ),
  );
});

test("chat state rejects legacy telegram chat keys without bot id", () => {
  assert.throws(
    () => support.chatStatePath("/tmp/rin-data", "telegram:1"),
    /invalid_chatKey:telegram:1/,
  );
});

test("chat state discovery ignores legacy telegram state dirs", async () => {
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
