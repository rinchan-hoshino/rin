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

test("telegram adapter separates long-poll and outbound API fetch dispatchers", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const originalFetch = globalThis.fetch;
    const calls: Array<{ method: string; dispatcher: unknown }> = [];
    try {
      (globalThis as any).fetch = async (url: string, init: any) => {
        const method = safeTelegramMethod(url);
        calls.push({ method, dispatcher: init?.dispatcher });
        return new Response(
          JSON.stringify({
            ok: true,
            result: method === "getUpdates" ? [] : { message_id: "1" },
          }),
          { headers: { "content-type": "application/json" } },
        );
      };

      await adapter.callApi("getUpdates", { timeout: 25 });
      await adapter.callApi("sendMessage", { chat_id: "456", text: "hi" });

      assert.deepEqual(
        calls.map((entry) => entry.method),
        ["getUpdates", "sendMessage"],
      );
      assert.ok(calls[0].dispatcher);
      assert.ok(calls[1].dispatcher);
      assert.notEqual(calls[0].dispatcher, calls[1].dispatcher);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function safeTelegramMethod(url: string) {
  return String(url).split("/").pop() || "";
}

function requireEditableIndicator(bot: any) {
  const indicator = bot.workingIndicators.find(
    (item: any) => item?.presentation === "editable-message",
  );
  assert.ok(indicator, "expected an editable-message working indicator");
  return indicator;
}

function requireReactionIndicator(bot: any) {
  const indicator = bot.workingIndicators.find(
    (item: any) => item?.presentation === "reaction",
  );
  assert.ok(indicator, "expected a reaction working indicator");
  return indicator;
}

test("discord adapter deletes visible progress before final text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "discord-token" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    const messages = new Map<string, any>();
    const channel = {
      sendTyping: async () => calls.push({ method: "sendTyping" }),
      send: async (payload: any) => {
        const id = String(messages.size + 1);
        const message = {
          id,
          payload,
          edit: async (nextPayload: any) => {
            calls.push({ method: "edit", id, payload: nextPayload });
            message.payload = nextPayload;
            return message;
          },
        };
        messages.set(id, message);
        calls.push({ method: "send", id, payload });
        return message;
      },
      messages: {
        fetch: async (id: string) => messages.get(id),
        delete: async (id: string) => calls.push({ method: "delete", id }),
      },
    };
    adapter.client = { channels: { fetch: async () => channel } };

    const editable = requireEditableIndicator(app.bots[0]);
    await editable.tick({ chatId: "C1", tick: 0 });
    const result = await app.bots[0].sendMessage("C1", [h.text("done")]);

    assert.deepEqual(result, ["2"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send", "delete", "send"],
    );
    assert.equal(calls[0].payload.content, "Working...");
    assert.equal(calls[1].id, "1");
    assert.equal(calls[2].payload.content, "done");
  });
});

test("discord adapter deletes visible progress before final media", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "discord-token" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    const messages = new Map<string, any>();
    const channel = {
      send: async (payload: any) => {
        const id = String(messages.size + 1);
        const message = { id, payload };
        messages.set(id, message);
        calls.push({ method: "send", id, payload });
        return message;
      },
      messages: {
        fetch: async (id: string) => messages.get(id),
        delete: async (id: string) => calls.push({ method: "delete", id }),
      },
    };
    adapter.client = { channels: { fetch: async () => channel } };

    const editable = requireEditableIndicator(app.bots[0]);
    await editable.tick({ chatId: "C1", tick: 0 });
    const result = await app.bots[0].sendMessage("C1", [
      h.image("https://example.com/demo.png"),
    ]);

    assert.deepEqual(result, ["2"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send", "delete", "send"],
    );
    assert.equal(calls[0].payload.content, "Working...");
    assert.equal(calls[1].id, "1");
    assert.deepEqual(calls[2].payload.files, ["https://example.com/demo.png"]);
  });
});

