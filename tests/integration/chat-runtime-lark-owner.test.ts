import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  app,
  logger,
  owner,
  resetOwner,
  withTempDir,
} from "../support/chat-runtime-adapters-owner-harness.ts";

const adapters = Object.assign(
  {},
  await import(
    pathToFileURL(path.resolve("dist/core/chat-runtime/lark.js")).href
  ),
);

test("lark adapter owns SDK startup, event settlement, native APIs, and parsing fallbacks", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const calls: any[] = [];
    const client = {
      request: async (payload: any) => (
        calls.push(["request", payload]),
        { code: 0, bot: { open_id: "bot-open-id", app_name: "Rin Bot" } }
      ),
      im: {
        message: {
          create: async (payload: any) => (
            calls.push(["create", payload]),
            { code: 0, data: { message_id: `m${calls.length}` } }
          ),
          reply: async (payload: any) => (
            calls.push(["reply", payload]),
            { code: 0, data: { message_id: `m${calls.length}` } }
          ),
          get: async (payload: any) => (calls.push(["get", payload]), {}),
          list: async () => ({ code: 0, data: { items: [], has_more: false } }),
        },
        chat: {
          get: async (payload: any) => (
            calls.push(["chat", payload]),
            { data: { user_count: "2", bot_count: "1" } }
          ),
        },
        chatMembers: {
          get: async (payload: any) => (calls.push(["members", payload]), {}),
        },
        messageReaction: {
          create: async (payload: any) => (
            calls.push(["reaction-create", payload]),
            {}
          ),
          list: async (payload: any) => (
            calls.push(["reaction-list", payload]),
            {
              data: {
                items: [
                  {
                    reaction_id: "r1",
                    reaction_type: { emoji_type: "Fire" },
                    operator: { operator_type: "app" },
                  },
                ],
              },
            }
          ),
          delete: async (payload: any) => (
            calls.push(["reaction-delete", payload]),
            {}
          ),
        },
        messageResource: {
          get: async (payload: any) => (calls.push(["resource", payload]), {}),
        },
        image: {
          create: async (payload: any) => (
            calls.push(["image", payload]),
            { data: { image_key: "image-key" } }
          ),
        },
      },
      contact: {
        user: {
          get: async (payload: any) => (calls.push(["user", payload]), {}),
        },
      },
    };
    const ws = {
      async start(options: any) {
        calls.push(["ws-start", options]);
      },
      close(options: any) {
        calls.push(["ws-close", options]);
      },
    };
    owner.larkClient = client;
    owner.larkWs = ws;
    const targetApp = app();
    const log = logger();
    await assert.rejects(
      new adapters.LarkAdapter(targetApp, directory, {}, log).start(),
      /lark_app_id_required/,
    );
    await assert.rejects(
      new adapters.LarkAdapter(
        targetApp,
        directory,
        { appId: "app" },
        log,
      ).start(),
      /lark_app_secret_required/,
    );

    const adapter = new adapters.LarkAdapter(
      targetApp,
      directory,
      { appId: "app", appSecret: "secret", platform: "lark" },
      log,
    );
    await adapter.start();
    const bot = adapter.bot;
    assert.equal(bot.status, 1);
    assert.equal(bot.selfId, "app");
    assert.equal(bot.user.name, "Rin Bot");
    assert.equal(owner.larkDispatcher.handles.size, 1);
    await owner.larkDispatcher.handles.get("im.message.receive_v1")({
      sender: {
        sender_type: "user",
        sender_id: { open_id: "owner" },
      },
      message: {
        message_id: "incoming",
        message_type: "text",
        chat_id: "chat",
        chat_type: "p2p",
        create_time: "123",
        content: JSON.stringify({ text: "hello" }),
      },
    });
    assert.equal(
      targetApp.records.find(([name]) => name === "message")?.[1].content,
      "hello",
    );

    await bot.internal.createMessage({ data: {} });
    await bot.internal.getMessage({ path: {} });
    await bot.internal.getChat({ path: {} });
    await bot.internal.createReaction({ data: {} });
    await bot.internal.deleteReaction({ path: {} });
    await bot.internal.listReactions({ path: {} });
    await bot.internal.listChatMembers({ path: {} });
    await bot.internal.getMessageResource({ path: {} });
    await bot.internal.getUser({ path: {} });
    await bot.createReaction("chat", "m1", "🔥");
    assert.equal(await bot.deleteReaction("chat", "m1", "🔥"), true);
    client.im.messageReaction.list = async () => ({ data: { items: [] } });
    assert.equal(await bot.deleteReaction("chat", "m1", "custom"), false);
    await assert.rejects(
      bot.createReaction("chat", "m1", ""),
      /emoji_required/,
    );

    assert.deepEqual((adapter as any).parseMessageContent(""), {
      text: "",
      mentions: [],
    });
    assert.deepEqual((adapter as any).parseMessageContent('"owner"'), {
      text: "owner",
      mentions: [],
    });
    assert.equal(
      (adapter as any).parseMessageContent("not-json").text,
      "not-json",
    );
    for (const [type, raw] of [
      [
        "post",
        JSON.stringify({
          zh_cn: { content: [[{ tag: "text", text: "post" }]] },
        }),
      ],
      ["image", JSON.stringify({ image_key: "image" })],
      ["file", JSON.stringify({ file_key: "file", file_name: "owner" })],
      ["text", JSON.stringify({ text: "hello @_owner" })],
    ] as const) {
      assert.equal(
        (adapter as any).parseLarkMessageContentNodes(type, raw, [
          { key: "@_owner", id: "owner", name: "Owner" },
        ]).length > 0,
        true,
      );
    }

    const delivered = await bot.sendMessage("chat", [
      { type: "quote", attrs: { id: "parent" }, children: [] },
      { type: "markdown", attrs: { content: "**owner**" }, children: [] },
      {
        type: "image",
        attrs: { data: Buffer.from("image"), name: "owner.png" },
        children: [],
      },
    ]);
    assert.equal(delivered.length, 2);
    assert.equal(
      calls.some(([name]) => name === "image"),
      true,
    );
    await assert.rejects(
      bot.sendMessage("chat", []),
      /lark_send_message_empty/,
    );

    await adapter.stop();
    assert.equal(bot.status, 0);
  });
});

