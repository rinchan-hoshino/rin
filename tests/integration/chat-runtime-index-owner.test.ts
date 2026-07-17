import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

await import("../support/register-chat-runtime-index-owner-fixture.ts");
const runtime = await import(
  pathToFileURL(path.resolve("dist/core/chat-runtime/index.js")).href
);
// Preserve the immutable runtime scenarios while this owner lane adds direct
// provider startup, cursor, registration, and fallback contracts.
await import("../characterization/chat-runtime-ingress.test.ts");
await import("../characterization/chat-runtime-send.test.ts");

const owner = (globalThis as any).__chatRuntimeIndexOwner as Record<
  string,
  any
>;

function resetOwner() {
  owner.apiCalls = [];
  owner.apiHandlers = {};
  owner.agents = [];
  owner.events = [];
  owner.webSockets = [];
  owner.wsOpenError = undefined;
  owner.wsSendError = undefined;
  owner.wsAutoReply = true;
  owner.wsReply = undefined;
}

function logger() {
  const records: any[] = [];
  return {
    records,
    warn: (...args: any[]) => records.push(["warn", ...args]),
    info: (...args: any[]) => records.push(["info", ...args]),
    error: (...args: any[]) => records.push(["error", ...args]),
    debug: (...args: any[]) => records.push(["debug", ...args]),
  };
}

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-index-owner-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function makeRuntime(directory: string, entry: Record<string, any>) {
  const target = runtime.createChatRuntimeApp(directory);
  const created = runtime.instantiateBuiltInChatRuntimeAdapters(target, {
    dataDir: path.join(directory, "data"),
    adapterEntries: [entry],
    logger: logger(),
  });
  assert.equal(created.length, 1);
  return {
    app: target as any,
    adapter: [...(target as any).adapters][0] as any,
    bot: target.bots[0] as any,
  };
}