test("slack adapter deletes visible progress before final text", async () => {
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
          calls.push({ method: "postMessage", payload });
          return { ts: String(calls.length) };
        },
        update: async (payload: any) => {
          calls.push({ method: "update", payload });
          return { ts: payload.ts };
        },
        delete: async (payload: any) => {
          calls.push({ method: "delete", payload });
          return { ok: true };
        },
      },
      files: { uploadV2: async () => ({ files: [{ id: "F1" }] }) },
    };

    const editable = requireEditableIndicator(app.bots[0]);
    await editable.tick({ chatId: "C123", tick: 0 });
    const result = await app.bots[0].sendMessage("C123", [h.text("done")]);

    assert.deepEqual(result, ["3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["postMessage", "delete", "postMessage"],
    );
    assert.equal(calls[0].payload.text, "Working...");
    assert.equal(calls[1].payload.channel, "C123");
    assert.equal(calls[1].payload.ts, "1");
    assert.equal(calls[2].payload.channel, "C123");
    assert.equal(calls[2].payload.text, "done");
  });
});

test("slack adapter deletes visible progress before final media", async () => {
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
          calls.push({ method: "postMessage", payload });
          return { ts: String(calls.length) };
        },
        update: async (payload: any) => {
          calls.push({ method: "update", payload });
          return { ts: payload.ts };
        },
        delete: async (payload: any) => {
          calls.push({ method: "delete", payload });
          return { ok: true };
        },
      },
      files: { uploadV2: async () => ({ files: [{ id: "F1" }] }) },
    };

    const editable = requireEditableIndicator(app.bots[0]);
    await editable.tick({ chatId: "C123", tick: 0 });
    const result = await app.bots[0].sendMessage("C123", [
      h.image("https://example.com/demo.png"),
    ]);

    assert.deepEqual(result, ["3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["postMessage", "delete", "postMessage"],
    );
    assert.equal(calls[0].payload.text, "Working...");
    assert.equal(calls[1].payload.ts, "1");
    assert.equal(calls[2].payload.text, "https://example.com/demo.png");
  });
});

test("lark adapter deletes visible progress before final text", async () => {
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
            calls.push({ method: "create", payload });
            const count = calls.filter(
              (entry) => entry.method === "create",
            ).length;
            return { data: { message_id: `m${count}` } };
          },
          update: async (payload: any) => {
            calls.push({ method: "update", payload });
            return { data: { message_id: payload.path.message_id } };
          },
          delete: async (payload: any) => {
            calls.push({ method: "delete", payload });
            return { ok: true };
          },
        },
      },
    };

    const editable = requireEditableIndicator(app.bots[0]);
    await editable.tick({ chatId: "oc_1", tick: 0 });
    const result = await app.bots[0].sendMessage("oc_1", [h.text("done")]);

    assert.deepEqual(result, ["m2"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["create", "delete", "create"],
    );
    assert.equal(calls[0].payload.data.receive_id, "oc_1");
    assert.equal(calls[1].payload.path.message_id, "m1");
    assert.equal(calls[2].payload.data.receive_id, "oc_1");
    assert.match(calls[2].payload.data.content, /done/);
  });
});

test("telegram adapter edits progress updates then deletes them before sending final text", async () => {
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
      if (method === "sendMessage") return { message_id: String(calls.length) };
      return { message_id: payload?.message_id };
    };

    await app.bots[0].workingIndicators[1].tick({ chatId: "456", tick: 0 });
    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    const todoResult = await app.bots[0].sendMessage(
      "456",
      [h.text("[ ] first task")],
      { deliveryKind: "passive_notice", coalesceWithWorkingMessage: true },
    );
    await app.bots[0].workingIndicators[1].tick({ chatId: "456", tick: 6 });
    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 6 });
    const finalResult = await app.bots[0].sendMessage("456", [h.text("done")]);

    assert.deepEqual(todoResult, ["2"]);
    assert.deepEqual(finalResult, ["6"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      [
        "sendChatAction",
        "sendMessage",
        "editMessageText",
        "sendChatAction",
        "deleteMessage",
        "sendMessage",
      ],
    );
    assert.equal(calls[1].payload.text, "Working...");
    assert.equal(calls[2].payload.message_id, 2);
    assert.equal(calls[2].payload.text, "[ ] first task");
    assert.equal(calls[4].payload.message_id, 2);
    assert.equal(calls[5].payload.text, "done");
  });
});

