import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ChatMessagePart } from "../../dist/core/rin-lib/chat-outbox-contract.js";
import { listChatMessages } from "../../dist/core/chat/message-store.js";
import * as transport from "../../dist/core/chat/transport.js";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function withTransportRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-transport-owner-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function createH() {
  const h: any = (type: string, attrs: Record<string, unknown> = {}) => ({
    type,
    attrs,
    children: [],
  });
  h.markdown = (text: string) => ({ type: "markdown", attrs: { text } });
  h.quote = (id: string) => ({ type: "quote", attrs: { id } });
  h.at = (id: string, options?: Record<string, unknown>) => ({
    type: "at",
    attrs: { id, ...options },
  });
  h.file = (
    src: string,
    mimeType?: string,
    options?: Record<string, unknown>,
  ) => ({
    type: "file",
    attrs: { src, mimeType, ...options },
  });
  return h;
}

function createBot(
  overrides: Record<string, unknown> = {},
  platform = "telegram",
  selfId = "owner-bot",
) {
  const calls: Array<[string, ...unknown[]]> = [];
  const bot: any = {
    platform,
    selfId,
    internal: {},
    sendMessage(chatId: string, content: unknown, options: unknown) {
      calls.push(["sendMessage", chatId, content, options]);
      return Promise.resolve(["message-1"]);
    },
    ...overrides,
  };
  return { bot, calls, app: { bots: [bot] } };
}

const h = createH();

test("chat transport resolves reaction capabilities across platform adapters", async () => {
  const telegram = createBot();
  telegram.bot.internal.sendChatAction = async (payload: unknown) => {
    telegram.calls.push(["sendChatAction", payload]);
  };
  assert.equal(
    await transport.sendTyping(
      telegram.app,
      "telegram/owner-bot:owner-chat",
      h,
    ),
    true,
  );
  assert.deepEqual(telegram.calls[0], [
    "sendChatAction",
    { chat_id: "owner-chat", action: "typing" },
  ]);

  const fallbackTyping = createBot();
  fallbackTyping.bot.internal.sendChatAction = async () => {
    throw new Error("unsupported");
  };
  fallbackTyping.bot.internal.sendTyping = async (chatId: string) => {
    fallbackTyping.calls.push(["sendTyping", chatId]);
  };
  assert.equal(
    await transport.sendTyping(
      fallbackTyping.app,
      "telegram/owner-bot:owner-chat",
      h,
    ),
    true,
  );
  assert.deepEqual(fallbackTyping.calls, [["sendTyping", "owner-chat"]]);
  assert.equal(
    await transport.sendTyping(
      { bots: [] },
      "telegram/owner-bot:owner-chat",
      h,
    ),
    false,
  );
  assert.equal(await transport.sendTyping(telegram.app, "invalid", h), false);

  const discord = createBot({}, "discord");
  discord.bot.internal.setMessageReaction = async (payload: unknown) => {
    discord.calls.push(["setMessageReaction", payload]);
  };
  assert.equal(
    await transport.sendReaction(
      discord.app,
      "discord/owner-bot:owner-chat",
      "42",
      "🔥",
    ),
    true,
  );
  assert.equal(discord.calls.length, 1);
  assert.equal(
    await transport.sendReaction(
      discord.app,
      "discord/owner-bot:owner-chat",
      "",
      "🔥",
    ),
    false,
  );

  const onebotPrivate = createBot({}, "onebot");
  assert.equal(
    await transport.sendReaction(
      onebotPrivate.app,
      "onebot/owner-bot:private:owner",
      "42",
      "🔥",
    ),
    false,
  );

  const reaction = createBot({
    async createReaction(...args: unknown[]) {
      reaction.calls.push(["create", ...args]);
    },
    async deleteReaction(...args: unknown[]) {
      reaction.calls.push(["delete", ...args]);
    },
  });
  assert.equal(
    await transport.sendReaction(
      reaction.app,
      "telegram/owner-bot:owner-chat",
      "7",
      "🤔",
    ),
    true,
  );
  assert.equal(
    await transport.clearReaction(
      reaction.app,
      "telegram/owner-bot:owner-chat",
      "7",
      "🤔",
    ),
    true,
  );
  assert.equal(
    await transport.clearReaction(
      { bots: [] },
      "telegram/owner-bot:x",
      "1",
      "🤔",
    ),
    false,
  );
  assert.equal(
    await transport.clearReaction(
      reaction.app,
      "telegram/owner-bot:owner-chat",
      "7",
      " ",
    ),
    false,
  );
  assert.equal(
    await transport.clearReaction(
      onebotPrivate.app,
      "onebot/owner-bot:private:owner",
      "7",
      "🤔",
    ),
    false,
  );

  const internalDelete = createBot();
  internalDelete.bot.internal.deleteOwnReaction = async (
    ...args: unknown[]
  ) => {
    internalDelete.calls.push(["internal-delete", ...args]);
  };
  assert.equal(
    await transport.clearReaction(
      internalDelete.app,
      "telegram/owner-bot:owner-chat",
      "8",
      "🤔",
    ),
    true,
  );

  const setFallback = createBot();
  setFallback.bot.internal.setMessageReaction = async (payload: unknown) => {
    setFallback.calls.push(["set", payload]);
  };
  assert.equal(
    await transport.clearReaction(
      setFallback.app,
      "telegram/owner-bot:owner-chat",
      "9",
      "🤔",
    ),
    true,
  );

  let deleteAttempts = 0;
  const retryDelete = createBot({
    async deleteReaction() {
      deleteAttempts += 1;
      if (deleteAttempts === 1) throw new Error("retry delete");
    },
  });
  assert.equal(
    await transport.clearReaction(
      retryDelete.app,
      "telegram/owner-bot:owner-chat",
      "10",
      "🤔",
    ),
    true,
  );
  assert.equal(deleteAttempts, 2);
  assert.equal(
    await transport.clearReaction(
      createBot().app,
      "telegram/owner-bot:owner-chat",
      "11",
      "🤔",
    ),
    false,
  );
});