test("runtime app owns durable ingress, adapter ordering, builders, and provider registration", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const app = runtime.createChatRuntimeApp(directory) as any;
    const lifecycle: string[] = [];
    app.register(
      {
        start: async () => lifecycle.push("start-1"),
        stop: async () => lifecycle.push("stop-1"),
      },
      { platform: "owner-1", selfId: "one" },
    );
    app.register(
      {
        start: async () => lifecycle.push("start-2"),
        stop: async () => lifecycle.push("stop-2"),
      },
      { platform: "owner-2", selfId: "two" },
    );
    app.register({}, null);
    await app.start();
    await app.stop();
    assert.deepEqual(lifecycle, ["start-1", "start-2", "stop-2", "stop-1"]);

    let seen = 0;
    app.on("message", () => {
      seen += 1;
    });
    assert.equal(
      app.emit("message", {
        platform: "owner",
        selfId: "bot",
        channelId: "chat",
        messageId: "message",
        userId: "user",
        content: "owner",
        stripped: { content: "owner" },
        elements: [{ type: "text", attrs: { content: "owner" } }],
      }),
      true,
    );
    app.emit("message", { platform: "owner" });
    app.emit("other", {});
    assert.equal(seen, 2);
    const pending = await fs.readdir(
      path.join(directory, "data", "chat", "inbox", "pending"),
    );
    assert.equal(pending.length, 1);

    const h = runtime.createChatRuntimeH();
    assert.deepEqual(
      [
        h("owner", { value: 1 }, h.text("child")),
        h.quote("q"),
        h.at("u", { name: "Owner" }),
        h.image("https://owner/image"),
        h.markdown("**owner**"),
        h.html("<b>owner</b>"),
        h.file(Buffer.from("owner"), "text/plain", { name: "owner" }),
        h.file("https://owner/file", "text/plain"),
      ].map((node: any) => node.type),
      ["owner", "quote", "at", "image", "markdown", "html", "file", "file"],
    );

    const builtInLog = logger();
    const all = runtime.createChatRuntimeApp() as any;
    const entries = [
      ["telegram", { token: "1:owner" }],
      ["onebot", { endpoint: "ws://owner" }],
      ["lark", { appId: "owner", appSecret: "secret" }],
      ["discord", { token: "owner" }],
      ["slack", { token: "owner", botToken: "owner" }],
      ["minecraft", { url: "ws://owner" }],
      ["unknown", {}],
    ].map(([key, config]) => ({ key, name: String(key), config }));
    const created = runtime.instantiateBuiltInChatRuntimeAdapters(all, {
      dataDir: directory,
      adapterEntries: entries,
      logger: builtInLog,
    });
    assert.deepEqual(
      created.map((entry: any) => entry.key),
      ["telegram", "onebot", "lark", "discord", "slack", "minecraft"],
    );
    assert.equal(all.bots.length, 6);
    assert.equal(
      builtInLog.records.some((entry) =>
        /not implemented/.test(entry.join(" ")),
      ),
      true,
    );

    const asyncCreated = await runtime.instantiateChatRuntimeAdapters(
      runtime.createChatRuntimeApp(),
      {
        dataDir: directory,
        adapterEntries: [entries[0], entries[6]],
        logger: builtInLog,
      },
    );
    assert.deepEqual(asyncCreated, [{ key: "telegram", name: "telegram" }]);

    const externalApp = runtime.createChatRuntimeApp() as any;
    const externalLog = logger();
    const external = await runtime.instantiateExternalChatRuntimeAdapters(
      externalApp,
      {
        agentDir: directory,
        dataDir: path.join(directory, "data"),
        runtimeRoot: "/owner/runtime",
        h,
        logger: externalLog,
        adapterEntries: [
          {
            key: "function",
            name: "Function",
            packageName: "owner-function",
            config: { enabled: true },
            provider: async (input: any) => ({
              adapter: { input },
              bot: { platform: input.key },
            }),
          },
          {
            key: "object",
            name: "Object",
            config: {},
            provider: {
              createAdapter(input: any) {
                input.app.register({ object: true }, { platform: input.key });
              },
            },
          },
          {
            key: "missing",
            name: "Missing",
            config: {},
            provider: {} as any,
          },
          {
            key: "partial",
            name: "Partial",
            config: {},
            provider: () => ({ adapter: {} }),
          },
          {
            key: "empty",
            name: "Empty",
            config: {},
            provider: () => ({}),
          },
          {
            key: "unregistered",
            name: "Unregistered",
            config: {},
            provider: () => undefined,
          },
        ],
      },
    );
    assert.deepEqual(external, [
      { key: "function", name: "Function" },
      { key: "object", name: "Object" },
    ]);
    assert.equal(externalApp.bots.length, 2);
    assert.equal(externalApp.adapters.size, 2);
    assert.equal(externalLog.records.length, 4);
  });
});

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

    const { app, adapter, bot } = makeRuntime(directory, {
      key: "telegram",
      name: "Telegram",
      config: { token: "1:owner" },
    });
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
    const pending = await fs.readdir(
      path.join(directory, "data", "chat", "inbox", "pending"),
    );
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

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(Buffer.from("owner-media"), { status: 200 })) as any;
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
      globalThis.fetch = originalFetch;
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
    assert.equal(session.quote.content, "quoted");

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

    const failed = makeRuntime(directory, {
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

test("onebot adapter owns WebSocket actions, internal proxy signatures, recovery, ingress, and send dispatch", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    owner.wsReply = (payload: any) => ({
      echo: payload.echo,
      status: "ok",
      retcode: 0,
      data:
        payload.action === "get_login_info"
          ? { user_id: 100 }
          : { message_id: 200, messages: [] },
    });
    const { app, adapter, bot } = makeRuntime(directory, {
      key: "onebot",
      name: "OneBot",
      config: {
        endpoint: "ws://onebot.owner",
        token: "secret",
        selfId: "100",
      },
    });
    await adapter.connect();
    assert.equal(bot.selfId, "100");
    assert.equal(
      owner.webSockets[0].options.headers.Authorization,
      "Bearer secret",
    );
    assert.deepEqual(await bot.internal.getGroupInfo("42", true), {
      message_id: 200,
      messages: [],
    });
    await bot.internal.getGroupMemberInfo("42", "7", true);
    await bot.internal.getMsg("9");
    await bot.internal.sendGroupMsg("42", "owner");
    await bot.internal.sendPrivateMsg("7", "owner", true);
    await bot.internal.getVersionInfo({ owner: true });
    await assert.rejects(
      bot.internal.unsupported("a", "b"),
      /unsupported_onebot_internal_signature/,
    );

    assert.deepEqual(
      await bot.internal.setMessageReaction({
        chat_id: "42",
        message_id: 9,
        reaction: [{ emoji: "🔥" }],
      }),
      { message_id: 200, messages: [] },
    );
    await assert.rejects(
      bot.internal.setMessageReaction({
        chat_id: "private:7",
        message_id: 9,
        reaction: [{ emoji: "🔥" }],
      }),
      /requires_group_chat/,
    );
    await assert.rejects(
      bot.internal.setMessageReaction({
        chat_id: "42",
        message_id: 9,
        reaction: [],
      }),
      /emoji_unsupported/,
    );

    assert.deepEqual(
      bot
        .getWorkingIndicators({ chatId: "private:7" })
        .map((item: any) => item.presentation),
      ["message"],
    );
    assert.deepEqual(
      bot
        .getWorkingIndicators({ chatId: "42" })
        .map((item: any) => item.presentation),
      ["reaction"],
    );
    assert.equal(
      await adapter.startPrivateWorkingNotice({ chatId: "42" }),
      false,
    );
    assert.equal(
      await adapter.startPrivateWorkingNotice({ chatId: "private:bad" }),
      false,
    );
    assert.equal(
      await adapter.startPrivateWorkingNotice({
        chatId: "private:7",
        messageId: "9",
      }),
      true,
    );
    assert.equal(
      await adapter.tickGroupWorkingReaction({
        chatId: "private:7",
        messageId: "9",
      }),
      false,
    );
    assert.equal(
      await adapter.tickGroupWorkingReaction({ chatId: "42" }),
      false,
    );
    assert.equal(
      await adapter.tickGroupWorkingReaction({
        chatId: "42",
        messageId: "9",
        reactionDue: false,
      }),
      true,
    );
    assert.equal(
      await adapter.tickGroupWorkingReaction({
        chatId: "42",
        messageId: "9",
        reactionTick: 0,
      }),
      true,
    );
    assert.equal(await adapter.endGroupWorkingReaction({ chatId: "42" }), true);
    assert.equal(
      await adapter.endGroupWorkingReaction({ chatId: "private:7" }),
      false,
    );

    const sent = bot.sendMessage("42", [
      { type: "quote", attrs: { id: "9" }, children: [] },
      { type: "at", attrs: { id: "7" }, children: [] },
      { type: "markdown", attrs: { content: "**owner**" }, children: [] },
      { type: "image", attrs: { data: Buffer.from("image") }, children: [] },
      { type: "audio", attrs: { src: "https://owner/audio" }, children: [] },
      { type: "video", attrs: { src: "https://owner/video" }, children: [] },
      { type: "file", attrs: { src: "https://owner/file" }, children: [] },
      {
        type: "container",
        attrs: {},
        children: [{ type: "text", attrs: { content: "child" }, children: [] }],
      },
    ]);
    await sent.dispatched;
    assert.deepEqual(await sent, ["200"]);
    assert.deepEqual(
      await bot.sendMessage("private:7", [
        { type: "text", attrs: { content: "owner" }, children: [] },
      ]),
      ["200"],
    );
    await assert.rejects(
      bot.sendMessage("42", []),
      /onebot_send_message_empty/,
    );

    const sessions: any[] = [];
    app.on("message", (session: any) => sessions.push(session));
    await adapter.handleSocketMessage("bad-json");
    await adapter.handleSocketMessage(JSON.stringify({ self_id: 100 }));
    await adapter.handleSocketMessage(
      JSON.stringify({
        post_type: "message",
        message_type: "group",
        self_id: 100,
        user_id: 7,
        group_id: 42,
        message_id: 10,
        message_seq: 11,
        time: 12,
        sender: {
          card: "Owner Card",
          nickname: "Owner Account",
          title: "Owner Group",
        },
        message: [
          { type: "text", data: { text: "hello" } },
          { type: "at", data: { qq: "100", name: "Rin" } },
          { type: "image", data: { file: "owner.png" } },
          { type: "record", data: { file: "owner.ogg" } },
          { type: "reply", data: { id: "9" } },
        ],
        raw_message: "hello",
      }),
    );
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].author.groupNickname, "Owner Card");
    assert.equal(sessions[0].stripped.appel, true);
    assert.deepEqual(sessions[0].quote, { messageId: "9" });

    assert.equal(
      await adapter.buildSession({
        message_type: "private",
        self_id: 7,
        user_id: 7,
      }),
      null,
    );
    assert.equal(
      (
        await adapter.buildSession({
          message_type: "private",
          user_id: 8,
          message_id: 1,
          sender: {},
        })
      ).channelId,
      "private:8",
    );

    const originalCallAction = adapter.callAction;
    adapter.callAction = async (action: string, params: any) => {
      if (action === "get_group_msg_history") {
        return {
          messages: [
            { message_seq: params.message_seq, message_id: params.message_seq },
          ],
        };
      }
      return originalCallAction.call(adapter, action, params);
    };
    assert.deepEqual(
      await adapter.fetchOneBotMessagesAfter({
        chatKey: "onebot/100:42",
        chatId: "42",
        messageId: "10",
        providerCursor: "11",
      }),
      [],
    );
    adapter.callAction = originalCallAction;

    await adapter.stop();
    assert.throws(
      () => adapter.callAction("owner", {}),
      /onebot_not_connected/,
    );

    const running = makeRuntime(directory, {
      key: "onebot",
      name: "OneBot",
      config: { endpoint: "ws://onebot.owner" },
    });
    await running.adapter.start();
    await new Promise((resolve) => setImmediate(resolve));
    await running.adapter.stop();
    assert.equal(running.adapter.loopPromise, null);

    const unsupported = makeRuntime(directory, {
      key: "onebot",
      name: "OneBot",
      config: { protocol: "http", endpoint: "http://owner" },
    });
    await assert.rejects(
      unsupported.adapter.connect(),
      /unsupported_onebot_protocol/,
    );
    const noEndpoint = makeRuntime(directory, {
      key: "onebot",
      name: "OneBot",
      config: {},
    });
    await assert.rejects(
      noEndpoint.adapter.connect(),
      /onebot_endpoint_required/,
    );
  });
});