test("telegram adapter scopes forum topic sessions and outbound payloads", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "8301813220:abc" },
    });
    const adapter = [...app.adapters][0];
    app.bots[0].selfId = "8301813220";

    await adapter.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        date: 1783321200,
        message_thread_id: 184,
        is_topic_message: true,
        chat: {
          id: -1003852739541,
          type: "supergroup",
          title: "Committee",
        },
        from: { id: 663068439, username: "meoooqwq" },
        text: "hello topic",
      },
    });

    const pendingDir = path.join(agentDir, "data", "chat", "inbox", "pending");
    const [fileName] = await fs.readdir(pendingDir);
    const inboxItem = JSON.parse(
      await fs.readFile(path.join(pendingDir, fileName), "utf8"),
    );
    assert.equal(
      inboxItem.chatKey,
      "telegram/8301813220:-1003852739541?thread=184",
    );
    assert.equal(inboxItem.routing.messageThreadId, "184");
    assert.equal(inboxItem.session.messageThreadId, "184");
    assert.equal(inboxItem.session.chatThreadId, "184");
    assert.equal(inboxItem.session.isTopicMessage, true);

    const h = runtime.createChatRuntimeH();
    const calls: Array<{ method: string; payload: any }> = [];
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      return { message_id: String(calls.length) };
    };

    await app.bots[0].workingIndicators[1].tick({
      chatId: "-1003852739541?thread=184",
    });
    await app.bots[0].workingIndicators[0].tick({
      chatId: "-1003852739541?thread=184",
      tick: 0,
    });
    const result = await app.bots[0].sendMessage("-1003852739541?thread=184", [
      h.text("topic reply"),
    ]);

    assert.deepEqual(result, ["4"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendChatAction", "sendMessage", "deleteMessage", "sendMessage"],
    );
    assert.equal(calls[0].payload.chat_id, "-1003852739541");
    assert.equal(calls[0].payload.message_thread_id, 184);
    assert.equal(calls[1].payload.chat_id, "-1003852739541");
    assert.equal(calls[1].payload.message_thread_id, 184);
    assert.equal(calls[2].payload.chat_id, "-1003852739541");
    assert.equal(calls[3].payload.chat_id, "-1003852739541");
    assert.equal(calls[3].payload.message_thread_id, 184);
    assert.equal(calls[3].payload.text, "topic reply");
  });
});

test("telegram adapter clears coalesced todo when final reply is media-only", async () => {
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
      if (method === "sendMessage" || method === "sendPhoto") {
        return { message_id: String(calls.length) };
      }
      return { message_id: payload?.message_id };
    };

    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    const todoResult = await app.bots[0].sendMessage(
      "456",
      [h.text("[ ] first task")],
      { deliveryKind: "passive_notice", coalesceWithWorkingMessage: true },
    );
    const finalResult = await app.bots[0].sendMessage("456", [
      h.image("https://example.com/demo.png"),
    ]);

    assert.deepEqual(todoResult, ["1"]);
    assert.deepEqual(finalResult, ["4"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage", "editMessageText", "deleteMessage", "sendPhoto"],
    );
    assert.equal(calls[1].payload.message_id, 1);
    assert.equal(calls[1].payload.text, "[ ] first task");
    assert.equal(calls[2].payload.message_id, 1);
  });
});

test("telegram adapter end handler clears visible working text without todo context", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const calls: Array<{ method: string; payload: any }> = [];
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      if (method === "sendMessage") return { message_id: "1" };
      return { message_id: payload?.message_id };
    };

    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    const cleared = await app.bots[0].workingIndicators[0].end({
      chatId: "456",
    });

    assert.equal(cleared, true);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage", "deleteMessage"],
    );
    assert.equal(calls[1].payload.message_id, 1);
  });
});

