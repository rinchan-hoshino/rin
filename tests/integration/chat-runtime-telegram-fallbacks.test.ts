import "../support/require-test-sandbox.ts";
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
  await import(pathToFileURL(path.resolve("dist/core/chat/chat.js")).href),
  await import(pathToFileURL(path.resolve("dist/core/chat/chat.js")).href),
  await import(
    pathToFileURL(path.resolve("dist/core/chat/platform/telegram.js")).href
  ),
);

test("Telegram fallback branches remain observable", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const telegram = makeRuntime(runtime, directory, {
      platform: "telegram",
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
      platform: "telegram",
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
    await assert.rejects(
      adapter.sendText("4", "owner", undefined, undefined),
      /owner send failed/,
    );
    await assert.rejects(
      adapter.sendMessage("4", []),
      /telegram_send_message_empty/,
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
      platform: "telegram",
      name: "Telegram",
      config: { token: "4:owner" },
    });
    noMethod.adapter.api.raw = {};
    await assert.rejects(
      noMethod.adapter.callApi("missing", {}),
      /telegram_api_method_missing/,
    );
  });
});
