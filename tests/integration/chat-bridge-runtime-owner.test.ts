import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

await import("../support/register-chat-bridge-runtime-owner-fixture.ts");
const runtimeModule = await import(
  pathToFileURL(path.resolve("dist/core/chat-bridge/runtime.js")).href
);
const outboxModule = await import(
  pathToFileURL(path.resolve("dist/core/chat/outbox.js")).href
);

function createH() {
  return Object.assign(
    (type: string, attrs: Record<string, unknown>) => ({ type, attrs }),
    {
      text: (content: string) => ({ type: "text", attrs: { content } }),
      quote: (id: string) => ({ type: "quote", attrs: { id } }),
      at: (id: string, options?: Record<string, unknown>) => ({
        type: "at",
        attrs: { id, ...options },
      }),
      image: (src: string) => ({ type: "image", attrs: { src } }),
      file: (
        src: string,
        mimeType?: string,
        options?: Record<string, unknown>,
      ) => ({
        type: "file",
        attrs: { src, mimeType, ...options },
      }),
      video: (src: string, options?: Record<string, unknown>) => ({
        type: "video",
        attrs: { src, ...options },
      }),
      audio: (src: string, options?: Record<string, unknown>) => ({
        type: "audio",
        attrs: { src, ...options },
      }),
    },
  );
}

