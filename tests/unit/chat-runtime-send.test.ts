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

test("onebot adapter strips markdown formatting instead of exposing raw markdown", async () => {
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
      h.markdown("**bold** [docs](https://example.com)"),
    ]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(calls[0].action, "send_private_msg");
    assert.equal(calls[0].params.message, "bold docs");
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

test("lark adapter renders structured at using Lark at tags", async () => {
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
    assert.equal(calls[0].data.msg_type, "text");
    assert.equal(
      JSON.parse(calls[0].data.content).text,
      '<at user_id="ou_123">Alice</at> hello',
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