test("telegram adapter deletes progress before sending oversized final text chunks", async () => {
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
      if (method === "sendMessage") return { message_id: String(calls.length) };
      return { message_id: payload?.message_id };
    };

    await app.bots[0].workingIndicators[1].tick({ chatId: "456", tick: 0 });
    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    const result = await app.bots[0].sendMessage("456", [
      h.text("a".repeat(4100)),
    ]);

    assert.deepEqual(result, ["4", "5"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      [
        "sendChatAction",
        "sendMessage",
        "deleteMessage",
        "sendMessage",
        "sendMessage",
      ],
    );
    assert.equal(calls[2].payload.message_id, 2);
    assert.equal(calls[3].payload.text.length, 4096);
    assert.equal(calls[4].payload.text.length, 4);
    assert.equal(
      `${calls[3].payload.text}${calls[4].payload.text}`.length,
      4100,
    );
  });
});

test("telegram adapter splits oversized direct text and keeps the reply on the first send", async () => {
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
    assert.equal(calls[1].payload.text.length, 4);
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

test("telegram adapter splits text and image rich parts in order", async () => {
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

    const leading = "\u4e0b\u56fe\u662f\u8bf4\u660e\u5bf9\u8c61\uff1a";
    const trailing = "\u540e\u9762\u8fd9\u53e5\u4e0d\u662f\u56fe\u7247 caption";
    const result = await app.bots[0].sendMessage("456", [
      h.quote("77"),
      h.markdown(
        `${leading}[image: demo](https://example.com/demo.png)\n${trailing}`,
      ),
    ]);

    assert.deepEqual(result, ["1", "2", "3"]);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].method, "sendMessage");
    assert.equal(calls[0].payload.reply_to_message_id, "77");
    assert.equal(calls[0].payload.text, leading);
    assert.equal(calls[1].method, "sendPhoto");
    assert.equal(calls[1].payload.photo, "https://example.com/demo.png");
    assert.equal(calls[1].payload.caption, undefined);
    assert.equal(calls[1].payload.reply_to_message_id, undefined);
    assert.equal(calls[2].method, "sendMessage");
    assert.equal(calls[2].payload.text, trailing);
    assert.equal(calls[2].payload.reply_to_message_id, undefined);
  });
});

test("telegram adapter reports a failed rich segment and continues later segments", async () => {
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

    const missingPath = path.join(agentDir, "missing.png");
    const result = await app.bots[0].sendMessage("456", [
      h.quote("77"),
      h.markdown(
        `leading text [image: missing](${missingPath})\ntrailing text`,
      ),
    ]);

    assert.deepEqual(result, ["1", "2", "3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage", "sendMessage", "sendMessage"],
    );
    assert.equal(calls[0].payload.reply_to_message_id, "77");
    assert.equal(calls[0].payload.text, "leading text");
    assert.match(calls[1].payload.text, /chat_media_file_missing:/);
    assert.match(calls[1].payload.text, /missing\.png/);
    assert.doesNotMatch(
      calls[1].payload.text,
      /\u5bcc\u6587\u672c\u7247\u6bb5\u53d1\u9001\u5931\u8d25/,
    );
    assert.equal(calls[1].payload.parse_mode, undefined);
    assert.equal(calls[1].payload.reply_to_message_id, undefined);
    assert.equal(calls[2].payload.text, "trailing text");
  });
});

test("telegram adapter sends media before following text", async () => {
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
    assert.equal(calls[0].payload.caption, undefined);
    assert.equal(calls[1].method, "sendMessage");
    assert.equal(calls[1].payload.reply_to_message_id, undefined);
    assert.equal(calls[1].payload.text, "b".repeat(1030));
  });
});

test("telegram adapter clears stale working text after media-only final replies", async () => {
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

    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    const result = await app.bots[0].sendMessage("456", [
      h.image("https://example.com/demo.png"),
    ]);

    assert.deepEqual(result, ["3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage", "deleteMessage", "sendPhoto"],
    );
    assert.equal(calls[1].payload.message_id, 1);
  });
});