test("chat bridge runtime owns scoped delivery, safe facades, storage, identity, and audit", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-owner-"),
  );
  const dataDir = path.join(agentDir, "identity");
  const deliveries: Array<{ chatId: string; content: any[] }> = [];
  const bot = {
    platform: "owner",
    selfId: "bot-1",
    status: "online",
    hidden: "must-not-leak",
    sendMessage: async (chatId: string, content: any[]) => {
      deliveries.push({ chatId, content });
      return [`owner-message-${deliveries.length}`];
    },
    getUser: async () => ({ id: "hidden-method" }),
    internal: {
      client: { kind: "owner-client" },
      opaque: 7,
      lookup: async (value: string) => `looked:${value}`,
    },
  };

  try {
    const runtime = runtimeModule.createChatBridgeRuntime({
      app: { bots: [bot] },
      agentDir,
      dataDir,
      currentChatKey: "owner/bot-1:room-9",
      h: createH(),
      requestId: " request-owner ",
      sessionId: "session-owner",
      sessionFile: "/tmp/session-owner.jsonl",
    });

    assert.deepEqual(runtime.chat, {
      chatKey: "owner/bot-1:room-9",
      platform: "owner",
      botId: "bot-1",
      chatId: "room-9",
      chatType: "group",
      requestId: "request-owner",
      sessionId: "session-owner",
      sessionFile: "/tmp/session-owner.jsonl",
    });
    assert.equal(Object.isFrozen(runtime.chat), true);
    assert.equal(runtime.bot.platform, "owner");
    assert.equal(runtime.bot.status, "online");
    assert.equal(runtime.bot.hidden, undefined);
    assert.equal(runtime.bot.getUser, undefined);
    assert.equal(typeof runtime.bot.sendMessage, "function");
    assert.equal(Symbol.toStringTag in runtime.bot, false);
    assert.equal(runtime.bot[Symbol.toStringTag], "ChatBridgeFacade");
    assert.equal("sendMessage" in runtime.bot, true);
    assert.equal("getUser" in runtime.bot, false);
    assert.deepEqual(Reflect.ownKeys(runtime.bot), []);
    assert.equal(
      Object.getOwnPropertyDescriptor(runtime.bot, "anything")?.enumerable,
      false,
    );
    assert.equal(runtime.internal.client.kind, "owner-client");
    assert.equal(runtime.internal.opaque, undefined);
    assert.equal(await runtime.internal.lookup("x"), "looked:x");

    const first = await runtime.helpers.send("owner text");
    assert.deepEqual(first, ["owner-message-1"]);
    const imagePath = path.join(agentDir, "owner.png");
    const audioPath = path.join(agentDir, "owner.ogg");
    await fs.writeFile(imagePath, "image");
    await fs.writeFile(audioPath, "audio");
    const rich = await runtime.helpers.send({
      parts: [
        { type: "at", id: "42", name: "Owner" },
        { type: "markdown", content: "**owner**" },
        { type: "image", path: imagePath, mimeType: "image/png" },
        {
          type: "file",
          url: "https://example.test/owner.txt",
          name: "owner.txt",
          mimeType: "text/plain",
        },
        {
          type: "video",
          url: "https://example.test/owner.mp4",
          name: "owner.mp4",
        },
        { type: "audio", path: audioPath, mimeType: "audio/ogg" },
        { type: "sticker", url: "https://example.test/owner.webp" },
      ],
    });
    assert.deepEqual(rich, ["owner-message-2"]);
    const reply = await runtime.helpers.reply("source-message", {
      type: "text",
      text: "reply text",
    });
    assert.deepEqual(reply, ["owner-message-3"]);
    await runtime.helpers.reply("ignored-source", [
      { type: "quote", id: "kept-source" },
      { text: "fallback text" },
      { type: "unknown" },
    ]);

    assert.equal(deliveries.length, 4);
    assert.deepEqual(
      deliveries[1].content.map((item) => item.type),
      ["at", "markdown", "image", "file", "video", "audio", "sticker"],
    );
    assert.deepEqual(
      deliveries[2].content.map((item) => item.type),
      ["quote", "markdown"],
    );
    assert.equal(deliveries[2].content[1].attrs.content, "reply text");
    assert.deepEqual(
      deliveries[3].content.map((item) => item.type),
      ["quote", "markdown"],
    );
    assert.equal(deliveries[3].content[0].attrs.id, "kept-source");
    assert.equal(deliveries[3].content[1].attrs.content, "fallback text");
    assert.equal(
      await (runtimeModule as any).__rinOwnerWaitForOutboxDelivery(
        agentDir,
        "missing",
        1,
      ),
      null,
    );
    const failedId = outboxModule.enqueueChatOutboxPayload(
      agentDir,
      {
        createdAt: new Date().toISOString(),
        chatKey: "owner/bot-1:room-9",
        parts: [{ type: "text", text: "owner failed" }],
      },
      { id: "owner-failed-outbox", deliveryKind: "generic" },
    );
    const failedItem = outboxModule.readChatOutboxItemById(
      agentDir,
      failedId,
    ).item;
    outboxModule.writeChatOutboxItem(agentDir, {
      ...failedItem,
      status: "failed",
      lastError: "owner outbox failed",
      failedAt: new Date().toISOString(),
    });
    await assert.rejects(
      () =>
        (runtimeModule as any).__rinOwnerWaitForOutboxDelivery(
          agentDir,
          failedId,
          10,
        ),
      /owner outbox failed/,
    );

    await assert.rejects(
      () => runtime.helpers.send([{ type: "at", name: "missing" }]),
      /chat_bridge_at_id_required/,
    );
    await assert.rejects(
      () => runtime.helpers.send([]),
      /chat_bridge_send_empty/,
    );
    await assert.rejects(
      () => runtime.helpers.send({ type: "unknown" }),
      /chat_bridge_send_empty/,
    );

    const saved = runtime.identity.setTrust({
      userId: "42",
      trust: "TRUSTED",
      name: "Owner",
    });
    assert.equal(saved.trust, "TRUSTED");
    assert.equal(runtime.identity.getTrust("42"), "TRUSTED");
    assert.equal(runtime.identity.getTrust("missing", "other"), "OTHER");

    const stored = runtime.store.getMessage("owner-message-1");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].text, "owner text");
    assert.deepEqual(
      runtime.store.getMessage("missing", "owner/bot-1:room-9"),
      [],
    );
    const emptyLog = runtime.store.listLog("2099-01-01");
    assert.deepEqual(emptyLog.entries, []);
    assert.match(emptyLog.filePath, /room-9\/2099-01-01\.txt$/);
    const otherLog = runtime.store.listLog("2099-01-01", "owner/bot-1:other");
    assert.deepEqual(otherLog.entries, []);
    assert.match(otherLog.filePath, /other\/2099-01-01\.txt$/);

    const sameScope = runtime.helpers.useChat("owner/bot-1:room-9");
    assert.equal(sameScope.helpers, runtime.helpers);
    const otherScope = runtime.helpers.useChat("owner/bot-1:other");
    assert.equal(otherScope.chat.chatId, "other");
    assert.notEqual(otherScope.helpers, runtime.helpers);
    assert.equal(runtime.helpers.serialize({ owner: true }).owner, true);

    const auditPath = runtimeModule.appendChatBridgeAudit(agentDir, {
      kind: "owner-audit",
    });
    assert.equal(auditPath.endsWith(".jsonl"), true);
    assert.match(await fs.readFile(auditPath, "utf8"), /owner-audit/);

    assert.throws(
      () => runtime.helpers.useChat(""),
      /chat_bridge_chat_required/,
    );
    assert.throws(() => runtime.helpers.useChat("invalid"), /invalid_chatKey/);
    assert.throws(
      () => runtime.helpers.useChat("missing/bot:room"),
      /no_bot_for_platform:missing\/bot/,
    );

    const nullRuntime = runtimeModule.createChatBridgeRuntime({
      app: { bots: [bot] },
      agentDir,
      dataDir,
      currentChatKey: " ",
      h: createH(),
      requestId: " ",
    });
    assert.equal(nullRuntime.chat, null);
    assert.equal(nullRuntime.bot, undefined);
    assert.equal(nullRuntime.internal, undefined);
    assert.equal(nullRuntime.store, undefined);
    assert.equal(nullRuntime.identity, undefined);
    assert.equal(nullRuntime.helpers.currentChatKey, undefined);
    assert.throws(
      () => nullRuntime.helpers.send("x"),
      /chat_bridge_chat_required/,
    );
    assert.throws(
      () => nullRuntime.helpers.reply("id", "x"),
      /chat_bridge_chat_required/,
    );
    assert.deepEqual(nullRuntime.helpers.serialize([1, 2]), [1, 2]);
    assert.equal(
      nullRuntime.helpers.useChat("owner/bot-1:room-9").chat.chatId,
      "room-9",
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
