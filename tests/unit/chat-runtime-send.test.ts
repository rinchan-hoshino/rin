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
const runtime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js"))
    .href
);

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-runtime-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createRuntimeApp(agentDir: string, adapterEntry: Record<string, any>) {
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [adapterEntry],
  });
  return app;
}

test("telegram adapter splits oversized text sends and keeps the reply only on the first chunk", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ method: string; payload: any }> = [];
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      return { message_id: String(calls.length) };
    };

    const result = await app.bots[0].sendMessage("456", [
      h.quote("99"),
      h.text("a".repeat(4100)),
    ]);

    assert.deepEqual(result, ["1", "2"]);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage", "sendMessage"],
    );
    assert.equal(calls[0].payload.chat_id, "456");
    assert.equal(calls[0].payload.reply_to_message_id, "99");
    assert.equal(calls[0].payload.text.length, 4096);
    assert.equal(calls[1].payload.reply_to_message_id, undefined);
    assert.equal(calls[1].payload.text, "a".repeat(4));
  });
});

test("telegram adapter renders markdown nodes through Telegram HTML parse mode", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ method: string; payload: any }> = [];
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      return { message_id: String(calls.length) };
    };

    const result = await app.bots[0].sendMessage("456", [
      h.markdown("**bold** [docs](https://example.com)"),
    ]);

    assert.deepEqual(result, ["1"]);
    assert.equal(calls[0].method, "sendMessage");
    assert.equal(calls[0].payload.parse_mode, "HTML");
    assert.match(calls[0].payload.text, /<b>bold<\/b>/);
    assert.match(
      calls[0].payload.text,
      /<a href="https:\/\/example\.com">docs<\/a>/,
    );
  });
});

test("telegram adapter renders structured at as a native mention link", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ method: string; payload: any }> = [];
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      return { message_id: String(calls.length) };
    };

    const result = await app.bots[0].sendMessage("456", [
      h.at("12345", { name: "Alice" }),
      h.text(" please check"),
    ]);

    assert.deepEqual(result, ["1"]);
    assert.equal(calls[0].payload.parse_mode, "HTML");
    assert.match(
      calls[0].payload.text,
      /<a href="tg:\/\/user\?id=12345">Alice<\/a>/,
    );
  });
});

test("telegram adapter keeps media first and spills oversized captions into follow-up text messages", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ method: string; payload: any }> = [];
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      return { message_id: String(calls.length) };
    };

    const result = await app.bots[0].sendMessage("456", [
      h.quote("77"),
      h.image("https://example.com/demo.png"),
      h.text("b".repeat(1030)),
    ]);

    assert.deepEqual(result, ["1", "2"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "sendPhoto");
    assert.equal(calls[0].payload.reply_to_message_id, "77");
    assert.equal(calls[0].payload.caption.length, 1024);
    assert.equal(calls[1].method, "sendMessage");
    assert.equal(calls[1].payload.reply_to_message_id, undefined);
    assert.equal(calls[1].payload.text, "b".repeat(6));
  });
});

test("telegram adapter sends sticker media without dropping following text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ method: string; payload: any }> = [];
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      return { message_id: String(calls.length) };
    };

    const result = await app.bots[0].sendMessage("456", [
      h("sticker", { src: "https://example.com/sticker.webp" }),
      h.text("caption after sticker"),
    ]);

    assert.deepEqual(result, ["1", "2"]);
    assert.equal(calls[0].method, "sendSticker");
    assert.equal(calls[0].payload.caption, undefined);
    assert.equal(calls[1].method, "sendMessage");
    assert.equal(calls[1].payload.text, "caption after sticker");
  });
});