test("chat transport converts every supported outbound part into native nodes", async () => {
  await withTransportRoot(async (root) => {
    const imagePath = path.join(root, "owner.png");
    const filePath = path.join(root, "owner.txt");
    await fs.writeFile(imagePath, "image");
    await fs.writeFile(filePath, "file");

    assert.equal(
      await transport.messagePartToNode({ type: "text", text: " " }, h),
      null,
    );
    assert.deepEqual(
      await transport.messagePartToNode({ type: "markdown", text: "owner" }, h),
      { type: "markdown", attrs: { text: "owner" } },
    );
    const functionOnlyH: any = (type: string, attrs: unknown) => ({
      type,
      attrs,
    });
    assert.deepEqual(
      await transport.messagePartToNode(
        { type: "text", text: "function fallback" },
        functionOnlyH,
      ),
      { type: "markdown", attrs: { content: "function fallback" } },
    );
    assert.deepEqual(
      await transport.messagePartToNode(
        { type: "text", text: "object fallback" },
        {},
      ),
      { type: "markdown", attrs: { content: "object fallback" } },
    );
    assert.deepEqual(
      await transport.messagePartToNode(
        { type: "at", id: "42", name: "Owner" },
        h,
      ),
      { type: "at", attrs: { id: "42", name: "Owner" } },
    );
    assert.deepEqual(
      await transport.messagePartToNode({ type: "at", id: "43" }, h),
      { type: "at", attrs: { id: "43" } },
    );
    await assert.rejects(
      () => transport.messagePartToNode({ type: "at", id: "" }, h),
      /chat_outbox_invalid_part:at/,
    );
    assert.deepEqual(
      await transport.messagePartToNode({ type: "quote", id: "reply" }, h),
      { type: "quote", attrs: { id: "reply" } },
    );
    assert.deepEqual(
      await transport.messagePartToNode(
        {
          type: "todo",
          title: " Owner tasks ",
          items: [
            { text: " first ", done: true },
            { text: " ", done: false },
          ],
        },
        h,
      ),
      {
        type: "todo",
        attrs: {
          title: "Owner tasks",
          items: [{ text: "first", done: true }],
        },
        children: [],
      },
    );
    assert.deepEqual(
      await transport.messagePartToNode(
        { type: "todo", items: undefined } as any,
        h,
      ),
      {
        type: "todo",
        attrs: { title: undefined, items: [] },
        children: [],
      },
    );

    for (const type of ["image", "video", "audio", "sticker"] as const) {
      const node = await transport.messagePartToNode(
        type === "image"
          ? { type, path: imagePath }
          : {
              type,
              url: `https://example.test/${type}`,
              name: `owner-${type}`,
            },
        h,
      );
      assert.equal((node as any).type, type);
      if (type === "image") {
        assert.equal((node as any).attrs.mimeType, "image/png");
        assert.match((node as any).attrs.src, /^file:/);
      }
      await assert.rejects(
        () => transport.messagePartToNode({ type } as any, h),
        new RegExp(`chat_outbox_invalid_part:${type}`),
      );
    }

    assert.equal(
      (
        (await transport.messagePartToNode(
          { type: "file", path: filePath },
          h,
        )) as any
      ).attrs.name,
      "owner.txt",
    );
    assert.equal(
      (
        (await transport.messagePartToNode(
          {
            type: "file",
            url: "https://example.test/owner.bin",
            name: "owner.bin",
            mimeType: "application/octet-stream",
          },
          h,
        )) as any
      ).attrs.name,
      "owner.bin",
    );
    assert.deepEqual(
      await transport.messagePartToNode(
        { type: "file", url: "https://example.test/unnamed.bin" },
        h,
      ),
      {
        type: "file",
        attrs: {
          src: "https://example.test/unnamed.bin",
          mimeType: undefined,
        },
      },
    );
    await assert.rejects(
      () => transport.messagePartToNode({ type: "file" }, h),
      /chat_outbox_invalid_part:file/,
    );
  });
});