test("lark adapter preserves recovery, forward, resource, and image failure branches", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const calls: any[] = [];
    const pages = [
      {
        code: 0,
        data: {
          items: [
            {
              message_id: "cursor",
              msg_type: "text",
              content: '{"text":"cursor"}',
              sender: { id: "u0", id_type: "open_id" },
            },
            {
              message_id: "next",
              msg_type: "text",
              body: { content: '{"text":"next"}' },
              sender: { id: "u1", id_type: "user_id" },
            },
          ],
          has_more: true,
          page_token: "page-2",
        },
      },
      {
        code: 0,
        items: [
          {
            message_id: "last",
            message_type: "text",
            content: '{"content":"last"}',
            sender: { id: "u2", id_type: "union_id" },
          },
        ],
        has_more: true,
        page_token: "page-2",
      },
    ];
    const client: any = {
      im: {
        message: {
          list: async (payload: any) => (
            calls.push(["list", payload]),
            pages.shift()
          ),
          get: async () => ({
            items: [
              { message_id: "forward" },
              {
                message_id: "a",
                msg_type: "text",
                content: '{"text":"hello"}',
                sender: { id: "sender" },
              },
              {
                message_id: "b",
                msg_type: "text",
                content: "",
                sender: { sender_id: { open_id: "open" } },
              },
              {
                message_id: "c",
                msg_type: "text",
                content: "",
                sender: { sender_id: { user_id: "user" } },
              },
              { message_id: "d", msg_type: "text", content: "" },
              { msg_type: "text", content: "" },
            ],
          }),
          create: async (payload: any) => ({
            code: 0,
            message_id: payload.data.receive_id ? "created" : "",
          }),
          reply: async () => ({ code: 0, data: { message_id: "reply" } }),
        },
        messageResource: {
          get: async ({ path: resourcePath }: any) => {
            if (resourcePath.file_key === "missing") return {};
            if (resourcePath.file_key === "boom")
              throw new Error("resource failed");
            return {
              headers: { "Content-Type": "image/png; charset=binary" },
              async writeFile(filePath: string) {
                calls.push(["write", filePath]);
                await fs.writeFile(filePath, "resource");
              },
            };
          },
        },
        chat: { get: async () => ({ userCount: 2, botCount: "bad" }) },
        messageReaction: {
          create: async () => true,
          list: async () => ({
            data: { items: [{ reaction_id: "fallback" }] },
          }),
          delete: async () => true,
        },
        image: { create: async () => ({}) },
      },
    };
    const log = logger();
    const targetApp = app(directory);
    const lark = new adapters.LarkAdapter(
      targetApp,
      directory,
      { appId: "app", appSecret: "secret" },
      log,
    ) as any;
    lark.client = client;
    lark.bot.selfId = "app";

    const recovered = await lark.fetchLarkMessagesAfter({
      chatKey: "lark/app:chat",
      chatId: "chat",
      messageId: "cursor",
      platformTimestamp: 500,
    });
    assert.deepEqual(
      recovered.map((entry: any) => entry.message.message_id),
      ["next", "last"],
    );
    assert.equal(recovered[0].sender.sender_id.user_id, "u1");
    assert.equal(recovered[1].sender.sender_id.union_id, "u2");
    client.im.message.list = async () => ({ code: 0, data: { items: [] } });
    await assert.rejects(
      lark.fetchLarkMessagesAfter({
        chatKey: "k",
        chatId: "c",
        messageId: "absent",
        platformTimestamp: 0,
      }),
      /did not return recovery cursor/,
    );
    client.im.message.list = async () => ({ code: 7, msg: "denied" });
    await assert.rejects(
      lark.fetchLarkMessagesAfter({
        chatKey: "k",
        chatId: "c",
        messageId: "absent",
        platformTimestamp: 0,
      }),
      /lark_api_error:7:denied/,
    );

    assert.equal(await lark.recoverLarkMessages(), undefined);
    const merged = lark.mergeLarkRecoveryMessages(
      [
        { message: { message_id: "same", create_time: 2 } },
        { message: { message_id: "older", create_time: 1 } },
        { message: {} },
      ],
      [
        {
          data: { message: { message_id: "same", create_time: 3 } },
          resolve() {},
          reject() {},
        },
        { data: { message: { create_time: 3 } }, resolve() {}, reject() {} },
      ],
    );
    assert.deepEqual(
      merged.map((entry: any) => entry.data.message.message_id || "buffered"),
      ["older", "same", "buffered"],
    );

    const forward = await lark.buildLarkForwardNode({ message_id: "forward" });
    assert.equal(forward.children.length, 5);
    assert.match(forward.children[0].attrs.content, /sender: hello/);
    assert.match(
      forward.children.at(-1).attrs.content,
      /unknown: \[unsupported message\]/,
    );
    client.im.message.get = async () => {
      throw new Error("forward failed");
    };
    assert.equal(
      (await lark.buildLarkForwardNode({ message_id: "failed" })).children
        .length,
      0,
    );
    assert.equal((await lark.buildLarkForwardNode({})).children.length, 0);

    assert.deepEqual(lark.pickLarkMessageItems({ data: { items: [1] } }), [1]);
    assert.deepEqual(lark.pickLarkMessageItems({}), []);
    assert.equal(await lark.cacheLarkMessageResource("", "key", "image"), null);
    assert.equal(
      await lark.cacheLarkMessageResource("m", "missing", "image"),
      null,
    );
    const cached = await lark.cacheLarkMessageResource("m", "key", "image");
    assert.equal(cached.name.endsWith(".png"), true);
    assert.equal(await fs.readFile(cached.path, "utf8"), "resource");

    const resolved = await lark.resolveLarkMessageResources("m", [
      { type: "text", attrs: { content: "plain" } },
      { type: "image", attrs: { src: "https://owner/image" } },
      { type: "image", attrs: { src: "key", name: "owner" } },
      { type: "file", attrs: { src: "missing" } },
      { type: "file", attrs: { src: "boom" } },
      { type: "file", attrs: {} },
    ]);
    assert.equal(resolved[2].attrs.src.startsWith("file:"), true);
    assert.equal(resolved[3].attrs.src, undefined);
    assert.equal(resolved[4].attrs.src, undefined);
    assert.equal(await lark.bot.deleteReaction("chat", "m", "custom"), true);
    await assert.rejects(
      lark.bot.deleteReaction("chat", "m", ""),
      /emoji_required/,
    );

    assert.deepEqual(
      lark
        .parsePostContentNodes({
          en_us: {
            content: [
              [
                { tag: "at", id: "owner", name: "Owner" },
                { tag: "img", src: "image", alt: "alt" },
                { tag: "md", text: "**bold**" },
                { tag: "a", href: "https://owner" },
              ],
              "invalid",
            ],
          },
        })
        .map((node: any) => node.type),
      ["at", "image", "markdown", "text"],
    );
    assert.deepEqual(
      lark.parseLarkMessageContentNodes("text", "@_missing tail", []),
      [
        { type: "text", attrs: { content: "@_missing" }, children: [] },
        { type: "text", attrs: { content: " tail" }, children: [] },
      ],
    );
    assert.deepEqual(lark.parseLarkMessageContentNodes("text", "", []), []);

    const postData = lark.buildPostData(
      '# Heading\n\n**bold** *italic* ~~strike~~ [link](https://owner)  \nnext\n\n```ts\nconst x = 1;\n```\n\n---\n\n<at user_id="u&amp;&quot;">Owner</at>\n\n- one\ncontinuation',
    );
    assert.equal(postData.msg_type, "post");
    assert.equal(JSON.parse(postData.content).zh_cn.content.length > 5, true);
    assert.deepEqual(
      await lark.sendData("chat", { msg_type: "text" }, "parent"),
      ["reply"],
    );
    client.im.message.create = async () => ({
      code: 9,
      message: "create failed",
    });
    await assert.rejects(
      lark.sendData("chat", { msg_type: "text" }),
      /lark_api_error:9:create failed/,
    );
    await assert.rejects(lark.sendPostText("chat", ""), /send_message_empty/);

    assert.throws(
      () => lark.assertLarkImageSize(Buffer.alloc(0)),
      /content is empty/,
    );
    assert.throws(
      () => lark.assertLarkImageSize(Buffer.alloc(10 * 1024 * 1024 + 1)),
      /10 MB/,
    );
    const originalTransportFetch = lark.httpTransport.fetch;
    try {
      lark.httpTransport.fetch = async () =>
        new Response("no", { status: 404 });
      await assert.rejects(
        lark.downloadLarkImage("https://owner/404"),
        /HTTP 404/,
      );
      lark.httpTransport.fetch = async () =>
        new Response("x", {
          headers: { "content-length": String(11 * 1024 * 1024) },
        });
      await assert.rejects(
        lark.downloadLarkImage("https://owner/large"),
        /10 MB/,
      );
      lark.httpTransport.fetch = async () => {
        throw new Error("network down");
      };
      await assert.rejects(
        lark.downloadLarkImage("https://owner/down"),
        /network down/,
      );
      lark.httpTransport.fetch = async () => new Response(Buffer.from("image"));
      client.im.message.create = async () => ({
        code: 0,
        data: { message_id: "image-message" },
      });
      await assert.rejects(
        lark.sendImage("chat", {
          type: "image",
          attrs: { src: "https://owner/image" },
        }),
        /no image key/,
      );
    } finally {
      lark.httpTransport.fetch = originalTransportFetch;
    }

    const local = path.join(directory, "local.png");
    await fs.writeFile(local, "image");
    await lark.assertLarkLocalImageSourceSize({ attrs: { src: local } });
    await lark.assertLarkLocalImageSourceSize({
      attrs: { src: path.join(directory, "missing.png") },
    });
    assert.equal(
      log.records.some((entry: any[]) =>
        /forward failed/.test(entry.join(" ")),
      ),
      true,
    );
    assert.equal(
      log.records.some((entry: any[]) =>
        /resource failed/.test(entry.join(" ")),
      ),
      true,
    );
  });
});