test("onebot adapter renders merged-forward records as readable text", async () => {
  const rendered = runtime.renderOneBotForwardContent({
    messages: [
      {
        type: "node",
        data: {
          user_id: "1001",
          nickname: "Alice",
          content: [
            { type: "text", data: { text: "hello " } },
            { type: "image", data: { url: "https://example.com/a.png" } },
          ],
        },
      },
      {
        type: "node",
        data: {
          user_id: "1002",
          nickname: "Bob",
          content: "[CQ:at,qq=1001] received",
        },
      },
    ],
  });

  assert.equal(
    rendered,
    [
      "[merged forward]",
      "Alice(1001): hello",
      "  [image: https://example.com/a.png](https://example.com/a.png)",
      "Bob(1002): [@1001](at:1001) received",
    ].join("\n"),
  );
});

test("onebot inbound merged-forward segments are fetched and stored in session text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.adapters][0];
    adapter.callAction = async (action: string, params: any) => {
      assert.equal(action, "get_forward_msg");
      assert.deepEqual(params, { id: "forward-1" });
      return {
        messages: [
          {
            type: "node",
            data: {
              user_id: "1001",
              nickname: "Alice",
              content: "first message",
            },
          },
          {
            type: "node",
            data: {
              user_id: "1002",
              nickname: "Bob",
              content: [{ type: "text", data: { text: "second message" } }],
            },
          },
        ],
      };
    };

    const session = await adapter.buildSession({
      post_type: "message",
      message_type: "group",
      self_id: 1,
      group_id: 2000,
      user_id: 1000,
      message_id: 42,
      sender: { nickname: "Sender" },
      message: [
        { type: "text", data: { text: "please read " } },
        { type: "forward", data: { id: "forward-1" } },
      ],
    });

    assert.equal(session.elements[1]?.type, "forward");
    assert.equal(session.elements[1]?.attrs?.id, "forward-1");
    assert.equal(
      session.content,
      [
        "please read [forward: forward-1]",
        "Alice(1001): first message",
        "Bob(1002): second message",
      ].join("\n"),
    );
  });
});

test("onebot adapter degrades markdown formatting instead of exposing raw markdown", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ action: string; params: any }> = [];
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return { message_id: "m1" };
    };

    const result = await app.bots[0].sendMessage("private:2", [
      h.markdown(
        "**bold** [docs](https://example.com)\n- one\n1. first\n> quoted",
      ),
    ]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(calls[0].action, "send_private_msg");
    assert.equal(
      calls[0].params.message,
      "bold docs\n- one\n1. first\n> quoted",
    );
  });
});

test("onebot adapter renders structured at as native CQ mention", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ action: string; params: any }> = [];
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return { message_id: "m1" };
    };

    await app.bots[0].sendMessage("2", [
      h.at("12345", { name: "Alice" }),
      h.text(" hello"),
    ]);

    assert.equal(calls[0].action, "send_group_msg");
    assert.equal(calls[0].params.message, "[CQ:at,qq=12345] hello");
  });
});

test("onebot adapter stages all local media under the fixed chat-media directory", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const imagePath = path.join(agentDir, "avatar.png");
    const videoPath = path.join(agentDir, "clip.mp4");
    const filePath = path.join(agentDir, "notes.txt");
    const mediaDir = path.join(agentDir, "data", "chat-media", "onebot");
    const calls: Array<{ action: string; params: any }> = [];
    await fs.writeFile(imagePath, Buffer.from("png"));
    await fs.writeFile(videoPath, Buffer.from("mp4"));
    await fs.writeFile(filePath, Buffer.from("notes"));
    await fs.rm(mediaDir, { recursive: true, force: true });
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return { message_id: "m1" };
    };

    const result = await app.bots[0].sendMessage("private:2", [
      h.image(imagePath),
      h("video", { src: videoPath, name: "clip.mp4", mimeType: "video/mp4" }),
      h.file(filePath, "text/plain", { name: "notes.txt" }),
    ]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "send_private_msg");
    assert.doesNotMatch(calls[0].params.message, /runtime-cache/);
    assert.match(
      calls[0].params.message,
      /\[CQ:image,file=file:\/\/.*data\/chat-media\/onebot\/.*avatar\.png\]/,
    );
    assert.match(
      calls[0].params.message,
      /\[CQ:video,file=file:\/\/.*data\/chat-media\/onebot\/.*clip\.mp4\]/,
    );
    assert.match(
      calls[0].params.message,
      /\[CQ:file,file=file:\/\/.*data\/chat-media\/onebot\/.*notes\.txt\]/,
    );
    const stagedPaths = [
      ...calls[0].params.message.matchAll(/file:\/\/([^\]]+)/g),
    ].map((match) => decodeURIComponent(match[1] || ""));
    assert.equal(stagedPaths.length, 3);
    for (const stagedPath of stagedPaths) {
      await assert.doesNotReject(fs.stat(stagedPath));
    }
  });
});