test("chat transport sends text and local assets with optional reply quoting", async () => {
  await withTransportRoot(async (root) => {
    const localPath = path.join(root, "owner.dat");
    await fs.writeFile(localPath, "owner");
    const { app, calls } = createBot();
    assert.deepEqual(
      await transport.sendText(
        app,
        "telegram/owner-bot:owner-chat",
        "Owner text",
        h,
        "reply-1",
        { silent: true },
      ),
      ["message-1"],
    );
    assert.equal((calls[0][2] as any[])[0].type, "quote");
    assert.deepEqual(calls[0][3], { silent: true });
    assert.deepEqual(
      await transport.sendImageFile(
        app,
        "telegram/owner-bot:owner-chat",
        localPath,
        h,
        "image/webp",
      ),
      ["message-1"],
    );
    assert.match(((calls[1][2] as any[])[0] as any).attrs.src, /^file:/);
    assert.deepEqual(
      await transport.sendGenericFile(
        app,
        "telegram/owner-bot:owner-chat",
        localPath,
        h,
      ),
      ["message-1"],
    );
    assert.equal(((calls[2][2] as any[])[0] as any).attrs.name, "owner.dat");
    assert.throws(
      () =>
        transport.sendText(
          { bots: [] },
          "telegram/owner-bot:owner-chat",
          "owner",
          h,
        ),
      /no_bot_for_platform/,
    );
    assert.throws(
      () => transport.sendText(app, "invalid", "owner", h),
      /invalid_chatKey/,
    );
  });
});