test("telegram adapter retries local photos as documents when Telegram rejects dimensions", async () => {
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
      if (method === "sendPhoto") {
        throw new Error("Bad Request: PHOTO_INVALID_DIMENSIONS");
      }
      return { message_id: String(calls.length) };
    };

    const result = await app.bots[0].sendMessage("456", [
      h.quote("77"),
      h("image", {
        data: Buffer.from("original image bytes"),
        name: "original.png",
        mimeType: "image/png",
      }),
    ]);

    assert.deepEqual(result, ["2"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "sendPhoto");
    assert.equal(calls[0].payload.chat_id, "456");
    assert.equal(calls[0].payload.reply_to_message_id, "77");
    assert.ok(calls[0].payload.photo);
    assert.equal(calls[0].payload.photo.filename, "original.png");
    assert.equal(calls[0].payload.document, undefined);
    assert.equal(calls[1].method, "sendDocument");
    assert.equal(calls[1].payload.chat_id, "456");
    assert.equal(calls[1].payload.reply_to_message_id, "77");
    assert.equal(calls[1].payload.photo, undefined);
    assert.ok(calls[1].payload.document);
    assert.equal(calls[1].payload.document.filename, "original.png");
  });
});

test("telegram adapter retries remote photos as documents when Telegram rejects dimensions", async () => {
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
      if (method === "sendPhoto") {
        throw new Error("Bad Request: PHOTO_INVALID_DIMENSIONS");
      }
      return { message_id: String(calls.length) };
    };

    const result = await app.bots[0].sendMessage("456", [
      h.quote("77"),
      h.image("https://example.com/too-tall.png"),
    ]);

    assert.deepEqual(result, ["2"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendPhoto", "sendDocument"],
    );
    assert.equal(calls[0].payload.photo, "https://example.com/too-tall.png");
    assert.equal(calls[0].payload.reply_to_message_id, "77");
    assert.equal(calls[1].payload.document, "https://example.com/too-tall.png");
    assert.equal(calls[1].payload.reply_to_message_id, "77");
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
    assert.equal(
      calls[0].params.timeout,
      runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
    );
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

test("onebot adapter exposes media send dispatch before the OneBot echo", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const filePath = path.join(agentDir, "pack.mrpack");
    await fs.writeFile(filePath, Buffer.from("pack"));
    let resolveAction: (value: any) => void = () => {};
    adapter.callAction = () => {
      const action = new Promise((resolve) => {
        resolveAction = resolve;
      }) as Promise<any> & { dispatched?: Promise<void> };
      action.dispatched = Promise.resolve();
      return action;
    };

    const delivery = app.bots[0].sendMessage("2", [
      h.file(filePath, "application/octet-stream", { name: "pack.mrpack" }),
    ]);

    assert.equal(typeof delivery?.dispatched?.then, "function");
    await delivery.dispatched;
    resolveAction({ message_id: "m1" });
    assert.deepEqual(await delivery, ["m1"]);
  });
});

test("onebot media actions use the extended action timeout", () => {
  assert.equal(
    runtime.oneBotActionTimeoutMs("send_group_msg", { message: "plain text" }),
    runtime.ONEBOT_ACTION_TIMEOUT_MS,
  );
  assert.equal(
    runtime.oneBotActionTimeoutMs("send_group_msg", {
      message:
        "[CQ:file,file=file:///home/rin/.rin/data/chat-media/onebot/pack.mrpack]",
    }),
    runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
  );
  assert.equal(
    runtime.oneBotActionTimeoutMs("upload_group_file", {
      file: "/app/napcat/cache/pack.mrpack",
    }),
    runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
  );
});