test("onebot media action failures include the fixed Docker mount hint", () => {
  const message = runtime.formatOneBotActionFailureMessage(
    {
      status: "failed",
      retcode: 1200,
      message:
        "ENOENT: no such file or directory, open '/home/rin/.rin/data/chat-media/onebot/avatar.png'",
    },
    "send_private_msg",
    {
      message:
        "[CQ:image,file=file:///home/rin/.rin/data/chat-media/onebot/avatar.png]",
    },
  );

  assert.match(
    message,
    /OneBot\/NapCat \u65e0\u6cd5\u8bfb\u53d6 Rin \u7684\u672c\u5730\u5a92\u4f53\u6587\u4ef6/u,
  );
  assert.match(
    message,
    /-v "\$HOME\/\.rin\/data\/chat-media\/onebot:\$HOME\/\.rin\/data\/chat-media\/onebot:ro"/,
  );
});

test("discord adapter splits oversized text sends and keeps attachments on the first chunk", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "abc" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    adapter.fetchChannel = async () => ({
      send: async (payload: any) => {
        calls.push(payload);
        return { id: String(calls.length) };
      },
    });

    const result = await app.bots[0].sendMessage("456", [
      h.quote("88"),
      h.text("c".repeat(2005)),
      h.image("https://example.com/demo.png"),
      h("video", { src: "https://example.com/demo.mp4" }),
    ]);

    assert.deepEqual(result, ["1", "2"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].content.length, 2000);
    assert.equal(calls[0].files.length, 2);
    assert.equal(calls[0].reply.messageReference, "88");
    assert.equal(calls[1].content, "c".repeat(5));
    assert.equal(calls[1].files, undefined);
    assert.equal(calls[1].reply, undefined);
  });
});

test("lark adapter sends text and structured at as native markdown rich text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.at("ou_123", { name: "Alice" }),
      h.text(" hello"),
    ]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(calls[0].data.msg_type, "post");
    assert.deepEqual(JSON.parse(calls[0].data.content), {
      zh_cn: {
        content: [
          [
            {
              tag: "md",
              text: '<at user_id="ou_123">Alice</at> hello',
            },
          ],
        ],
      },
    });
  });
});

test("lark adapter sends quote nodes through the native reply endpoint", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(["create", payload]);
            return { data: { message_id: "created" } };
          },
          reply: async (payload: any) => {
            calls.push(["reply", payload]);
            return { data: { message_id: "reply-1" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.quote("om-parent"),
      h.text("follow up"),
    ]);

    assert.deepEqual(result, ["reply-1"]);
    assert.deepEqual(calls, [
      [
        "reply",
        {
          path: { message_id: "om-parent" },
          data: {
            msg_type: "post",
            content: JSON.stringify({
              zh_cn: { content: [[{ tag: "md", text: "follow up" }]] },
            }),
          },
        },
      ],
    ]);
  });
});

