import assert from "node:assert/strict";
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
  await import(
    pathToFileURL(path.resolve("dist/core/chat-runtime/onebot.js")).href
  ),
);

test("runtime branch matrix keeps Telegram and OneBot fallbacks observable", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const telegram = makeRuntime(runtime, directory, {
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
    const missingTelegram = makeRuntime(runtime, directory, {
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
      const session = await adapter.buildSession(
        {},
        { ...baseMessage, reply_to_message },
      );
      parsedQuotes.push(
        session.elements.find((element: any) => element.type === "quote"),
      );
    }
    assert.equal(parsedQuotes[0], undefined);
    assert.equal(parsedQuotes[1], undefined);
    assert.equal(parsedQuotes[2].attrs.id, "8");
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
    owner.apiHandlers.editMessageText = async () => {
      throw new Error("owner edit failed");
    };
    await assert.rejects(
      adapter.editText("4", "1", "owner"),
      /owner edit failed/,
    );

    const fallbackFetch = adapter.apiTransport.fetch;
    const fetchCalls: any[] = [];
    adapter.apiTransport.fetch = async (_url: any, init: any) => {
      fetchCalls.push(init);
      return new Response(JSON.stringify({ ok: true, result: "owner-api" }), {
        headers: { "content-type": "application/json" },
      });
    };
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
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      assert.equal(
        await adapter.api.raw.sendMessage(
          { owner: "aborted" },
          alreadyAborted.signal,
        ),
        "owner-api",
      );
      assert.equal(await adapter.api.raw.getAvailableGifts(), "owner-api");
    } finally {
      adapter.apiTransport.fetch = fallbackFetch;
    }

    const noMethod = makeRuntime(runtime, directory, {
      key: "telegram",
      name: "Telegram",
      config: { token: "4:owner" },
    });
    noMethod.adapter.api.raw = {};
    await assert.rejects(
      noMethod.adapter.callApi("missing", {}),
      /telegram_api_method_missing/,
    );

    const onebot = makeRuntime(runtime, directory, {
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

    assert.equal(one.fetchOneBotMessagesAfter, undefined);
    assert.equal(one.recoverOneBotMessages, undefined);
    one.callAction = originalOneBotCallAction;
    await one.handleSocketMessage(
      JSON.stringify({
        post_type: "message",
        message_type: "private",
        user_id: 7,
        message_id: 10,
        raw_message: "standard recovery",
      }),
    );
    assert.equal(
      emitted.some((session) => session.messageId === "10"),
      true,
    );

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

    const reactionActions: Array<[string, any]> = [];
    one.callAction = async (action: string, params: any) => {
      reactionActions.push([action, params]);
      return {};
    };
    assert.equal(await oneBot.createReaction("42", "1", "🧪"), true);
    assert.equal(reactionActions[0][0], "set_msg_emoji_like");
    assert.equal(reactionActions[0][1].emoji_id, String("🧪".codePointAt(0)));
    one.callAction = originalOneBotCallAction;

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
    assert.equal(emitted.length, 1);
  });
});
