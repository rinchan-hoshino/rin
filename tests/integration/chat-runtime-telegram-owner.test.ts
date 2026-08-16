import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  logger,
  makeRuntime,
  owner,
  resetOwner,
  withTempDir,
} from "../support/chat-runtime-index-owner-harness.ts";

const runtime = Object.assign(
  {},
  await import(
    pathToFileURL(path.resolve("dist/core/chat-runtime/app.js")).href
  ),
  await import(
    pathToFileURL(path.resolve("dist/core/chat-runtime/registry.js")).href
  ),
  await import(
    pathToFileURL(path.resolve("dist/core/chat-runtime/telegram.js")).href
  ),
);
const inbox = await import(
  pathToFileURL(path.resolve("dist/core/chat/inbox.js")).href
);

test("telegram adapter owns bootstrap, cursor recovery, parsing, media cache, and API fallbacks", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const updates = [
      [
        {
          update_id: 10,
          message: {
            message_id: 20,
            date: 100,
            chat: { id: 30, type: "private" },
            from: { id: 40, username: "owner" },
            text: "@rin hello",
            entities: [{ type: "mention", offset: 0, length: 4 }],
          },
        },
      ],
      [],
    ];
    owner.apiHandlers.deleteWebhook = async (payload: any) => {
      assert.deepEqual(payload, { drop_pending_updates: false });
      return true;
    };
    owner.apiHandlers.getMe = async () => ({
      id: 1,
      username: "rin",
      first_name: "Rin",
      last_name: "Chan",
    });
    owner.apiHandlers.getUpdates = async () => updates.shift() || [];
    owner.apiHandlers.sendMessage = async (payload: any) => ({
      message_id: payload.parse_mode ? 50 : 51,
    });
    owner.apiHandlers.editMessageText = async (payload: any) => payload;
    owner.apiHandlers.deleteMessage = async () => true;
    owner.apiHandlers.setMessageReaction = async () => true;
    owner.apiHandlers.getChat = async (payload: any) => payload;
    owner.apiHandlers.getChatMember = async (payload: any) => payload;

    const { app, adapter, bot } = makeRuntime(runtime, directory, {
      key: "telegram",
      name: "Telegram",
      config: { token: "1:owner" },
    });
    assert.equal(bot.internal[Symbol("owner")], undefined);
    adapter.pollLoop = async () => {
      owner.events.push(["telegram-poll"]);
    };
    await adapter.start();
    assert.equal(bot.status, 1);
    assert.equal(bot.selfId, "1");
    assert.equal(bot.username, "rin");
    assert.equal(bot.name, "rin");
    assert.deepEqual(bot.inboundRecovery, {
      status: "ready",
      mode: "native-cursor",
    });
    assert.equal(app.listenerCount("message"), 0);
    const pending = inbox.listPendingChatInboxItems(directory);
    assert.equal(pending.length, 1);

    assert.deepEqual(await bot.internal.getChat({ chat_id: "owner" }), {
      chat_id: "owner",
    });
    assert.deepEqual(await bot.getGuild("owner"), { chat_id: "owner" });
    assert.deepEqual(await bot.getGuildMember("owner", "user"), {
      chat_id: "owner",
      user_id: "user",
    });
    assert.equal(await bot.createReaction("owner", "20", "🔥"), true);
    assert.equal(await bot.deleteReaction("owner", "20"), true);

    const cursorPath = adapter.cursorPath;
    await fs.mkdir(path.dirname(cursorPath), { recursive: true });
    await fs.writeFile(cursorPath, JSON.stringify({ nextOffset: 99 }));
    adapter.nextOffset = 0;
    adapter.loadCursor();
    assert.equal(adapter.nextOffset, 99);
    await fs.writeFile(cursorPath, "bad-json");
    adapter.loadCursor();
    adapter.nextOffset = 100;
    adapter.saveCursor();
    assert.equal(
      JSON.parse(await fs.readFile(cursorPath, "utf8")).nextOffset,
      100,
    );

    assert.deepEqual(adapter.parseMention("plain", []), {
      appel: false,
      content: "plain",
    });
    assert.deepEqual(
      adapter.parseMention("@rin, owner", [
        { type: "mention", offset: 0, length: 4 },
      ]),
      { appel: true, content: "owner" },
    );
    assert.deepEqual(
      adapter.parseMention("owner", [
        { type: "text_mention", offset: 0, length: 5, user: { id: 1 } },
      ]),
      { appel: true, content: "owner" },
    );

    const originalTransportFetch = adapter.apiTransport.fetch;
    adapter.apiTransport.fetch = async () =>
      new Response(Buffer.from("owner-media"), { status: 200 });
    owner.apiHandlers.getFile = async () => ({ file_path: "owner/file" });
    try {
      const cached = await adapter.cacheFile({
        fileId: "file",
        uniqueId: "unique",
        mimeType: "image/png",
        name: "owner",
      });
      assert.equal(cached.name, "owner.png");
      assert.equal(await fs.readFile(cached.path, "utf8"), "owner-media");
    } finally {
      adapter.apiTransport.fetch = originalTransportFetch;
    }
    owner.apiHandlers.getFile = async () => ({});
    assert.equal(await adapter.cacheFile({ fileId: "missing" }), null);

    adapter.cacheFile = async (options: any) => ({
      path: path.join(directory, options.name || "owner.bin"),
      mimeType: options.mimeType,
      name: options.name || "owner.bin",
    });
    const elements = await adapter.buildElements(
      {
        message_id: 1,
        photo: [{ file_id: "small" }, { file_id: "large" }],
        sticker: { file_id: "sticker", emoji: "🙂" },
        video: { file_id: "video" },
        animation: { file_id: "animation" },
        audio: { file_id: "audio" },
        voice: { file_id: "voice" },
        document: {
          file_id: "document",
          file_name: "owner.png",
          mime_type: "image/png",
        },
      },
      "owner text",
    );
    assert.deepEqual(
      elements.map((node: any) => node.type),
      ["text", "image", "sticker", "video", "video", "audio", "audio", "image"],
    );

    const session = await adapter.buildSession(
      { update_id: 1 },
      {
        message_id: 2,
        date: "bad",
        message_thread_id: 3,
        is_topic_message: true,
        chat: { id: 4, type: "group", title: "Owner Group" },
        from: { id: 5, first_name: "Owner" },
        caption: "caption",
        caption_entities: [],
        reply_to_message: {
          message_id: 1,
          text: "quoted",
          from: { id: 6, first_name: "Quoted" },
        },
      },
    );
    assert.equal(session.guildName, "Owner Group");
    assert.equal(session.messageThreadId, "3");
    assert.deepEqual(session.elements[0], {
      type: "quote",
      attrs: { id: "1" },
      children: [],
    });

    owner.apiHandlers.sendMessage = async (payload: any) => {
      if (payload.parse_mode) throw new Error("bad html");
      return { message_id: 60 };
    };
    assert.equal(
      await adapter.sendText("4?thread=3", "<b>owner</b>", "1", "HTML"),
      "60",
    );
    owner.apiHandlers.editMessageText = async (payload: any) => {
      if (payload.parse_mode) throw new Error("message is not modified");
      return payload;
    };
    assert.equal(await adapter.editText("4", "2", "owner", "HTML"), "2");
    owner.apiHandlers.editMessageText = async (payload: any) => {
      if (payload.parse_mode) throw new Error("bad html");
      return payload;
    };
    assert.equal(await adapter.editText("4", "2", "owner", "HTML"), "2");

    owner.apiHandlers.sendPhoto = async () => {
      throw new Error("PHOTO_INVALID_DIMENSIONS");
    };
    owner.apiHandlers.sendDocument = async () => ({ message_id: 70 });
    assert.equal(
      await adapter.sendBinaryMessage(
        "sendPhoto",
        "photo",
        "4",
        {
          type: "image",
          attrs: { data: Buffer.from("image"), name: "owner.png" },
        },
        "caption",
      ),
      "70",
    );
    await assert.rejects(
      adapter.sendBinaryMessage(
        "sendPhoto",
        "photo",
        "4",
        { type: "image", attrs: {} },
        "",
      ),
      /media_source_missing/,
    );

    assert.equal(
      adapter.isRecoverableWorkingMessageEditError(
        new Error("message to edit not found"),
      ),
      true,
    );
    assert.equal(
      adapter.isRecoverableWorkingMessageEditError(new Error("fatal")),
      false,
    );
    assert.equal(await bot.workingIndicators[1].tick({}), false);
    assert.equal(await bot.workingIndicators[0].end({}), false);

    adapter.pollAbort = new AbortController();
    adapter.pollPromise = Promise.resolve();
    await adapter.stop();
    assert.equal(bot.status, 0);

    const failed = makeRuntime(runtime, directory, {
      key: "telegram",
      name: "Telegram",
      config: { token: "2:owner" },
    });
    failed.adapter.bootstrap = async () => {};
    failed.adapter.catchUpTelegramUpdates = async () => {
      throw "owner catch-up scalar";
    };
    await assert.rejects(failed.adapter.start(), /owner catch-up scalar/);
    assert.equal(failed.adapter.running, false);
  });
});