test("telegram working indicator retries clearing a stale reaction without current message metadata", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const calls: Array<{ method: string; payload: any }> = [];
    let failNextClear = true;
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      if (
        method === "setMessageReaction" &&
        Array.isArray(payload?.reaction) &&
        payload.reaction.length === 0 &&
        failNextClear
      ) {
        failNextClear = false;
        throw new Error("transient clear failure");
      }
      return {};
    };

    const [indicator] = app.bots[0].workingIndicators;
    await indicator.tick({ chatId: "456", messageId: "101", tick: 0 });
    await assert.rejects(
      indicator.end({ chatId: "456", messageId: "101" }),
      /transient clear failure/,
    );
    assert.equal(await indicator.end({ chatId: "456" }), true);

    assert.deepEqual(
      calls
        .filter((entry) => entry.method === "setMessageReaction")
        .map((entry) => entry.payload),
      [
        {
          chat_id: "456",
          message_id: 101,
          reaction: [{ type: "emoji", emoji: "🤔" }],
        },
        { chat_id: "456", message_id: 101, reaction: [] },
        { chat_id: "456", message_id: 101, reaction: [] },
      ],
    );
  });
});

test("onebot group working indicator retries clearing a stale reaction without current message metadata", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { endpoint: "ws://127.0.0.1:1" },
    });
    const adapter = [...app.adapters][0];
    const calls: Array<{ action: string; params: any }> = [];
    let failNextClear = true;
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      if (
        action === "set_msg_emoji_like" &&
        params?.set === false &&
        failNextClear
      ) {
        failNextClear = false;
        throw new Error("transient clear failure");
      }
      return {};
    };

    const [indicator] = app.bots[0].getWorkingIndicators({ chatId: "123" });
    await indicator.tick({ chatId: "123", messageId: "101", tick: 0 });
    await assert.rejects(
      indicator.end({ chatId: "123", messageId: "101" }),
      /transient clear failure/,
    );
    assert.equal(await indicator.end({ chatId: "123" }), true);

    assert.deepEqual(
      calls
        .filter((entry) => entry.action === "set_msg_emoji_like")
        .map((entry) => entry.params),
      [
        { message_id: 101, emoji_id: "212", set: true },
        { message_id: 101, emoji_id: "212", set: false },
        { message_id: 101, emoji_id: "212", set: false },
      ],
    );
  });
});

test("onebot private working indicator is a one-shot marker", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { endpoint: "ws://127.0.0.1:1" },
    });
    const adapter = [...app.adapters][0];
    const calls: any[] = [];
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return { message_id: "notice-1" };
    };

    const [indicator] = app.bots[0].getWorkingIndicators({
      chatId: "private:2",
    });

    assert.equal(indicator.type, "marker");
    assert.equal(typeof indicator.tick, "undefined");
    assert.equal(
      await indicator.start({ chatId: "private:2", messageId: "m1" }),
      true,
    );

    assert.deepEqual(calls, [
      {
        action: "send_private_msg",
        params: {
          user_id: 2,
          message: "[CQ:reply,id=m1]Working...",
          auto_escape: false,
        },
      },
    ]);
  });
});

test("discord working indicator replaces the previous reaction frame", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "abc" },
    });
    const adapter = [...app.adapters][0];
    const calls: any[] = [];
    adapter.fetchMessage = async () => ({
      react: async (emoji: string) => {
        calls.push(["create", emoji]);
      },
      reactions: {
        cache: {
          find: (predicate: any) =>
            predicate({ emoji: { name: "🤔" } })
              ? {
                  users: {
                    remove: async (userId: string) => {
                      calls.push(["delete", userId]);
                    },
                  },
                }
              : null,
        },
      },
    });

    const [indicator] = app.bots[0].workingIndicators;
    await indicator.tick({ chatId: "C1", messageId: "m1", tick: 0 });
    await indicator.tick({ chatId: "C1", messageId: "m1", tick: 1 });

    assert.deepEqual(calls, [
      ["create", "🤔"],
      ["delete", ""],
      ["create", "🔥"],
    ]);
  });
});