test("onebot send and upload actions pass bounded timeouts into NapCat payloads", () => {
  assert.equal(
    runtime.withOneBotActionTimeoutParam("send_group_msg", {
      message: "plain text",
    }).timeout,
    runtime.ONEBOT_ACTION_TIMEOUT_MS,
  );
  for (const action of ["send_private_msg", "send_group_msg", "send_msg"]) {
    assert.equal(
      runtime.withOneBotActionTimeoutParam(action, {
        message:
          "[CQ:image,file=file:///home/rin/.rin/data/chat-media/onebot/card.png]",
      }).timeout,
      runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
    );
  }
  for (const action of ["upload_private_file", "upload_group_file"]) {
    assert.equal(
      runtime.withOneBotActionTimeoutParam(action, {
        file: "/home/rin/.rin/data/chat-media/onebot/card.png",
      }).timeout,
      runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
    );
  }
  assert.equal(
    runtime.withOneBotActionTimeoutParam("get_msg", { message_id: 1 }).timeout,
    undefined,
  );
  assert.equal(
    runtime.withOneBotActionTimeoutParam("send_group_msg", {
      message:
        "[CQ:image,file=file:///home/rin/.rin/data/chat-media/onebot/card.png]",
      timeout: 42,
    }).timeout,
    42,
  );
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
    { message: "plain text without local media" },
  );

  assert.match(message, /OneBot\/NapCat cannot read Rin's local media file/u);
  assert.match(
    message,
    /-v "\$HOME\/\.rin\/data\/chat-media\/onebot:\$HOME\/\.rin\/data\/chat-media\/onebot:ro"/,
  );
});

test("onebot generic file-word failures do not get local media hints", () => {
  const message = runtime.formatOneBotActionFailureMessage(
    {
      status: "failed",
      retcode: 1200,
      message: "Timeout while sending file list update",
    },
    "send_group_msg",
    { message: "plain text without local media" },
  );

  assert.equal(message, "Timeout while sending file list update");
});

test("onebot media send timeouts do not get local media visibility hints", () => {
  const message = runtime.formatOneBotActionFailureMessage(
    {
      status: "failed",
      retcode: 1200,
      message: "Timeout while sending file list update",
    },
    "send_group_msg",
    {
      message:
        "[CQ:file,file=file:///home/rin/.rin/data/chat-media/onebot/pack.mrpack]",
    },
  );

  assert.equal(message, "Timeout while sending file list update");
});

test("discord adapter splits text and media into ordered messages", async () => {
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

    assert.deepEqual(result, ["1", "2", "3", "4"]);
    assert.equal(calls.length, 4);
    assert.equal(calls[0].content.length, 2000);
    assert.equal(calls[0].files, undefined);
    assert.equal(calls[0].reply.messageReference, "88");
    assert.equal(calls[1].content, "c".repeat(5));
    assert.equal(calls[1].files, undefined);
    assert.equal(calls[1].reply, undefined);
    assert.deepEqual(calls[2].files, ["https://example.com/demo.png"]);
    assert.deepEqual(calls[3].files, ["https://example.com/demo.mp4"]);
  });
});

test("discord adapter keeps media before following text", async () => {
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
      h.image("https://example.com/demo.png"),
      h.text("caption after image"),
    ]);

    assert.deepEqual(result, ["1", "2"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].content, undefined);
    assert.deepEqual(calls[0].files, ["https://example.com/demo.png"]);
    assert.equal(calls[0].reply.messageReference, "88");
    assert.equal(calls[1].content, "caption after image");
    assert.equal(calls[1].files, undefined);
    assert.equal(calls[1].reply, undefined);
  });
});

test("discord adapter reports a failed rich segment and continues later segments", async () => {
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
      h.text("leading text"),
      h.image(path.join(agentDir, "missing.png")),
      h.text("trailing text"),
    ]);

    assert.deepEqual(result, ["1", "2", "3"]);
    assert.equal(calls[0].content, "leading text");
    assert.match(calls[1].content, /chat_media_file_missing:/);
    assert.match(calls[1].content, /missing\.png/);
    assert.doesNotMatch(
      calls[1].content,
      /\u5bcc\u6587\u672c\u7247\u6bb5\u53d1\u9001\u5931\u8d25/,
    );
    assert.equal(calls[2].content, "trailing text");
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

test("telegram working indicator sends typing and visible working text without reactions", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const calls: Array<{ method: string; payload: any }> = [];
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      return { message_id: "201" };
    };

    const [workingIndicator, typingIndicator] = app.bots[0].workingIndicators;
    assert.equal(
      await typingIndicator.tick({ chatId: "456", messageId: "101", tick: 0 }),
      true,
    );
    assert.equal(
      await workingIndicator.tick({ chatId: "456", messageId: "101", tick: 0 }),
      true,
    );
    assert.equal(
      await workingIndicator.end({ chatId: "456", messageId: "101" }),
      true,
    );

    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendChatAction", "sendMessage", "deleteMessage"],
    );
    assert.equal(calls[0].payload.action, "typing");
    assert.equal(calls[1].payload.reply_to_message_id, "101");
    assert.equal(calls[1].payload.text, "Working...");
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

    const indicator = requireReactionIndicator(app.bots[0]);
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

    const indicator = requireReactionIndicator(app.bots[0]);
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

    const indicator = requireReactionIndicator(app.bots[0]);
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