test("telegram adapter owns HTML rendering and whitespace preservation", () => {
  assert.match(
    runtime.__rinOwnerRenderTelegramHtmlFromNodes([
      {
        type: "markdown",
        attrs: { content: "**bold** [link](https://example.com)" },
      },
    ]),
    /<b>bold<\/b> <a href="https:\/\/example\.com">link<\/a>/,
  );
  const markdown = "    root  code\n\n- parent\n  - child\n    continuation";
  assert.equal(
    runtime.__rinOwnerRenderTelegramHtmlFromNodes([
      { type: "markdown", attrs: { content: markdown } },
    ]),
    markdown,
  );
  assert.equal(runtime.__rinOwnerIsTelegramMediaNodeType("image"), true);
  assert.equal(runtime.__rinOwnerIsTelegramMediaNodeType("text"), false);
  assert.deepEqual(runtime.__rinOwnerTelegramMediaMethod("image"), {
    method: "sendPhoto",
    field: "photo",
  });
  assert.deepEqual(runtime.__rinOwnerTelegramMediaMethod("video"), {
    method: "sendVideo",
    field: "video",
  });
  assert.deepEqual(runtime.__rinOwnerTelegramMediaMethod("audio"), {
    method: "sendAudio",
    field: "audio",
  });
  assert.deepEqual(runtime.__rinOwnerTelegramMediaMethod("sticker"), {
    method: "sendSticker",
    field: "sticker",
  });
  assert.deepEqual(runtime.__rinOwnerTelegramMediaMethod("file"), {
    method: "sendDocument",
    field: "document",
  });
  assert.equal(runtime.__rinOwnerDecodeTelegramThreadId("%"), "%");
  assert.deepEqual(
    runtime.__rinOwnerSplitTelegramChatThread("room?thread=42"),
    { chatId: "room", messageThreadId: "42", scopedChatId: "room?thread=42" },
  );
  assert.deepEqual(
    runtime.__rinOwnerSplitTelegramChatThread("room?thread=42", "7"),
    { chatId: "room", messageThreadId: "7", scopedChatId: "room?thread=7" },
  );
  assert.deepEqual(runtime.__rinOwnerSplitTelegramChatThread("room"), {
    chatId: "room",
    messageThreadId: "",
    scopedChatId: "room",
  });
  assert.deepEqual(runtime.__rinOwnerSplitTelegramChatThread("room", "topic"), {
    chatId: "room",
    messageThreadId: "topic",
    scopedChatId: "room?thread=topic",
  });
  assert.equal(
    runtime.__rinOwnerDecodeTelegramThreadId("topic%20name"),
    "topic name",
  );
  assert.deepEqual(runtime.__rinOwnerTelegramThreadPayload(""), {});
  assert.deepEqual(runtime.__rinOwnerTelegramThreadPayload("42"), {
    message_thread_id: 42,
  });
  assert.deepEqual(runtime.__rinOwnerTelegramThreadPayload("topic"), {
    message_thread_id: "topic",
  });
  assert.equal(
    runtime.__rinOwnerIsTelegramPhotoDimensionError("PHOTO_INVALID_DIMENSIONS"),
    true,
  );
  assert.equal(runtime.__rinOwnerIsTelegramPhotoDimensionError({}), false);
  assert.equal(
    runtime.__rinOwnerIsTelegramProviderRejection({
      name: "GrammyError",
      ok: false,
    }),
    true,
  );
  assert.equal(
    runtime.__rinOwnerIsTelegramProviderRejection({
      name: "OtherError",
      ok: false,
    }),
    false,
  );
  assert.equal(
    runtime.__rinOwnerIsTelegramProviderRejection({
      name: "GrammyError",
      ok: true,
    }),
    false,
  );
});