test("chat outbox delivery exposes dispatch, persists records, and validates results", async () => {
  await withTransportRoot(async (root) => {
    let resolveSend!: (ids: string[]) => void;
    let resolveDispatched!: () => void;
    const sendPromise: any = new Promise<string[]>((resolve) => {
      resolveSend = resolve;
    });
    sendPromise.dispatched = new Promise<void>((resolve) => {
      resolveDispatched = resolve;
    });
    const { app, calls } = createBot({
      sendMessage(chatId: string, content: unknown, options: unknown) {
        calls.push(["sendMessage", chatId, content, options]);
        resolveDispatched();
        return sendPromise;
      },
    });
    const payload = {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/owner-bot:owner-chat",
      deliveryKind: "interim" as const,
      coalesceWithWorkingMessage: true,
      sessionBinding: "conversation" as const,
      sessionFile: path.join(root, "sessions", "owner.jsonl"),
      parts: [
        { type: "quote" as const, id: "reply-owner" },
        { type: "text" as const, text: "Owner final" },
        { type: "todo" as const, items: [{ text: "Check", done: false }] },
        { type: "at" as const, id: "42", name: "Owner" },
      ],
    };
    const delivery = transport.sendOutboxPayload(
      app,
      root,
      payload,
      h,
      "outbox-owner",
    );
    const dispatch = transport.getChatDeliveryDispatchPromise(delivery);
    assert.ok(dispatch);
    await dispatch;
    assert.equal(
      transport.getChatOutboxDispatchPromise(payload, delivery),
      dispatch,
    );
    assert.equal((calls[0][2] as any[])[0].type, "quote");
    assert.deepEqual(calls[0][3], {
      deliveryKind: "interim",
      coalesceWithWorkingMessage: true,
      outboxId: "outbox-owner",
    });
    resolveSend([" delivered-1 ", "", "delivered-2"]);
    assert.deepEqual(await delivery, ["delivered-1", "delivered-2"]);
    const stored = listChatMessages(root, {
      chatKey: payload.chatKey,
      limit: 10,
    });
    assert.deepEqual(stored.map((item) => item.messageId).sort(), [
      "delivered-1",
      "delivered-2",
    ]);
    assert.equal(stored[0].deliveryKind, "interim");
    assert.equal(stored[0].replyToMessageId, "reply-owner");
    assert.equal(stored[0].sessionFile, "owner.jsonl");

    assert.equal(transport.chatOutboxPayloadUsesAsyncDispatch(payload), true);
    assert.equal(
      transport.chatOutboxPayloadUsesAsyncDispatch({
        chatKey: "custom/owner-bot:chat",
      }),
      false,
    );
    assert.equal(
      transport.chatOutboxPayloadUsesAsyncDispatch(undefined),
      false,
    );
    assert.equal(transport.getChatDeliveryDispatchPromise({}), undefined);
    assert.equal(
      transport.getChatOutboxDispatchPromise(
        { ...payload, chatKey: "custom/owner-bot:chat" },
        delivery,
      ),
      undefined,
    );

    await assert.rejects(
      transport.sendOutboxPayload(
        app,
        root,
        { ...payload, replyToMessageId: "", parts: [] },
        h,
      ),
      /chat_outbox_empty_message/,
    );
    await assert.rejects(
      transport.sendOutboxPayload(
        app,
        root,
        {
          ...payload,
          replyToMessageId: "",
          parts: [{ type: "text", text: " " }],
        },
        h,
      ),
      /chat_outbox_empty_message/,
    );
    await assert.rejects(
      transport.sendOutboxPayload(
        app,
        root,
        { ...payload, replyToMessageId: "", parts: undefined as any },
        h,
      ),
      /chat_outbox_empty_message/,
    );
    const emptyResultBot = createBot({
      sendMessage() {
        return [];
      },
    });
    await assert.rejects(
      transport.sendOutboxPayload(emptyResultBot.app, root, payload, h),
      /chat_send_message_empty_result/,
    );
    const invalidResultBot = createBot({
      sendMessage() {
        return "not-an-array";
      },
    });
    await assert.rejects(
      transport.sendOutboxPayload(invalidResultBot.app, root, payload, h),
      /chat_send_message_empty_result/,
    );
    const blankResultBot = createBot({
      sendMessage() {
        return ["", " "];
      },
    });
    await assert.rejects(
      transport.sendOutboxPayload(blankResultBot.app, root, payload, h),
      /chat_send_message_empty_result/,
    );
    assert.throws(
      () =>
        transport.sendOutboxPayload(
          app,
          root,
          { ...payload, chatKey: "", replyToMessageId: "", parts: [] },
          h,
        ),
      /invalid_chatKey:/,
    );
  });
});