test("lark adapter preserves nested markdown list indentation and links", async () => {
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
        "- first\n  - child [docs](https://example.com)\n  - second child\n- second",
      ),
    ]);

    assert.deepEqual(result, ["m1"]);
    const content = JSON.parse(calls[0].data.content);
    assert.equal(
      content.zh_cn.content[0][0].text,
      "- first\n  - child [docs](https://example.com)\n  - second child\n- second",
    );
  });
});

test("slack adapter keeps media before following text", async () => {
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
      h.image("https://example.com/demo.png"),
      h.text("caption after image"),
    ]);

    assert.deepEqual(result, ["1", "2"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].text, "https://example.com/demo.png");
    assert.equal(calls[0].thread_ts, "99");
    assert.equal(calls[1].text, "caption after image");
    assert.equal(calls[1].thread_ts, "99");
  });
});

test("slack adapter sends todo nodes as Block Kit checkboxes", async () => {
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
      h("todo", {
        title: "Todo",
        items: [
          { text: "Keep working", done: false },
          { text: "Ship renderer", done: true },
        ],
      }),
    ]);

    assert.deepEqual(result, ["1"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, "C123");
    assert.equal(calls[0].thread_ts, "99");
    assert.equal(calls[0].text, "Todo\n⏹️ Keep working\n✅ ~~Ship renderer~~");
    assert.equal(calls[0].blocks[0].text.text, "*Todo*");
    const checkbox = calls[0].blocks[1].elements[0];
    assert.equal(checkbox.type, "checkboxes");
    assert.deepEqual(
      checkbox.options.map((option: any) => option.text.text),
      ["Keep working", "Ship renderer"],
    );
    assert.deepEqual(
      checkbox.initial_options.map((option: any) => option.value),
      ["todo_1"],
    );
    assert.equal(calls[0].blocks.length, 2);
  });
});

test("slack adapter reports a failed rich segment and continues later segments", async () => {
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
      h.text("leading text"),
      h.image(path.join(agentDir, "missing.png")),
      h.text("trailing text"),
    ]);

    assert.deepEqual(result, ["1", "2", "3"]);
    assert.equal(calls[0].text, "leading text");
    assert.match(calls[1].text, /chat_media_file_missing:/);
    assert.match(calls[1].text, /missing\.png/);
    assert.doesNotMatch(
      calls[1].text,
      /\u5bcc\u6587\u672c\u7247\u6bb5\u53d1\u9001\u5931\u8d25/,
    );
    assert.equal(calls[2].text, "trailing text");
  });
});

test("slack adapter splits leading text before local file uploads", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "slack",
      name: "Slack",
      config: { token: "xapp", botToken: "xoxb" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const imagePath = path.join(agentDir, "demo.png");
    await fs.writeFile(imagePath, Buffer.from("png"));
    const posts: any[] = [];
    const uploads: any[] = [];
    adapter.web = {
      chat: {
        postMessage: async (payload: any) => {
          posts.push(payload);
          return { ts: String(posts.length) };
        },
      },
      files: {
        uploadV2: async (payload: any) => {
          uploads.push(payload);
          return { files: [{ id: "F1" }] };
        },
      },
    };

    const result = await app.bots[0].sendMessage("C123", [
      h.quote("99"),
      h.text("leading text"),
      h.image(imagePath),
    ]);

    assert.deepEqual(result, ["1", "F1"]);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].text, "leading text");
    assert.equal(posts[0].thread_ts, "99");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].initial_comment, undefined);
    assert.equal(uploads[0].filename, "demo.png");
    assert.equal(uploads[0].thread_ts, "99");
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