test("slack working indicator replaces the previous reaction frame", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "slack",
      name: "Slack",
      config: { token: "xapp", botToken: "xoxb" },
    });
    const adapter = [...app.adapters][0];
    const calls: any[] = [];
    adapter.web = {
      reactions: {
        add: async (payload: any) => {
          calls.push(["create", payload.name]);
        },
        remove: async (payload: any) => {
          calls.push(["delete", payload.name]);
        },
      },
    };

    const [indicator] = app.bots[0].workingIndicators;
    await indicator.tick({ chatId: "C1", messageId: "1.1", tick: 0 });
    await indicator.tick({ chatId: "C1", messageId: "1.1", tick: 1 });

    assert.deepEqual(calls, [
      ["create", "thinking_face"],
      ["delete", "thinking_face"],
      ["create", "fire"],
    ]);
  });
});

test("lark working indicator replaces the previous reaction frame", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const calls: any[] = [];
    adapter.client = {
      im: {
        messageReaction: {
          create: async (payload: any) => {
            calls.push(["create", payload]);
            return {};
          },
          list: async (payload: any) => {
            calls.push(["list", payload]);
            return {
              data: {
                items: [
                  {
                    reaction_id: "reaction-thinking",
                    reaction_type: { emoji_type: "THINKING" },
                    operator: { operator_type: "app" },
                  },
                ],
              },
            };
          },
          delete: async (payload: any) => {
            calls.push(["delete", payload]);
            return {};
          },
        },
      },
    };

    const [indicator] = app.bots[0].workingIndicators;
    await indicator.tick({ chatId: "oc_1", messageId: "om_1", tick: 0 });
    await indicator.tick({ chatId: "oc_1", messageId: "om_1", tick: 1 });

    assert.deepEqual(
      calls.map(([kind]) => kind),
      ["create", "list", "delete", "create"],
    );
    assert.equal(calls[0][1].data.reaction_type.emoji_type, "THINKING");
    assert.equal(calls[2][1].path.reaction_id, "reaction-thinking");
    assert.equal(calls[3][1].data.reaction_type.emoji_type, "Fire");
  });
});

test("lark adapter maps fire working reaction to the supported emoji type", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const calls: any[] = [];
    adapter.client = {
      im: {
        messageReaction: {
          create: async (payload: any) => {
            calls.push(payload);
            return {};
          },
        },
      },
    };

    assert.equal(await app.bots[0].createReaction("oc_1", "om_1", "🔥"), true);
    assert.equal(calls[0].data.reaction_type.emoji_type, "Fire");
  });
});

test("lark adapter sends markdown nodes as native markdown rich text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.markdown("**bold** [docs](https://example.com)"),
      h.text("\n"),
      h.at("ou_123", { name: "Alice" }),
    ]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(calls[0].data.msg_type, "post");
    assert.deepEqual(JSON.parse(calls[0].data.content), {
      zh_cn: {
        content: [
          [
            {
              tag: "md",
              text: '**bold** [docs](https://example.com)\n<at user_id="ou_123">Alice</at>',
            },
          ],
        ],
      },
    });
  });
});

test("lark adapter terminates markdown lists before following plain lines", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.markdown(
        "- first\nplain\n- second\nplain again\n```\n- not a list\nplain code\n```",
      ),
    ]);

    assert.deepEqual(result, ["m1"]);
    const content = JSON.parse(calls[0].data.content);
    assert.equal(
      content.zh_cn.content[0][0].text,
      "- first\n\nplain\n- second\n\nplain again\n```\n- not a list\nplain code\n```",
    );
  });
});

test("slack adapter splits oversized text posts into multiple threaded messages", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "slack",
      name: "Slack",
      config: { token: "xapp", botToken: "xoxb" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    adapter.web = {
      chat: {
        postMessage: async (payload: any) => {
          calls.push(payload);
          return { ts: String(calls.length) };
        },
      },
      files: {
        uploadV2: async () => {
          throw new Error("unexpected_upload");
        },
      },
    };

    const result = await app.bots[0].sendMessage("C123", [
      h.quote("99"),
      h.text("d".repeat(40005)),
    ]);

    assert.deepEqual(result, ["1", "2"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].text.length, 40000);
    assert.equal(calls[0].thread_ts, "99");
    assert.equal(calls[1].text, "d".repeat(5));
    assert.equal(calls[1].thread_ts, "99");
  });
});
