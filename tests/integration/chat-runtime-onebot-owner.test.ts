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
    pathToFileURL(path.resolve("dist/core/chat-runtime/onebot.js")).href
  ),
);

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
    const { app, adapter, bot } = makeRuntime(runtime, directory, {
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
    assert.deepEqual(await sent, ["200", "200", "200"]);
    assert.equal(
      owner.events.some(
        ([event, request]: any[]) =>
          event === "ws-send" &&
          request.action === "upload_group_file" &&
          request.params.name === "file" &&
          request.params.file === "https://owner/file",
      ),
      true,
    );
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
    assert.deepEqual(sessions[0].elements[0], {
      type: "quote",
      attrs: { id: "9" },
      children: [],
    });

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

    assert.equal(adapter.fetchOneBotMessagesAfter, undefined);
    assert.equal(adapter.recoverOneBotMessages, undefined);

    await adapter.stop();
    assert.throws(
      () => adapter.callAction("owner", {}),
      /onebot_not_connected/,
    );

    const running = makeRuntime(runtime, directory, {
      key: "onebot",
      name: "OneBot",
      config: { endpoint: "ws://onebot.owner" },
    });
    await running.adapter.start();
    await new Promise((resolve) => setImmediate(resolve));
    await running.adapter.stop();
    assert.equal(running.adapter.loopPromise, null);

    const unsupported = makeRuntime(runtime, directory, {
      key: "onebot",
      name: "OneBot",
      config: { protocol: "http", endpoint: "http://owner" },
    });
    await assert.rejects(
      unsupported.adapter.connect(),
      /unsupported_onebot_protocol/,
    );
    const noEndpoint = makeRuntime(runtime, directory, {
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
  assert.equal(runtime.oneBotActionTimeoutMs("upload_group_file", {}), 605_000);
  assert.equal(
    runtime.oneBotActionTimeoutMs("send_msg", "file://owner"),
    605_000,
  );
  assert.equal(runtime.oneBotActionTimeoutMs("send_msg", null), 20_000);
  const circularParams: any = { message: "plain" };
  circularParams.self = circularParams;
  assert.equal(
    runtime.oneBotActionTimeoutMs("send_group_msg", circularParams),
    20_000,
  );
  assert.deepEqual(runtime.withOneBotActionTimeoutParam("send_private_msg"), {
    timeout: 20_000,
  });
  assert.deepEqual(
    runtime.withOneBotActionTimeoutParam("send_group_msg", { timeout: 1 }),
    { timeout: 1 },
  );
  assert.deepEqual(runtime.withOneBotActionTimeoutParam("owner", []), {});
  assert.deepEqual(
    runtime.withOneBotActionTimeoutParam("get_login_info", { timeout: 0 }),
    { timeout: 0 },
  );
  assert.deepEqual(
    runtime.withOneBotActionTimeoutParam("send_private_msg", {
      timeout: "invalid",
      file: "file://owner",
    }),
    { timeout: 605_000, file: "file://owner" },
  );
  assert.deepEqual(
    runtime.withOneBotActionTimeoutParam("send_private_msg", { timeout: -1 }),
    { timeout: 20_000 },
  );
  assert.equal(
    runtime.formatOneBotActionFailureMessage({ wording: "owner wording" }),
    "owner wording",
  );
  assert.equal(runtime.formatOneBotActionFailureMessage({ msg: "msg" }), "msg");
  assert.equal(
    runtime.formatOneBotActionFailureMessage({ message: "message" }),
    "message",
  );
  assert.equal(
    runtime.formatOneBotActionFailureMessage({}),
    "onebot_action_failed",
  );
  assert.equal(
    runtime.formatOneBotActionFailureMessage(null),
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
  assert.equal(runtime.renderOneBotForwardContent(null), "");
  assert.match(
    runtime.renderOneBotForwardContent([
      { nickname: "No data", content: [{ type: "text", data: null }] },
    ]),
    /No data/,
  );
  assert.equal(
    runtime.__rinOwnerOneBotNodesContainMedia([{ type: "image", attrs: {} }]),
    true,
  );
  assert.equal(
    runtime.__rinOwnerOneBotNodesContainMedia([{ type: "text", attrs: {} }]),
    false,
  );
});