test("runtime branch matrix keeps Telegram and OneBot fallbacks observable", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const telegram = makeRuntime(directory, {
      key: "telegram",
      name: "Telegram",
      config: { token: "3:owner" },
    });
    const adapter = telegram.adapter;
    const bot = telegram.bot;
    bot.selfId = "3";
    bot.username = "rin";

    assert.deepEqual(adapter.parseMention("", []), {
      appel: false,
      content: "",
    });
    assert.deepEqual(
      adapter.parseMention("@other owner", [
        { type: "mention", offset: 0, length: 6 },
        { type: "mention", offset: "bad", length: 2 },
        { type: "mention", offset: 0, length: 0 },
        { type: "text_mention", offset: 0, length: 6, user: { id: "other" } },
      ]),
      { appel: false, content: "@other owner" },
    );
    assert.deepEqual(
      adapter.parseMention("@rin and @rin", [
        { type: "mention", offset: 0, length: 4 },
        { type: "mention", offset: 9, length: 4 },
      ]),
      { appel: true, content: "and" },
    );
    assert.deepEqual(adapter.telegramTextChunks(""), []);
    assert.equal(adapter.workingMessageKey("chat", ""), "chat:chat");
    adapter.running = true;
    assert.equal(await adapter.start(), undefined);
    adapter.running = false;
    const missingTelegram = makeRuntime(directory, {
      key: "telegram",
      name: "Telegram",
      config: {},
    });
    await assert.rejects(
      missingTelegram.adapter.start(),
      /telegram_token_required/,
    );
    adapter.nextOffset = 5;
    adapter.handleUpdate = async () => {};
    let cursorSaves = 0;
    adapter.saveCursor = () => {
      cursorSaves += 1;
    };
    await adapter.handleTelegramUpdates([
      { update_id: "bad" },
      { update_id: 7 },
    ]);
    assert.equal(adapter.nextOffset, 8);
    assert.equal(cursorSaves, 1);
    adapter.pollPromise = Promise.reject(new Error("owner poll stop"));
    adapter.pollPromise.catch(() => {});
    await adapter.stop();

    adapter.cacheFile = async () => null;
    assert.deepEqual(
      await adapter.buildElements(
        {
          photo: [{ file_id: "photo" }],
          document: { file_id: "file" },
        },
        "",
      ),
      [],
    );
    const baseMessage = {
      message_id: 1,
      chat: { id: 4, type: "private" },
      from: { id: 5, first_name: "Owner" },
      text: "owner",
    };
    const quoteCases = [
      { from: { id: 6, username: "quoted" }, caption: "caption" },
      {
        from: { uin: 7, first_name: "First", last_name: "Last" },
        text: "text",
      },
      { message_id: 8, from: { first_name: "Only" } },
      {},
    ];
    const parsedQuotes = [];
    for (const reply_to_message of quoteCases) {
      parsedQuotes.push(
        (await adapter.buildSession({}, { ...baseMessage, reply_to_message }))
          .quote,
      );
    }
    assert.equal(parsedQuotes[0].content, "caption");
    assert.equal(parsedQuotes[1].nickname, "First Last");
    assert.equal(parsedQuotes[2].messageId, "8");
    assert.equal(parsedQuotes[3], undefined);
    assert.equal(await adapter.handleUpdate({}), undefined);
    assert.equal(await adapter.handleUpdate({ message: null }), undefined);

    owner.apiHandlers.sendChatAction = async (payload: any) => payload;
    owner.apiHandlers.sendMessage = async () => ({ message_id: 1 });
    owner.apiHandlers.editMessageText = async (payload: any) => payload;
    owner.apiHandlers.deleteMessage = async () => true;
    assert.equal(
      await bot.workingIndicators[1].tick({ chatId: "4?thread=bad%20id" }),
      true,
    );
    assert.equal(
      await bot.workingIndicators[0].tick({
        chatId: "4?thread=3",
        tick: 0,
        workingStatusText: "Owner status",
        assistantSummaryText: "Owner summary",
        messageId: "9",
      }),
      true,
    );
    adapter.updateWorkingMessage = async () => "";
    assert.equal(
      await bot.workingIndicators[0].tick({
        chatId: "4",
        assistantSummaryText: "Owner summary",
      }),
      true,
    );
    adapter.deleteVisibleWorkingMessage = async () => false;
    assert.equal(await bot.workingIndicators[0].end({ chatId: "4" }), false);

    owner.apiHandlers.sendMessage = async () => {
      throw new Error("owner send failed");
    };
    assert.equal(await adapter.sendFailurePlaceholder("4", ""), "");
    assert.equal(
      await adapter.sendFailurePlaceholder("4", "owner placeholder"),
      "",
    );
    owner.apiHandlers.editMessageText = async () => {
      throw new Error("owner edit failed");
    };
    await assert.rejects(
      adapter.editText("4", "1", "owner"),
      /owner edit failed/,
    );

    const fallbackFetch = globalThis.fetch;
    const fetchCalls: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      fetchCalls.push(init);
      return new Response(JSON.stringify({ ok: true, result: "owner-api" }), {
        headers: { "content-type": "application/json" },
      });
    }) as any;
    try {
      owner.apiHandlers = {};
      const abort = new AbortController();
      const pending = adapter.api.raw.sendMessage(
        { owner: true },
        abort.signal,
      );
      abort.abort();
      assert.equal(await pending, "owner-api");
      assert.equal(fetchCalls[0].body, JSON.stringify({ owner: true }));
      assert.equal(fetchCalls[0].duplex, "half");
      assert.equal(await adapter.api.raw.getAvailableGifts(), "owner-api");
    } finally {
      globalThis.fetch = fallbackFetch;
    }

    const noMethod = makeRuntime(directory, {
      key: "telegram",
      name: "Telegram",
      config: { token: "4:owner" },
    });
    noMethod.adapter.api.raw = {};
    await assert.rejects(
      noMethod.adapter.callApi("missing", {}),
      /telegram_api_method_missing/,
    );

    const onebot = makeRuntime(directory, {
      key: "onebot",
      name: "OneBot",
      config: { endpoint: "ws://onebot.owner", selfId: "100" },
    });
    const one = onebot.adapter;
    const oneBot = onebot.bot;
    const originalOneBotCallAction = one.callAction;
    const emitted: any[] = [];
    onebot.app.on("message", (session: any) => emitted.push(session));

    for (const value of [
      [
        { type: "text", data: { text: "text" } },
        { type: "at", data: { qq: "7", name: "Owner" } },
        { type: "image", data: { url: "https://owner/image" } },
        { type: "file", data: { id: "file", name: "Owner file" } },
        { type: "video", data: { file: "owner.mp4" } },
        { type: "audio", data: { file: "owner.mp3" } },
        { type: "voice", data: { file: "owner.ogg" } },
        { type: "sticker", data: { id: "sticker" } },
        { type: "face", data: { id: "face" } },
        { type: "mface", data: { id: "mface" } },
        { type: "forward", data: { id: "forward" } },
      ],
      "plain [CQ:at,qq=7] tail",
      42,
    ]) {
      const nodes = one.normalizeInboundSegmentNodes(value);
      assert.equal(Array.isArray(nodes), true);
    }

    one.callAction = async (_action: string, params: any) => ({
      data: {
        messages: [
          {
            sender: { user_id: 7, card: "Owner" },
            message: [{ type: "text", data: { text: "hello" } }],
          },
          { data: { user_id: 8, nickname: "Nested", content: "plain" } },
        ],
      },
      params,
    });
    const forward = await one.buildOneBotForwardNode({
      resid: "forward",
      title: "Owner forward",
    });
    assert.equal(forward.children.length, 0);
    one.callAction = async () => ({
      messages: [
        {
          sender: { user_id: 7, card: "Owner" },
          message: [{ type: "text", data: { text: "hello" } }],
        },
      ],
    });
    assert.equal(
      (await one.buildOneBotForwardNode({ file: "forward" })).children.length,
      1,
    );
    one.callAction = async () => {
      throw new Error("forward unavailable");
    };
    assert.equal(
      (await one.buildOneBotForwardNode({ id: "forward" })).children.length,
      0,
    );
    assert.equal((await one.buildOneBotForwardNode({})).children.length, 0);

    const self = await one.buildSession({
      message_type: "group",
      self_id: 100,
      user_id: 100,
    });
    assert.equal(self, null);
    one.callAction = async () => ({ messages: [] });
    const rich = await one.buildSession({
      message_type: "group",
      self_id: 100,
      user_id: 7,
      group_id: 42,
      message_id: 9,
      sender: { nick: "Owner", title: "Group" },
      message: [
        { type: "at", data: { qq: "7" } },
        { type: "img", data: {} },
        { type: "file", data: {} },
        { type: "video", data: {} },
        { type: "voice", data: {} },
        { type: "sticker", data: {} },
        { type: "face", data: {} },
        { type: "mface", data: {} },
        { type: "reply", data: {} },
        { type: "forward", data: {} },
      ],
    });
    assert.equal(rich.elements.length >= 8, true);

    one.callAction = async (action: string) => {
      if (action === "get_friend_msg_history") {
        return { messages: [{ message_seq: "5" }, { message_seq: "6" }] };
      }
      throw new Error("owner history failed");
    };
    assert.deepEqual(
      await one.fetchOneBotMessagesAfter({
        chatKey: "onebot/100:private:7",
        chatId: "private:7",
        messageId: "5",
      }),
      [{ message_seq: "6" }],
    );
    await assert.rejects(
      one.fetchOneBotMessagesAfter({
        chatKey: "onebot/100:42",
        chatId: "42",
        messageId: "missing",
      }),
      /owner history failed/,
    );
    one.bot.selfId = "";
    assert.deepEqual(await one.recoverOneBotMessages(), []);
    one.bot.selfId = "100";
    one.callAction = async () => {
      throw new Error("history unavailable");
    };
    assert.deepEqual(await one.recoverOneBotMessages(), []);

    one.callAction = originalOneBotCallAction;
    one.inboundGate.begin();
    await one.handleSocketMessage(
      JSON.stringify({
        post_type: "message",
        message_type: "private",
        user_id: 7,
        message_id: 10,
        raw_message: "buffered",
      }),
    );
    assert.equal(one.inboundGate.hasPending(), true);
    one.inboundGate.drain();
    one.inboundGate.open();

    const pendingError = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {}, 10_000);
      one.pending.set("owner-failed", { resolve, reject, timer });
    });
    await one.handleSocketMessage(
      JSON.stringify({
        echo: "owner-failed",
        status: "failed",
        retcode: -1,
        wording: "owner failure",
      }),
    );
    await assert.rejects(pendingError, /owner failure/);

    one.ws = {
      readyState: 1,
      send(_payload: string, callback: (error?: Error) => void) {
        callback(new Error("owner dispatch failed"));
      },
    };
    const dispatchFailed = one.callAction("owner", {});
    await assert.rejects(dispatchFailed.dispatched, /owner dispatch failed/);
    await assert.rejects(dispatchFailed, /owner dispatch failed/);
    one.ws = {
      readyState: 1,
      send() {
        throw new Error("owner send throw");
      },
    };
    const sendThrown = one.callAction("owner", {});
    await assert.rejects(sendThrown.dispatched, /owner send throw/);
    await assert.rejects(sendThrown, /owner send throw/);

    await assert.rejects(
      oneBot.createReaction("private:7", "1", "🔥"),
      /requires_group_chat/,
    );
    await assert.rejects(
      oneBot.createReaction("42", "1", ""),
      /emoji_unsupported/,
    );
    await assert.rejects(
      oneBot.deleteReaction("private:7", "1", "🔥"),
      /requires_group_chat/,
    );
    await assert.rejects(
      oneBot.deleteReaction("42", "1", ""),
      /emoji_unsupported/,
    );

    one.workingReactions.set("42:bad", "");
    assert.equal(await one.endGroupWorkingReaction({ chatId: "42" }), false);
    assert.equal(emitted.length, 0);
  });
});