test("chat outbox supports synchronous adapters and metadata-only native parts", async () => {
  await withTransportRoot(async (root) => {
    const custom = createBot({}, "custom");
    const payload = {
      createdAt: new Date().toISOString(),
      chatKey: "custom/owner-bot:owner-chat",
      parts: [
        { type: "at" as const, id: "42" },
        {
          type: "image" as const,
          url: "https://example.test/owner.png",
        },
        { type: "file" as const, url: "https://example.test/owner.bin" },
      ],
    };
    const delivery = transport.sendOutboxPayload(custom.app, root, payload, h);
    assert.equal(transport.getChatDeliveryDispatchPromise(delivery), undefined);
    assert.deepEqual(await delivery, ["message-1"]);
    assert.deepEqual(custom.calls[0][3], { deliveryKind: "final" });

    const stored = listChatMessages(root, {
      chatKey: payload.chatKey,
      limit: 10,
    });
    assert.equal(stored[0].deliveryKind, "final");
    assert.equal(stored[0].sessionFile, undefined);
    assert.match(stored[0].rawContent ?? "", /\[@\] 42/);
    assert.match(stored[0].rawContent ?? "", /\[#image\]/);
    assert.match(stored[0].rawContent ?? "", /\[#file\]/);

    await assert.rejects(
      transport.validateChatOutboxPayloadForDispatch(
        {
          ...payload,
          parts: [{ type: "todo" as any, items: [] }],
        },
        h,
      ),
      /chat_outbox_invalid_part:todo/,
    );
  });
});

test("assistant delivery recording validates chat identity and links explicit sessions", async () => {
  await withTransportRoot(async (root) => {
    assert.deepEqual(
      transport.recordDeliveredAssistantMessages(root, {
        chatKey: "",
        deliveryResult: ["owner"],
      }),
      [],
    );
    assert.deepEqual(
      transport.recordDeliveredAssistantMessages(root, {
        chatKey: "invalid",
        deliveryResult: ["owner"],
      }),
      [],
    );
    assert.deepEqual(
      transport.recordDeliveredAssistantMessages(root, {
        chatKey: "telegram/owner-bot:owner-chat",
        deliveryResult: [],
      }),
      [],
    );
    const sessionFile = path.join(root, "sessions", "explicit.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "owner session\n");
    assert.deepEqual(
      transport.recordDeliveredAssistantMessages(root, {
        chatKey: "telegram/owner-bot:-100",
        deliveryResult: [" owner-1 ", "", "owner-2"],
        deliveryKind: "error",
        text: " owner text ",
        rawContent: "",
        replyToMessageId: " reply ",
        sessionFile,
        sessionBinding: "conversation",
      }),
      ["owner-1", "owner-2"],
    );
    const messages = listChatMessages(root, {
      chatKey: "telegram/owner-bot:-100",
      limit: 10,
    });
    assert.equal(messages[0].chatType, "group");
    assert.equal(messages[0].rawContent, "owner text");
    assert.equal(messages[0].deliveryKind, "error");
    assert.equal(messages[0].sessionFile, "explicit.jsonl");

    assert.deepEqual(
      transport.recordDeliveredAssistantMessages(root, {
        chatKey: "telegram/owner-bot:owner-chat",
        deliveryResult: "not-an-array" as any,
      }),
      [],
    );
    assert.deepEqual(
      transport.recordDeliveredAssistantMessages(root, {
        chatKey: "telegram/owner-bot:owner-chat",
        deliveryResult: ["plain-owner"],
        text: "",
        rawContent: "",
        sessionBinding: "conversation",
      }),
      ["plain-owner"],
    );
    let plain = listChatMessages(root, {
      chatKey: "telegram/owner-bot:owner-chat",
      limit: 10,
    });
    const plainOwner = plain.find((item) => item.messageId === "plain-owner");
    assert.equal(plainOwner?.deliveryKind, "final");
    assert.equal(plainOwner?.text, undefined);
    assert.equal(plainOwner?.rawContent, undefined);
    assert.equal(plainOwner?.sessionFile, undefined);

    transport.recordDeliveredAssistantMessages(root, {
      chatKey: "telegram/owner-bot:owner-chat",
      deliveryResult: ["linked-source"],
      text: "source",
      sessionFile,
      sessionBinding: "conversation",
    });
    transport.recordDeliveredAssistantMessages(root, {
      chatKey: "telegram/owner-bot:owner-chat",
      deliveryResult: ["linked-reply"],
      text: "reply",
      replyToMessageId: "linked-source",
      sessionBinding: "conversation",
    });
    plain = listChatMessages(root, {
      chatKey: "telegram/owner-bot:owner-chat",
      limit: 10,
    });
    assert.equal(
      plain.find((item) => item.messageId === "linked-reply")?.sessionFile,
      "explicit.jsonl",
    );
  });
});

test("image payload compression preserves small and invalid data and reads attachments", async () => {
  await withTransportRoot(async (root) => {
    const small = Buffer.from("owner-small");
    const unchanged = transport.compressImageForModelPayload(small, {
      maxBytes: 100,
    });
    assert.equal(unchanged.data, small);
    assert.equal(unchanged.mimeType, "");
    const invalid = transport.compressImageForModelPayload(small, {
      force: true,
      maxBytes: -1,
      maxEdge: 0,
      minEdge: Number.NaN,
    });
    assert.deepEqual(invalid, { data: small, mimeType: "" });

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const compressed = transport.compressImageForModelPayload(png, {
      force: true,
      maxBytes: 10_000,
      maxEdge: 1,
      minEdge: 1,
    });
    assert.equal(compressed.data.length > 0, true);
    assert.equal(["", "image/jpeg"].includes(compressed.mimeType), true);

    const imagePath = path.join(root, "owner.png");
    await fs.writeFile(imagePath, png);
    const image = await transport.attachmentToImageContent(
      imagePath,
      "image/png",
      { maxBytes: 10_000 },
    );
    assert.equal(image.type, "image");
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").equals(png), true);

    const restored = await transport.restorePromptParts({
      text: "owner prompt",
      attachments: [
        { kind: "image", path: imagePath, name: "owner.png" },
        { kind: "file", path: path.join(root, "missing.txt"), name: "missing" },
      ],
      startedAt: Date.now(),
    });
    assert.equal(restored.text, "owner prompt");
    assert.deepEqual(restored.images, []);
    assert.deepEqual(
      restored.attachments.map((item) => item.name),
      ["owner.png"],
    );
    assert.equal(transport.buildPromptText("exact prompt", []), "exact prompt");
  });
});

test("chat transport owner directly covers outbound record and image sizing helpers", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const rootDir = process.env.RIN_REPO_ROOT;
    const mod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "transport.js")).href);
    const build = mod.__rinOwnerBuildOutboundMessageRecord;
    const record = build([
      { type: "quote", id: " quoted " },
      { type: "text", text: " text " },
      { type: "markdown", text: " markdown " },
      { type: "todo", items: [{ text: "first", done: false }, { text: "second", done: true }] },
      { type: "image", path: "/owner.png" },
    ]);
    assert.equal(record.replyToMessageId, "quoted");
    assert.match(record.logText, /text/);
    assert.match(record.logText, /first/);
    const summaryOnly = build([{ type: "image", path: "/owner.png" }]);
    assert.equal(summaryOnly.logText, "");
    assert.equal(typeof summaryOnly.text, "string");
    assert.equal(mod.__rinOwnerNormalizePositiveInteger("bad", 7), 7);
    assert.equal(mod.__rinOwnerNormalizePositiveInteger(-1, 8), 8);
    assert.equal(mod.__rinOwnerNormalizePositiveInteger(4.9, 8), 4);
    assert.deepEqual(mod.__rinOwnerDimensionsForMaxEdge(4, 3, 8), { width: 4, height: 3 });
    assert.deepEqual(mod.__rinOwnerDimensionsForMaxEdge(8, 4, 4), { width: 4, height: 2 });
    const first = Buffer.from("123");
    const shorter = Buffer.from("1");
    assert.equal(mod.__rinOwnerMaybeKeepBestCandidate(null, Buffer.from("12345"), 4), null);
    assert.equal(mod.__rinOwnerMaybeKeepBestCandidate(null, first, 4), first);
    assert.equal(mod.__rinOwnerMaybeKeepBestCandidate(first, shorter, 4), shorter);
    assert.equal(mod.__rinOwnerMaybeKeepBestCandidate(shorter, first, 4), shorter);
  `;
  await execFileAsync(
    process.execPath,
    [
      "--import",
      path.join(
        rootDir,
        "tests",
        "support",
        "register-chat-transport-private-owner-fixture.mjs",
      ),
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: rootDir,
      env: { ...process.env, RIN_REPO_ROOT: rootDir },
      timeout: 10_000,
    },
  );
});