test("exported OneBot helpers preserve bounded timeout and provider failure semantics", () => {
  assert.equal(runtime.ONEBOT_ACTION_TIMEOUT_MS, 20_000);
  assert.equal(runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS, 605_000);
  assert.equal(runtime.oneBotActionTimeoutMs("get_login_info", {}), 20_000);
  assert.equal(
    runtime.oneBotActionTimeoutMs("send_group_msg", {
      message: "[CQ:image,file=file://owner]",
    }),
    605_000,
  );
  assert.deepEqual(runtime.withOneBotActionTimeoutParam("send_private_msg"), {
    timeout: 20_000,
  });
  assert.deepEqual(
    runtime.withOneBotActionTimeoutParam("send_group_msg", { timeout: 1 }),
    { timeout: 1 },
  );
  assert.equal(
    runtime.formatOneBotActionFailureMessage({ wording: "owner wording" }),
    "owner wording",
  );
  assert.equal(
    runtime.formatOneBotActionFailureMessage({}),
    "onebot_action_failed",
  );
  assert.match(
    runtime.renderOneBotForwardContent({
      data: {
        messages: [
          {
            user_id: 7,
            nickname: "Owner",
            content: [
              { type: "text", data: { text: "hello" } },
              { type: "at", data: { qq: "8", name: "Mention" } },
              { type: "image", data: { file: "owner.png" } },
              { type: "file", data: { file: "owner.txt" } },
              { type: "video", data: { file: "owner.mp4" } },
              { type: "record", data: { file: "owner.ogg" } },
              { type: "face", data: { id: "1" } },
              { type: "forward", data: { resid: "nested" } },
              { type: "unknown", data: { text: "unknown" } },
            ],
          },
          { qq: 9, name: "Named", message: "plain" },
          { sender: { nickname: "Only nick" }, raw_message: "" },
        ],
      },
    }),
    /Owner\(7\): hello/,
  );
  for (const value of [
    [{ nickname: "Array", content: "owner" }],
    { messages: [{ nickname: "Messages", content: "owner" }] },
    { content: [{ nickname: "Content", content: "owner" }] },
    { data: { content: [{ nickname: "Data", content: "owner" }] } },
  ]) {
    assert.match(runtime.renderOneBotForwardContent(value), /owner/);
  }
  const aliases = runtime.renderOneBotForwardContent([
    {
      uin: 1,
      name: "ByName",
      content: [{ type: "forward", data: { id: "id" } }],
    },
    {
      qq: 2,
      nick: "ByNick",
      content: [{ type: "forward", data: { resid: "resid" } }],
    },
    {
      user_id: 3,
      sender: { nickname: "BySender" },
      content: [{ type: "forward", data: { file: "file" } }],
    },
    { user_id: 4, content: [{ type: "forward", data: {} }] },
    { raw_message: [{ type: "at", data: { id: "5" } }] },
    { message: [{ type: "image", data: { url: "https://owner/image" } }] },
  ]);
  assert.match(aliases, /ByName\(1\)/);
  assert.match(aliases, /ByNick\(2\)/);
  assert.match(aliases, /BySender\(3\)/);
  assert.match(aliases, /unknown/);
  assert.equal(runtime.renderOneBotForwardContent({}), "");
});
