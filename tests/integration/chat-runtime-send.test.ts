import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const runtime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js"))
    .href
);
const { EditableTextMessageGroup } = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "chat-runtime",
      "editable-text-message-group.js",
    ),
  ).href
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
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

test("telegram adapter separates long-poll and outbound API transports", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const pollTransport = adapter.pollTransport;
    const apiTransport = adapter.apiTransport;
    assert.notEqual(pollTransport, apiTransport);
    let pollClosed = 0;
    let apiClosed = 0;
    const closePollTransport = pollTransport.close;
    const closeApiTransport = apiTransport.close;
    pollTransport.close = async () => {
      pollClosed += 1;
      await closePollTransport();
    };
    apiTransport.close = async () => {
      apiClosed += 1;
      await closeApiTransport();
    };
    const calls: Array<{ method: string; transport: string }> = [];
    pollTransport.fetch = async (url: string) => {
      const method = safeTelegramMethod(url);
      calls.push({ method, transport: "poll" });
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        headers: { "content-type": "application/json" },
      });
    };
    apiTransport.fetch = async (url: string) => {
      const method = safeTelegramMethod(url);
      calls.push({ method, transport: "api" });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: "1" } }),
        { headers: { "content-type": "application/json" } },
      );
    };

    try {
      await adapter.callApi("getUpdates", { timeout: 25 });
      await adapter.callApi("sendMessage", { chat_id: "456", text: "hi" });

      assert.deepEqual(calls, [
        { method: "getUpdates", transport: "poll" },
        { method: "sendMessage", transport: "api" },
      ]);
    } finally {
      await app.stop();
    }
    assert.equal(pollClosed, 1);
    assert.equal(apiClosed, 1);
  });
});

test("telegram adapter includes explicit topic thread id when sending media", async () => {
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
      return { message_id: "media-1" };
    };

    const result = await app.bots[0].sendMessage(
      "-100123",
      [h.image("https://example.com/demo.png")],
      { messageThreadId: "193" },
    );

    assert.deepEqual(result, ["media-1"]);
    assert.equal(calls[0].method, "sendPhoto");
    assert.equal(calls[0].payload.chat_id, "-100123");
    assert.equal(calls[0].payload.message_thread_id, 193);
    assert.equal(calls[0].payload.photo, "https://example.com/demo.png");
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

test("editable progress indicator lets adapters map tick input without owning lifecycle cleanup", async () => {
  await withTempDir(async (cacheDir) => {
    const calls: any[] = [];
    const group = new EditableTextMessageGroup({
      cacheDir,
      cacheScope: "mapped-indicator",
      maxTextLength: 2_000,
      sendText: async (input: any) => {
        calls.push({ method: "send", input });
        return "progress-1";
      },
      editText: async (input: any) => {
        calls.push({ method: "edit", input });
        return input.messageId;
      },
      deleteMessage: async (input: any) => {
        calls.push({ method: "delete", input });
      },
    });
    const indicator = group.indicator({
      prepareTick: (context: any, input: any) => ({
        ...input,
        chatId: `${context.chatId}:topic:${context.threadId}`,
        text: `<b>${input.text}</b>`,
        replyToMessageId: context.replyToMessageId,
        key: "topic-progress",
        todoText: undefined,
        todoTextChunks: context.todoNoticeText
          ? [`<i>${context.todoNoticeText}</i>`]
          : [],
      }),
    });

    assert.equal(
      await indicator.tick({
        chatId: "C1",
        threadId: "T1",
        replyToMessageId: "owner-1",
        todoNoticeText: "todo",
        tick: 0,
      }),
      true,
    );
    assert.equal(
      await indicator.tick({
        chatId: "C1",
        threadId: "T1",
        replyToMessageId: "owner-2",
        todoNoticeText: "todo",
        tick: 1,
      }),
      false,
    );
    assert.equal(await indicator.end({ chatId: "C1" }), false);

    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send"],
    );
    assert.deepEqual(calls[0].input, {
      chatId: "C1:topic:T1",
      text: "<b>... Working...</b>\n\n────────\n\n<i>todo</i>",
      replyToMessageId: "owner-1",
    });
  });
});

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
    assert.equal(calls[0].payload.content, "... Working...");
    assert.equal(calls[1].id, "1");
    assert.equal(calls[2].payload.content, "done");
  });
});

test("discord adapter replaces editable Working with assistant summary", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "discord-token" },
    });
    const adapter = [...app.adapters][0];
    const calls: any[] = [];
    const messages = new Map<string, any>();
    const channel = {
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
    await editable.tick({
      chatId: "C1",
      tick: 1,
      assistantSummaryText: "**Designing casual greeting response**",
    });
    await editable.tick({
      chatId: "C1",
      tick: 2,
      assistantSummaryText: "**Designing casual greeting response**",
      workingStatusText: "Compacting...",
    });
    await editable.tick({
      chatId: "C1",
      tick: 3,
      assistantSummaryText: "**Designing casual greeting response**",
    });

    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send", "edit", "edit", "edit"],
    );
    assert.equal(calls[0].payload.content, "... Working...");
    assert.equal(
      calls[1].payload.content,
      "... **Designing casual greeting response**",
    );
    assert.equal(calls[2].payload.content, "... Compacting...");
    assert.equal(
      calls[3].payload.content,
      "... **Designing casual greeting response**",
    );
  });
});

test("discord adapter preserves markdown indentation", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "discord-token" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    adapter.client = {
      channels: {
        fetch: async () => ({
          send: async (payload: any) => {
            calls.push(payload);
            return { id: "m1" };
          },
        }),
      },
    };
    const markdown =
      "    root code\n\n- parent\n  - child\n    continuation\n\n    nested code";

    const result = await app.bots[0].sendMessage("C1", [h.markdown(markdown)]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(calls[0].content, markdown);
  });
});

test("discord adapter preserves indentation after a text split", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "discord-token" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    adapter.client = {
      channels: {
        fetch: async () => ({
          send: async (payload: any) => {
            calls.push(payload);
            return { id: `m${calls.length}` };
          },
        }),
      },
    };

    const result = await app.bots[0].sendMessage("C1", [
      h.markdown(`${"x".repeat(1998)}\n  nested`),
    ]);

    assert.deepEqual(result, ["m1", "m2"]);
    assert.deepEqual(
      calls.map((payload) => payload.content),
      ["x".repeat(1998), "  nested"],
    );
  });
});

test("discord adapter waits for in-flight editable progress before final cleanup", async () => {
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
    let nextId = 1;
    let releaseWorking!: () => void;
    const workingBlocked = new Promise<void>((resolve) => {
      releaseWorking = resolve;
    });
    let workingSendStarted!: () => void;
    const workingSendStartedPromise = new Promise<void>((resolve) => {
      workingSendStarted = resolve;
    });
    const channel = {
      send: async (payload: any) => {
        const id = String(nextId++);
        const message = {
          id,
          payload,
          edit: async (nextPayload: any) => {
            calls.push({ method: "edit", id, payload: nextPayload });
            message.payload = nextPayload;
            return message;
          },
        };
        calls.push({ method: "send", id, payload });
        if (payload?.content === "... Working...") {
          workingSendStarted();
          await workingBlocked;
        }
        messages.set(id, message);
        return message;
      },
      messages: {
        fetch: async (id: string) => messages.get(id),
        delete: async (id: string) => calls.push({ method: "delete", id }),
      },
    };
    adapter.client = { channels: { fetch: async () => channel } };

    const editable = requireEditableIndicator(app.bots[0]);
    const working = editable.tick({
      chatId: "C1",
      tick: 0,
      replyToMessageId: "m-owner",
    });
    await workingSendStartedPromise;
    const final = app.bots[0].sendMessage("C1", [
      h.quote("m-owner"),
      h.text("done"),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    releaseWorking();

    assert.deepEqual(await final, ["2"]);
    await working;
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send", "delete", "send"],
    );
    assert.equal(calls[0].payload.content, "... Working...");
    assert.equal(calls[0].payload.reply?.messageReference, "m-owner");
    assert.equal(calls[1].id, "1");
    assert.equal(calls[2].payload.content, "done");
    assert.equal(calls[2].payload.reply?.messageReference, "m-owner");
  });
});

test("discord lifecycle end preserves editable progress until a fresh final replaces it", async () => {
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
    let nextId = 1;
    const channel = {
      send: async (payload: any) => {
        const id = String(nextId++);
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
        delete: async (id: string) => {
          calls.push({ method: "delete", id });
          messages.delete(id);
        },
      },
    };
    adapter.client = { channels: { fetch: async () => channel } };

    const editable = requireEditableIndicator(app.bots[0]);
    await editable.tick({
      chatId: "C1",
      tick: 0,
      replyToMessageId: "m-owner",
    });
    const ended = await editable.end({
      chatId: "C1",
      replyToMessageId: "m-owner",
    });
    const error = await app.bots[0].sendMessage(
      "C1",
      [h.quote("m-owner"), h.text("rin error: failed")],
      { deliveryKind: "error", coalesceWithWorkingMessage: true },
    );
    const interim = await app.bots[0].sendMessage(
      "C1",
      [h.quote("m-owner"), h.text("checking")],
      { deliveryKind: "interim", coalesceWithWorkingMessage: true },
    );
    const final = await app.bots[0].sendMessage("C1", [
      h.quote("m-owner"),
      h.text("done"),
    ]);

    assert.equal(ended, false);
    assert.deepEqual(error, ["2"]);
    assert.deepEqual(interim, ["1"]);
    assert.deepEqual(final, ["3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send", "send", "edit", "delete", "send"],
    );
    assert.equal(calls[0].payload.content, "... Working...");
    assert.equal(calls[0].payload.reply?.messageReference, "m-owner");
    assert.equal(calls[1].payload.content, "rin error: failed");
    assert.equal(calls[1].payload.reply?.messageReference, "m-owner");
    assert.equal(
      calls[2].payload.content,
      "... Working...\n\n────────\n\nchecking",
    );
    assert.equal(calls[3].id, "1");
    assert.equal(calls[4].payload.content, "done");
    assert.equal(calls[4].payload.reply?.messageReference, "m-owner");
  });
});

test("discord adapter edits exclusive progress in place without a Working section", async () => {
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
    let nextId = 1;
    const channel = {
      send: async (payload: any) => {
        const id = String(nextId++);
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
        delete: async (id: string) => {
          calls.push({ method: "delete", id });
          messages.delete(id);
        },
      },
    };
    adapter.client = { channels: { fetch: async () => channel } };

    const start = await app.bots[0].sendMessage(
      "C1",
      [h.quote("m-owner"), h.text("Compacting...")],
      {
        deliveryKind: "interim",
        coalesceWithWorkingMessage: true,
        exclusiveProgressMessage: true,
      },
    );
    const end = await app.bots[0].sendMessage(
      "C1",
      [h.quote("m-owner"), h.text("Compacted from 108,642 tokens")],
      {
        deliveryKind: "interim",
        coalesceWithWorkingMessage: true,
        exclusiveProgressMessage: true,
      },
    );

    assert.deepEqual(start, ["1"]);
    assert.deepEqual(end, ["1"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send", "edit"],
    );
    assert.equal(calls[0].payload.content, "Compacting...");
    assert.equal(calls[0].payload.reply?.messageReference, "m-owner");
    assert.equal(calls[1].id, "1");
    assert.equal(calls[1].payload.content, "Compacted from 108,642 tokens");
  });
});

test("discord adapter keeps todo unchanged while compaction replaces interim content", async () => {
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
    await editable.tick({ chatId: "C1", tick: 1 });
    await app.bots[0].sendMessage("C1", [h.text("[ ] first task")], {
      deliveryKind: "passive_notice",
      coalesceWithWorkingMessage: true,
    });
    const compactionStart = await app.bots[0].sendMessage(
      "C1",
      [h.text("Compacting...")],
      {
        deliveryKind: "interim",
        coalesceWithWorkingMessage: true,
      },
    );
    const compactionEnd = await app.bots[0].sendMessage(
      "C1",
      [h.text("Compacted from 108,642 tokens")],
      {
        deliveryKind: "interim",
        coalesceWithWorkingMessage: true,
      },
    );
    await editable.tick({ chatId: "C1", tick: 2 });
    const final = await app.bots[0].sendMessage("C1", [h.text("done")]);

    assert.deepEqual(compactionStart, ["1"]);
    assert.deepEqual(compactionEnd, ["1"]);
    assert.deepEqual(final, ["2"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send", "edit", "edit", "edit", "delete", "send"],
    );
    assert.equal(calls[0].payload.content, "... Working...");
    assert.equal(
      calls[1].payload.content,
      "... Working...\n\n────────\n\n[ ] first task",
    );
    assert.equal(
      calls[2].payload.content,
      "... Working...\n\n────────\n\nCompacting...\n\n────────\n\n[ ] first task",
    );
    assert.equal(
      calls[3].payload.content,
      "... Working...\n\n────────\n\nCompacted from 108,642 tokens\n\n────────\n\n[ ] first task",
    );
    assert.equal(calls[4].id, "1");
    assert.equal(calls[5].payload.content, "done");
  });
});

test("discord adapter sends errors beside editable progress", async () => {
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
    const error = await app.bots[0].sendMessage(
      "C1",
      [h.text("rin error: failed")],
      { deliveryKind: "error", coalesceWithWorkingMessage: true },
    );
    await editable.tick({ chatId: "C1", tick: 1 });

    assert.deepEqual(error, ["2"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send", "send"],
    );
    assert.equal(calls[0].id, "1");
    assert.equal(calls[0].payload.content, "... Working...");
    assert.equal(calls[1].id, "2");
    assert.equal(calls[1].payload.content, "rin error: failed");
  });
});

test("discord adapter keeps default editable Working static", async () => {
  await withTempDir(async (agentDir) => {
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ language: "zh_CN" }),
    );
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
    await editable.tick({ chatId: "C1", tick: 1 });
    const final = await app.bots[0].sendMessage("C1", [h.text("done")]);

    assert.deepEqual(final, ["2"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send", "delete", "send"],
    );
    assert.equal(calls[0].payload.content, "... Working...");
    assert.equal(calls[1].id, "1");
    assert.equal(calls[2].payload.content, "done");
  });
});

test("discord adapter sends a new Working message when the cached progress is no longer editable", async () => {
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
        const message = {
          id,
          payload,
          edit: async (nextPayload: any) => {
            calls.push({ method: "edit", id, payload: nextPayload });
            throw new Error("message not found");
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
    await editable.tick({
      chatId: "C1",
      tick: 1,
      workingStatusText: "Checking",
    });
    const final = await app.bots[0].sendMessage("C1", [h.text("done")]);

    assert.deepEqual(final, ["3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["send", "edit", "send", "delete", "delete", "send"],
    );
    assert.equal(calls[0].id, "1");
    assert.equal(calls[0].payload.content, "... Working...");
    assert.equal(calls[1].id, "1");
    assert.equal(calls[2].id, "2");
    assert.equal(calls[2].payload.content, "... Checking");
    assert.equal(calls[3].id, "1");
    assert.equal(calls[4].id, "2");
    assert.equal(calls[5].payload.content, "done");
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
    assert.equal(calls[0].payload.content, "... Working...");
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
    assert.equal(calls[0].payload.text, "... Working...");
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
    assert.equal(calls[0].payload.text, "... Working...");
    assert.equal(calls[1].payload.ts, "1");
    assert.equal(calls[2].payload.text, "https://example.com/demo.png");
  });
});

test("lark adapter sends progress as new messages without edit capability", async () => {
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
            return { data: { message_id: `m${calls.length}` } };
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

    assert.deepEqual(
      app.bots[0].workingIndicators.map((item: any) => item.presentation),
      ["reaction", "typing"],
    );
    const interimResult = await app.bots[0].sendMessage(
      "oc_1",
      [h.text("checking")],
      {
        deliveryKind: "interim",
        coalesceWithWorkingMessage: true,
      },
    );
    const todoResult = await app.bots[0].sendMessage(
      "oc_1",
      [h.text("⬜ first task")],
      {
        deliveryKind: "passive_notice",
        coalesceWithWorkingMessage: true,
      },
    );
    const finalResult = await app.bots[0].sendMessage("oc_1", [h.text("done")]);

    assert.deepEqual(interimResult, ["m1"]);
    assert.deepEqual(todoResult, ["m2"]);
    assert.deepEqual(finalResult, ["m3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["create", "create", "create"],
    );
    assert.match(calls[0].payload.data.content, /checking/);
    assert.match(calls[1].payload.data.content, /first task/);
    assert.match(calls[2].payload.data.content, /done/);
  });
});

test("telegram adapter keeps working and todo editable before final text", async () => {
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
    assert.equal(calls[1].payload.text, "... Working...");
    assert.equal(calls[2].payload.message_id, 2);
    assert.equal(
      calls[2].payload.text,
      "... Working...\n\n────────\n\n[ ] first task",
    );
    assert.equal(calls[4].payload.message_id, 2);
    assert.equal(calls[5].payload.text, "done");
  });
});

test("telegram adapter replaces editable Working with assistant summary", async () => {
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
      if (method === "sendMessage") return { message_id: String(calls.length) };
      return { message_id: payload?.message_id };
    };

    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    await app.bots[0].workingIndicators[0].tick({
      chatId: "456",
      tick: 1,
      assistantSummaryText: "**Designing casual greeting response**",
    });

    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage", "editMessageText"],
    );
    assert.equal(calls[0].payload.text, "... Working...");
    assert.equal(
      calls[1].payload.text,
      "... <b>Designing casual greeting response</b>",
    );
  });
});

test("telegram adapter sends errors beside editable progress", async () => {
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

    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    const error = await app.bots[0].sendMessage(
      "456",
      [h.text("rin error: failed")],
      { deliveryKind: "error", coalesceWithWorkingMessage: true },
    );
    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 1 });

    assert.deepEqual(error, ["2"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage", "sendMessage"],
    );
    assert.equal(calls[0].payload.text, "... Working...");
    assert.equal(calls[1].payload.text, "rin error: failed");
  });
});

test("telegram adapter keeps todo below repeated working ticks from context", async () => {
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
      if (method === "sendMessage") return { message_id: String(calls.length) };
      return { message_id: payload?.message_id };
    };

    await app.bots[0].workingIndicators[0].tick({
      chatId: "456",
      tick: 0,
      todoNoticeText: "✅ ~~finished task~~\n⬜ next task",
    });
    await app.bots[0].workingIndicators[0].tick({
      chatId: "456",
      tick: 1,
      todoNoticeText: "✅ ~~finished task~~\n⬜ next task",
    });

    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage"],
    );
    assert.equal(
      calls[0].payload.text,
      "... Working...\n\n────────\n\n✅ <s>finished task</s>\n⬜ next task",
    );
    assert.equal(calls[0].payload.parse_mode, "HTML");
  });
});

test("telegram adapter keeps todo below interim text before final reply", async () => {
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

    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    await app.bots[0].sendMessage("456", [h.text("[ ] first task")], {
      deliveryKind: "passive_notice",
      coalesceWithWorkingMessage: true,
    });
    const interim = await app.bots[0].sendMessage("456", [h.text("checking")], {
      deliveryKind: "interim",
      coalesceWithWorkingMessage: true,
    });
    const final = await app.bots[0].sendMessage("456", [h.text("done")]);

    assert.deepEqual(interim, ["1"]);
    assert.deepEqual(final, ["5"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      [
        "sendMessage",
        "editMessageText",
        "editMessageText",
        "deleteMessage",
        "sendMessage",
      ],
    );
    assert.equal(
      calls[1].payload.text,
      "... Working...\n\n────────\n\n[ ] first task",
    );
    assert.equal(
      calls[2].payload.text,
      "... Working...\n\n────────\n\nchecking\n\n────────\n\n[ ] first task",
    );
    assert.equal(calls[3].payload.message_id, 1);
    assert.equal(calls[4].payload.text, "done");
  });
});

test("telegram adapter edits one progress message from Working through interim before final", async () => {
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

    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 1 });
    const interim = await app.bots[0].sendMessage("456", [h.text("checking")], {
      deliveryKind: "interim",
      coalesceWithWorkingMessage: true,
    });
    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 2 });
    const final = await app.bots[0].sendMessage("456", [h.text("done")]);

    assert.deepEqual(interim, ["1"]);
    assert.deepEqual(final, ["4"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage", "editMessageText", "deleteMessage", "sendMessage"],
    );
    assert.equal(calls[0].payload.text, "... Working...");
    assert.equal(calls[1].payload.message_id, 1);
    assert.equal(
      calls[1].payload.text,
      "... Working...\n\n────────\n\nchecking",
    );
    assert.equal(calls[2].payload.message_id, 1);
    assert.equal(calls[3].payload.text, "done");
  });
});

test("telegram adapter applies extension working text as static editable Working", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    app.setWorkingText("Loop A");
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ method: string; payload: any }> = [];
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      if (method === "sendMessage") return { message_id: String(calls.length) };
      return { message_id: payload?.message_id };
    };

    const editable = requireEditableIndicator(app.bots[0]);
    await editable.tick({ chatId: "456", tick: 0 });
    await editable.tick({ chatId: "456", tick: 1 });
    await editable.tick({ chatId: "456", tick: 2 });
    const final = await app.bots[0].sendMessage("456", [h.text("done")]);

    assert.deepEqual(final, ["3"]);
    assert.equal(calls[0].payload.text, "... Loop A");
    assert.equal(calls[1].payload.message_id, 1);
    assert.equal(calls[2].payload.text, "done");
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

    const [inboxItem] = inbox.listPendingChatInboxItems(agentDir);
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

test("telegram adapter blocks late summary ticks while final text clears progress", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ method: string; payload: any }> = [];
    let tickDuringDelete = false;
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      if (method === "deleteMessage" && !tickDuringDelete) {
        tickDuringDelete = true;
        await app.bots[0].workingIndicators[0].tick({
          chatId: "456",
          tick: 1,
          assistantSummaryText: "Late stale summary",
        });
      }
      if (method === "sendMessage") return { message_id: String(calls.length) };
      return { message_id: payload?.message_id };
    };

    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    const final = await app.bots[0].sendMessage("456", [h.text("done")]);

    assert.deepEqual(final, ["3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage", "deleteMessage", "sendMessage"],
    );
    assert.equal(calls[0].payload.text, "... Working...");
    assert.equal(calls[1].payload.message_id, 1);
    assert.equal(calls[2].payload.text, "done");
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
    assert.equal(
      calls[1].payload.text,
      "... Working...\n\n────────\n\n[ ] first task",
    );
    assert.equal(calls[2].payload.message_id, 1);
  });
});

test("telegram lifecycle end preserves visible progress until final delivery", async () => {
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
      if (method === "sendMessage") {
        return { message_id: String(calls.length) };
      }
      return { message_id: payload?.message_id };
    };

    await app.bots[0].workingIndicators[0].tick({ chatId: "456", tick: 0 });
    const ended = await app.bots[0].workingIndicators[0].end({
      chatId: "456",
    });
    const error = await app.bots[0].sendMessage(
      "456",
      [h.text("rin error: failed")],
      { deliveryKind: "error", coalesceWithWorkingMessage: true },
    );
    const final = await app.bots[0].sendMessage("456", [h.text("done")]);

    assert.equal(ended, false);
    assert.deepEqual(error, ["2"]);
    assert.deepEqual(final, ["4"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendMessage", "sendMessage", "deleteMessage", "sendMessage"],
    );
    assert.equal(calls[0].payload.text, "... Working...");
    assert.equal(calls[1].payload.text, "rin error: failed");
    assert.equal(calls[2].payload.message_id, 1);
    assert.equal(calls[3].payload.text, "done");
  });
});

test("telegram adapter deletes progress before oversized final text chunks", async () => {
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

test("telegram adapter preserves shared markdown indentation semantics", async () => {
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
    const markdown = "    root  code\n\n- parent\n  - child\n    continuation";

    const result = await app.bots[0].sendMessage("456", [h.markdown(markdown)]);

    assert.deepEqual(result, ["1"]);
    assert.equal(calls[0].payload.parse_mode, "HTML");
    assert.equal(calls[0].payload.text, markdown);
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

test("telegram adapter falls back to a safe rich segment and continues later segments", async () => {
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
    assert.equal(calls[1].payload.text, "[image: missing]");
    assert.doesNotMatch(calls[1].payload.text, /chat_media_file_missing:/);
    assert.equal(calls[1].payload.parse_mode, undefined);
    assert.equal(calls[1].payload.reply_to_message_id, undefined);
    assert.equal(calls[2].payload.text, "trailing text");
  });
});

test("telegram adapter falls back after the provider rejects a file send", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ method: string; payload: any }> = [];
    adapter.api = {
      raw: {
        sendDocument: async (payload: any) => {
          calls.push({ method: "sendDocument", payload });
          const error: any = new Error("Bad Request: file rejected");
          error.name = "GrammyError";
          error.ok = false;
          throw error;
        },
        sendMessage: async (payload: any) => {
          calls.push({ method: "sendMessage", payload });
          return { message_id: `m${calls.length}` };
        },
      },
    };

    const result = await app.bots[0].sendMessage("456", [
      h.quote("77"),
      h.file(Buffer.from("draft"), "application/octet-stream", {
        name: "draft.bin",
      }),
    ]);

    assert.deepEqual(result, ["m2"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendDocument", "sendMessage"],
    );
    assert.equal(calls[1].payload.reply_to_message_id, "77");
    assert.equal(calls[1].payload.text, "[file: draft.bin]");
  });
});

test("telegram adapter reports partial delivery when original-string fallback also fails", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ method: string; payload: any }> = [];
    let delivered = 0;
    adapter.callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      if (payload.parse_mode === undefined && /^\[image:/.test(payload.text)) {
        throw new Error("fallback unavailable");
      }
      delivered += 1;
      return { message_id: `m${delivered}` };
    };
    const missingPath = path.join(agentDir, "missing.png");

    await assert.rejects(
      () =>
        app.bots[0].sendMessage("456", [
          h.text("before"),
          h("image", { src: missingPath, name: "missing" }),
          h.text("after"),
        ]),
      (error: any) => {
        assert.match(
          error.message,
          /^chat_delivery_partial:chat_media_file_missing:/,
        );
        assert.deepEqual(error.deliveredMessageIds, ["m1", "m2"]);
        return true;
      },
    );

    assert.equal(calls.length, 3);
    assert.equal(calls[2].payload.text, "after");
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

test("onebot adapter embeds all local media as base64", async () => {
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
    const calls: Array<{ action: string; params: any }> = [];
    await fs.writeFile(imagePath, Buffer.from("png"));
    await fs.writeFile(videoPath, Buffer.from("mp4"));
    await fs.writeFile(filePath, Buffer.from("notes"));
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
    assert.equal(
      calls[0].params.message,
      "[CQ:image,file=base64://cG5n]" +
        "[CQ:video,file=base64://bXA0]" +
        "[CQ:file,file=base64://bm90ZXM=]",
    );
  });
});

test("onebot adapter falls back to a safe rich node during serialization", async () => {
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
    const missingPath = path.join(agentDir, "missing.pdf");

    const result = await app.bots[0].sendMessage("2", [
      h.text("before "),
      h("file", { src: missingPath, name: "missing.pdf" }),
      h.text(" after"),
    ]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].params.message,
      "before &#91;file: missing.pdf&#93; after",
    );
    assert.doesNotMatch(calls[0].params.message, /chat_media_file_missing:/);
  });
});

test("onebot adapter falls back to plain text after a confirmed rich send failure", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: Array<{ action: string; params: any }> = [];
    const filePath = path.join(agentDir, "draft.xlsx");
    await fs.writeFile(filePath, Buffer.from("draft"));
    adapter.callAction = (action: string, params: any) => {
      calls.push({ action, params });
      if (calls.length === 1) {
        const error: any = runtime.oneBotActionRejectedError({
          wording: "group file upload failed: code=-303 msg=invalid file name",
        });
        assert.equal(error.chatOutboxConfirmedNotDelivered, true);
        const rejected = Promise.reject(error) as Promise<any> & {
          dispatched?: Promise<void>;
        };
        rejected.dispatched = Promise.resolve();
        return rejected;
      }
      return Promise.resolve({ message_id: "fallback-message" });
    };

    const result = await app.bots[0].sendMessage("2", [
      h.quote("88"),
      h.text("Resending as plain text:\n"),
      h.file(
        filePath,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        {
          name: "draft.xlsx",
        },
      ),
    ]);

    assert.deepEqual(result, ["fallback-message"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].action, "send_group_msg");
    assert.match(calls[0].params.message, /\[CQ:file,file=base64:\/\//);
    assert.equal(calls[1].action, "send_group_msg");
    assert.match(calls[1].params.message, /^\[CQ:reply,id=88\]/);
    assert.match(calls[1].params.message, /Resending as plain text:/);
    assert.match(calls[1].params.message, /file: draft\.xlsx/);
    assert.doesNotMatch(
      calls[1].params.message,
      /base64:|chat_media_file_missing|\/tmp\//,
    );
    assert.equal(calls[1].params.timeout, runtime.ONEBOT_ACTION_TIMEOUT_MS);
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
      message: "[CQ:file,file=base64://cGFjaw==]",
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
        message: "[CQ:image,file=base64://cG5n]",
      }).timeout,
      runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
    );
  }
  for (const action of ["upload_private_file", "upload_group_file"]) {
    assert.equal(
      runtime.withOneBotActionTimeoutParam(action, {
        file: "/app/napcat/cache/card.png",
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
      message: "[CQ:image,file=base64://cG5n]",
      timeout: 42,
    }).timeout,
    42,
  );
});

test("onebot action failures preserve the adapter error without path hints", () => {
  const message = runtime.formatOneBotActionFailureMessage({
    status: "failed",
    retcode: 1200,
    message: "rich media transfer failed",
  });

  assert.equal(message, "rich media transfer failed");
});

test("onebot generic file-word failures preserve the adapter error", () => {
  const message = runtime.formatOneBotActionFailureMessage({
    status: "failed",
    retcode: 1200,
    message: "Timeout while sending file list update",
  });

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

test("discord adapter treats a successful safe-string fallback as delivered", async () => {
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
    const missingPath = path.join(agentDir, "missing.png");

    const result = await app.bots[0].sendMessage("456", [
      h.text("leading text"),
      h("image", { src: missingPath, name: "missing" }),
      h.text("trailing text"),
    ]);

    assert.deepEqual(result, ["1", "2", "3"]);
    assert.equal(calls[0].content, "leading text");
    assert.equal(calls[1].content, "[image: missing]");
    assert.doesNotMatch(calls[1].content, /chat_media_file_missing:/);
    assert.equal(calls[2].content, "trailing text");
  });
});

test("discord adapter falls back after the provider rejects a file send", async () => {
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
        if (payload.files) {
          const error: any = new Error("Invalid Form Body");
          error.name = "DiscordAPIError[50035]";
          error.code = 50035;
          throw error;
        }
        return { id: `m${calls.length}` };
      },
    });

    const result = await app.bots[0].sendMessage("456", [
      h.quote("88"),
      h.file(Buffer.from("draft"), "application/octet-stream", {
        name: "draft.bin",
      }),
    ]);

    assert.deepEqual(result, ["m2"]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].files[0].attachment, Buffer.from("draft"));
    assert.equal(calls[1].content, "[file: draft.bin]");
    assert.equal(calls[1].reply.messageReference, "88");
  });
});

test("discord adapter keeps an all-failed rich delivery out of partial state", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "abc" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    adapter.fetchChannel = async () => ({
      async send() {
        throw new Error("placeholder unavailable");
      },
    });

    await assert.rejects(
      () =>
        app.bots[0].sendMessage("456", [
          h.image(path.join(agentDir, "missing.png")),
        ]),
      (error: any) => {
        assert.match(error.message, /^chat_media_file_missing:/);
        assert.notEqual(error.partialDelivery, true);
        assert.deepEqual(error.deliveredMessageIds, undefined);
        return true;
      },
    );
  });
});

test("lark adapter sends text and structured at as native post elements", async () => {
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
            { tag: "at", user_id: "ou_123" },
            { tag: "text", text: " hello" },
          ],
        ],
      },
    });
  });
});

test("lark adapter rejects a nonzero API response even when the SDK resolves", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    adapter.client = {
      im: {
        message: {
          create: async () => ({ code: 230001, msg: "invalid message" }),
        },
      },
    };

    await assert.rejects(
      app.bots[0].sendMessage("oc_1", [h.text("hello")]),
      /lark_api_error:230001:invalid message/,
    );
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
              zh_cn: { content: [[{ tag: "text", text: "follow up" }]] },
            }),
          },
        },
      ],
    ]);
  });
});

test("lark adapter uploads images and preserves surrounding text order", async () => {
  await withTempDir(async (agentDir) => {
    const imagePath = path.join(agentDir, "preview.png");
    await fs.writeFile(imagePath, Buffer.from("test-image"));
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    let nextMessageId = 1;
    adapter.client = {
      im: {
        image: {
          create: async (payload: any) => {
            calls.push({ method: "uploadImage", payload });
            return { image_key: "img_v2_preview" };
          },
        },
        message: {
          create: async (payload: any) => {
            calls.push({ method: "createMessage", payload });
            return { data: { message_id: `m${nextMessageId++}` } };
          },
          delete: async (payload: any) => {
            calls.push({ method: "deleteMessage", payload });
            return { ok: true };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.text("before"),
      h.image(imagePath),
      h.text("after"),
    ]);

    assert.deepEqual(result, ["m1", "m2", "m3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["createMessage", "uploadImage", "createMessage", "createMessage"],
    );
    assert.equal(calls[0].payload.data.msg_type, "post");
    assert.equal(calls[1].payload.data.image_type, "message");
    assert.deepEqual(calls[1].payload.data.image, Buffer.from("test-image"));
    assert.equal(calls[2].payload.data.msg_type, "image");
    assert.deepEqual(JSON.parse(calls[2].payload.data.content), {
      image_key: "img_v2_preview",
    });
    assert.equal(calls[3].payload.data.msg_type, "post");
  });
});

test("lark adapter uploads ordinary files and sends the returned file key", async () => {
  await withTempDir(async (agentDir) => {
    const filePath = path.join(agentDir, "notes.txt");
    await fs.writeFile(filePath, Buffer.from("text-content"));
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
        file: {
          create: async (payload: any) => {
            calls.push({ method: "uploadFile", payload });
            return { file_key: "file_v2_spec" };
          },
        },
        message: {
          create: async (payload: any) => {
            calls.push({ method: "createMessage", payload });
            return { data: { message_id: `m${calls.length}` } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.text("before"),
      h.file(filePath, "text/plain", { name: "notes.txt" }),
      h.text("after"),
    ]);

    assert.equal(result.length, 3);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["createMessage", "uploadFile", "createMessage", "createMessage"],
    );
    assert.deepEqual(calls[1].payload.data, {
      file_type: "stream",
      file_name: "notes.txt",
      file: Buffer.from("text-content"),
    });
    assert.equal(calls[2].payload.data.msg_type, "file");
    assert.deepEqual(JSON.parse(calls[2].payload.data.content), {
      file_key: "file_v2_spec",
    });
  });
});

test("lark adapter falls back from a failed file upload without exposing local paths or SDK errors", async () => {
  await withTempDir(async (agentDir) => {
    const filePath = path.join(agentDir, "spec.pdf");
    await fs.writeFile(filePath, Buffer.from("pdf-content"));
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
        file: {
          create: async () => {
            throw new Error("Request failed with status code 400");
          },
        },
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: `m${calls.length}` } };
          },
        },
      },
    };

    const original = `[FILE:   spec.pdf](${filePath})`;
    const result = await app.bots[0].sendMessage("oc_1", [
      h.text("before"),
      h("markdown", { content: original }),
      h.text("after"),
    ]);

    assert.deepEqual(result, ["m1", "m2", "m3"]);
    assert.equal(calls[1].data.msg_type, "text");
    assert.equal(JSON.parse(calls[1].data.content).text, "[file: spec.pdf]");
    assert.doesNotMatch(calls[1].data.content, /status code 400/);
  });
});

test("lark adapter falls back when the file message is rejected after upload", async () => {
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
        file: {
          create: async () => ({ file_key: "file_v2_draft" }),
        },
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            if (payload.data.msg_type === "file") {
              return { code: 230001, msg: "invalid file message" };
            }
            return { data: { message_id: "fallback-message" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.file(Buffer.from("draft"), "application/octet-stream", {
        name: "draft.bin",
      }),
    ]);

    assert.deepEqual(result, ["fallback-message"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].data.msg_type, "file");
    assert.equal(calls[1].data.msg_type, "text");
    assert.equal(JSON.parse(calls[1].data.content).text, "[file: draft.bin]");
  });
});

test("lark adapter reports partial delivery when the original file fallback also fails", async () => {
  await withTempDir(async (agentDir) => {
    const filePath = path.join(agentDir, "spec.pdf");
    await fs.writeFile(filePath, Buffer.from("pdf-content"));
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    let delivered = 0;
    adapter.client = {
      im: {
        file: {
          create: async () => {
            throw new Error("Request failed with status code 400");
          },
        },
        message: {
          create: async (payload: any) => {
            if (payload.data.msg_type === "text") {
              throw new Error("fallback unavailable");
            }
            delivered += 1;
            return { data: { message_id: `m${delivered}` } };
          },
        },
      },
    };

    await assert.rejects(
      () =>
        app.bots[0].sendMessage("oc_1", [
          h.text("before"),
          h.file(filePath, "application/pdf", { name: "spec.pdf" }),
          h.text("after"),
        ]),
      (error: any) => {
        assert.match(
          error.message,
          /^chat_delivery_partial:Request failed with status code 400/,
        );
        assert.deepEqual(error.deliveredMessageIds, ["m1", "m2"]);
        return true;
      },
    );
  });
});

test("lark adapter downloads remote images and uses the native reply endpoint", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    try {
      adapter.httpTransport.fetch = async () =>
        new Response(Buffer.from("remote-image"), { status: 200 });
      adapter.client = {
        im: {
          image: {
            create: async (payload: any) => {
              calls.push({ method: "uploadImage", payload });
              return { data: { image_key: "img_v2_remote" } };
            },
          },
          message: {
            reply: async (payload: any) => {
              calls.push({ method: "reply", payload });
              return { data: { message_id: "reply-image" } };
            },
          },
        },
      };

      const result = await app.bots[0].sendMessage("oc_1", [
        h.quote("om_parent"),
        h.image("https://example.com/remote.png"),
      ]);

      assert.deepEqual(result, ["reply-image"]);
      assert.deepEqual(
        calls.map((entry) => entry.method),
        ["uploadImage", "reply"],
      );
      assert.deepEqual(
        calls[0].payload.data.image,
        Buffer.from("remote-image"),
      );
      assert.equal(calls[1].payload.path.message_id, "om_parent");
      assert.equal(calls[1].payload.data.msg_type, "image");
      assert.deepEqual(JSON.parse(calls[1].payload.data.content), {
        image_key: "img_v2_remote",
      });
    } finally {
      await app.stop();
    }
  });
});

test("lark adapter sends failed image markers as plain text and continues later text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    const failedResponse = new Response("missing", { status: 404 });
    try {
      adapter.httpTransport.fetch = async () => failedResponse;
      adapter.client = {
        im: {
          image: {
            create: async () => {
              throw new Error("image upload should not run");
            },
          },
          message: {
            create: async (payload: any) => {
              calls.push(payload);
              return { data: { message_id: `m${calls.length}` } };
            },
          },
        },
      };

      const result = await app.bots[0].sendMessage("oc_1", [
        h.text("before"),
        h("image", {
          src: "https://example.com/missing.png",
          name: "missing",
        }),
        h.text("after"),
      ]);

      assert.deepEqual(result, ["m1", "m2", "m3"]);
      assert.equal(calls.length, 3);
      assert.equal(
        JSON.parse(calls[0].data.content).zh_cn.content[0][0].text,
        "before",
      );
      assert.equal(calls[1].data.msg_type, "text");
      assert.equal(
        JSON.parse(calls[1].data.content).text,
        "[image: missing](https://example.com/missing.png)",
      );
      assert.doesNotMatch(calls[1].data.content, /Failed to download/);
      assert.equal(
        JSON.parse(calls[2].data.content).zh_cn.content[0][0].text,
        "after",
      );
      assert.equal(failedResponse.bodyUsed, true);
    } finally {
      await app.stop();
    }
  });
});

test("lark adapter falls back from oversized local images before upload", async () => {
  await withTempDir(async (agentDir) => {
    const imagePath = path.join(agentDir, "oversized.png");
    const imageFile = await fs.open(imagePath, "w");
    await imageFile.truncate(10 * 1024 * 1024 + 1);
    await imageFile.close();
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const calls: any[] = [];
    let uploadAttempted = false;
    adapter.client = {
      im: {
        image: {
          create: async () => {
            uploadAttempted = true;
            return { image_key: "unexpected" };
          },
        },
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "limit-error" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      runtime.createChatRuntimeH().image(imagePath),
    ]);

    assert.deepEqual(result, ["limit-error"]);
    assert.equal(uploadAttempted, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.msg_type, "text");
    assert.equal(
      JSON.parse(calls[0].data.content).text,
      "[image: oversized.png]",
    );
    assert.doesNotMatch(calls[0].data.content, /upload limit/);
  });
});

test("lark adapter falls back from remote images declared over the upload limit", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls: any[] = [];
    let uploadAttempted = false;
    let fetchSignal: AbortSignal | undefined;
    const oversizedResponse = new Response("small body", {
      status: 200,
      headers: { "content-length": String(10 * 1024 * 1024 + 1) },
    });
    try {
      adapter.httpTransport.fetch = async (_url: any, init: any) => {
        fetchSignal = init?.signal as AbortSignal | undefined;
        return oversizedResponse;
      };
      adapter.client = {
        im: {
          image: {
            create: async () => {
              uploadAttempted = true;
              return { image_key: "unexpected" };
            },
          },
          message: {
            create: async (payload: any) => {
              calls.push(payload);
              return { data: { message_id: "remote-limit-error" } };
            },
          },
        },
      };

      const result = await app.bots[0].sendMessage("oc_1", [
        h.image("https://example.com/oversized.png"),
      ]);

      assert.deepEqual(result, ["remote-limit-error"]);
      assert.equal(fetchSignal?.aborted, true);
      assert.equal(uploadAttempted, false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].data.msg_type, "text");
      assert.equal(
        JSON.parse(calls[0].data.content).text,
        "[image: https://example.com/oversized.png](https://example.com/oversized.png)",
      );
      assert.doesNotMatch(calls[0].data.content, /upload limit/);
      assert.equal(oversizedResponse.bodyUsed, true);
    } finally {
      await app.stop();
    }
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
      false,
    );

    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["sendChatAction", "sendMessage"],
    );
    assert.equal(calls[0].payload.action, "typing");
    assert.equal(calls[1].payload.reply_to_message_id, "101");
    assert.equal(calls[1].payload.text, "... Working...");
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
    await indicator.tick({ chatId: "123", messageId: "101", tick: 1 });
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

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "send_private_msg");
    assert.equal(calls[0].params.user_id, 2);
    assert.equal(calls[0].params.auto_escape, false);
    assert.equal(calls[0].params.message, "[CQ:reply,id=m1]Working...");
  });
});

test("onebot private marker uses extension presentation working text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { endpoint: "ws://127.0.0.1:1" },
    });
    app.setWorkingText(
      "\u5de5\u4f5c\u4e2d... (\u0e51\u2022\u0300\u3142\u2022\u0301)\u0648\u2727",
    );
    const adapter = [...app.adapters][0];
    const calls: any[] = [];
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return { message_id: "notice-1" };
    };

    const [indicator] = app.bots[0].getWorkingIndicators({
      chatId: "private:2",
    });

    assert.equal(
      await indicator.start({ chatId: "private:2", messageId: "m1" }),
      true,
    );

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].params.message,
      "[CQ:reply,id=m1]\u5de5\u4f5c\u4e2d... (\u0e51\u2022\u0300\u3142\u2022\u0301)\u0648\u2727",
    );
  });
});

test("discord working indicator adds one fixed reaction and removes it on end", async () => {
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
    await indicator.end({ chatId: "C1", messageId: "m1" });

    assert.deepEqual(calls, [
      ["create", "🤔"],
      ["delete", ""],
    ]);
  });
});

test("slack working indicator adds one fixed reaction and removes it on end", async () => {
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
    await indicator.end({ chatId: "C1", messageId: "1.1" });

    assert.deepEqual(calls, [
      ["create", "thinking_face"],
      ["delete", "thinking_face"],
    ]);
  });
});

test("lark working indicator adds one fixed reaction and removes it on end", async () => {
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
    await indicator.end({ chatId: "oc_1", messageId: "om_1" });

    assert.deepEqual(
      calls.map(([kind]) => kind),
      ["create", "list", "delete"],
    );
    assert.equal(calls[0][1].data.reaction_type.emoji_type, "THINKING");
    assert.equal(calls[2][1].path.reaction_id, "reaction-thinking");
  });
});

test("lark adapter maps manual and waiting reactions to supported emoji types", async () => {
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
    assert.equal(await app.bots[0].createReaction("oc_1", "om_2", "⏳"), true);
    assert.equal(calls[0].data.reaction_type.emoji_type, "Fire");
    assert.equal(calls[1].data.reaction_type.emoji_type, "Hourglass");
  });
});

test("lark reaction operations reject resolved Feishu API failures", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.adapters][0];
    let mode = "create";
    adapter.client = {
      im: {
        messageReaction: {
          create: async () => ({ code: 230001, msg: "create failed" }),
          list: async () =>
            mode === "list"
              ? { code: 230002, msg: "list failed" }
              : {
                  code: 0,
                  data: {
                    items: [
                      {
                        reaction_id: "reaction-1",
                        reaction_type: { emoji_type: "THINKING" },
                        operator: { operator_type: "app" },
                      },
                    ],
                  },
                },
          delete: async () => ({ code: 230003, msg: "delete failed" }),
        },
      },
    };

    await assert.rejects(
      app.bots[0].createReaction("oc_1", "om_1", "🤔"),
      /lark_api_error:230001:create failed/,
    );
    mode = "list";
    await assert.rejects(
      app.bots[0].deleteReaction("oc_1", "om_1", "🤔"),
      /lark_api_error:230002:list failed/,
    );
    mode = "delete";
    await assert.rejects(
      app.bots[0].deleteReaction("oc_1", "om_1", "🤔"),
      /lark_api_error:230003:delete failed/,
    );
  });
});

test("lark adapter maps markdown inline styles and mentions to native elements", async () => {
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
            { tag: "text", text: "bold", style: ["bold"] },
            { tag: "text", text: " " },
            { tag: "a", text: "docs", href: "https://example.com" },
            { tag: "text", text: "\n" },
            { tag: "at", user_id: "ou_123" },
          ],
        ],
      },
    });
  });
});

test("lark adapter falls back when mention markup is not structurally native", async () => {
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
    const markdown = '<at user_id="ou_123">Alice **bold**</at>';

    await app.bots[0].sendMessage("oc_1", [h.markdown(markdown)]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [{ tag: "md", text: markdown }],
    ]);
  });
});

test("lark adapter serializes simple markdown as native post paragraphs", async () => {
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

    await app.bots[0].sendMessage("oc_1", [
      h.markdown("intro **bold** [link](https://example.com)\n\noutro"),
    ]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [
        { tag: "text", text: "intro " },
        { tag: "text", text: "bold", style: ["bold"] },
        { tag: "text", text: " " },
        { tag: "a", text: "link", href: "https://example.com" },
      ],
      [{ tag: "text", text: "\n" }],
      [{ tag: "text", text: "outro" }],
    ]);
  });
});

test("lark adapter preserves unsupported link content by falling back to markdown", async () => {
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

    await app.bots[0].sendMessage("oc_1", [
      h.markdown(
        "[**bold**](https://example.com)\n\n[`code`](https://example.com)",
      ),
    ]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [
        {
          tag: "a",
          text: "bold",
          href: "https://example.com",
          style: ["bold"],
        },
      ],
      [{ tag: "text", text: "\n" }],
      [{ tag: "md", text: "[`code`](https://example.com)" }],
    ]);
  });
});

test("lark adapter emits fenced code through the native code block tag", async () => {
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
    await app.bots[0].sendMessage("oc_1", [
      h.markdown("before\n\n```ts\nconst value = 1;\n```\n\nafter"),
    ]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [{ tag: "text", text: "before" }],
      [{ tag: "text", text: "\n" }],
      [{ tag: "code_block", language: "ts", text: "const value = 1;" }],
      [{ tag: "text", text: "\n" }],
      [{ tag: "text", text: "after" }],
    ]);
  });
});

test("lark adapter preserves blockquotes and indented code blocks", async () => {
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

    await app.bots[0].sendMessage("oc_1", [
      h.markdown("> first\n>\n> second\n\n    alpha\n\n    beta\n\noutro"),
    ]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [{ tag: "md", text: "> first\n>\n> second" }],
      [{ tag: "text", text: "\n" }],
      [{ tag: "code_block", text: "alpha\n\nbeta" }],
      [{ tag: "text", text: "\n" }],
      [{ tag: "text", text: "outro" }],
    ]);
  });
});

test("lark adapter resolves cross-paragraph reference links into native links", async () => {
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
    const markdown =
      "first [docs]\n\nsecond [docs]\n\n[docs]: https://example.com";

    await app.bots[0].sendMessage("oc_1", [h.markdown(markdown)]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [
        { tag: "text", text: "first " },
        { tag: "a", text: "docs", href: "https://example.com" },
      ],
      [{ tag: "text", text: "\n" }],
      [
        { tag: "text", text: "second " },
        { tag: "a", text: "docs", href: "https://example.com" },
      ],
    ]);
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
    assert.equal(calls[0].text, "Todo\n⬜ Keep working\n✅ ~~Ship renderer~~");
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

test("slack adapter falls back to a safe rich segment and continues later segments", async () => {
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

    const missingPath = path.join(agentDir, "missing.png");
    const result = await app.bots[0].sendMessage("C123", [
      h.text("leading text"),
      h("image", { src: missingPath, name: "missing" }),
      h.text("trailing text"),
    ]);

    assert.deepEqual(result, ["1", "2", "3"]);
    assert.equal(calls[0].text, "leading text");
    assert.equal(calls[1].text, "[image: missing]");
    assert.doesNotMatch(calls[1].text, /chat_media_file_missing:/);
    assert.equal(calls[2].text, "trailing text");
  });
});

test("slack adapter falls back after the provider rejects a file upload", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "slack",
      name: "Slack",
      config: { botToken: "xoxb-test", appToken: "xapp-test" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const posts: any[] = [];
    adapter.web = {
      chat: {
        postMessage: async (payload: any) => {
          posts.push(payload);
          return { ts: `m${posts.length}` };
        },
      },
      files: {
        uploadV2: async () => {
          const error: any = new Error("An API error occurred: invalid_file");
          error.code = "slack_webapi_platform_error";
          throw error;
        },
      },
    };

    const result = await app.bots[0].sendMessage("C1", [
      h.quote("99"),
      h.file(Buffer.from("draft"), "application/octet-stream", {
        name: "draft.bin",
      }),
    ]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].text, "[file: draft.bin]");
    assert.equal(posts[0].thread_ts, "99");
  });
});

test("rich adapters preserve confirmed-not-delivered when providers reject fallback text", async () => {
  await withTempDir(async (agentDir) => {
    const h = runtime.createChatRuntimeH();
    const rejected = async (task: Promise<any>) => {
      try {
        await task;
        return null;
      } catch (error) {
        return error as any;
      }
    };
    const file = () =>
      h.file(Buffer.from("draft"), "application/octet-stream", {
        name: "draft.bin",
      });

    const telegram = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const telegramAdapter = [...telegram.adapters][0];
    const telegramRejection = async () => {
      const error: any = new Error("Bad Request: rejected");
      error.name = "GrammyError";
      error.ok = false;
      throw error;
    };
    telegramAdapter.api = {
      raw: {
        sendDocument: telegramRejection,
        sendMessage: telegramRejection,
      },
    };

    const discord = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "abc" },
    });
    const discordAdapter = [...discord.adapters][0];
    discordAdapter.fetchChannel = async () => ({
      send: async () => {
        const error: any = new Error("Invalid Form Body");
        error.name = "DiscordAPIError[50035]";
        error.code = 50035;
        throw error;
      },
    });

    const lark = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const larkAdapter = [...lark.adapters][0];
    larkAdapter.client = {
      im: {
        file: { create: async () => ({ file_key: "file_v2_draft" }) },
        message: {
          create: async () => ({ code: 230001, msg: "invalid message" }),
        },
      },
    };

    const slack = createRuntimeApp(agentDir, {
      key: "slack",
      name: "Slack",
      config: { botToken: "xoxb-test", appToken: "xapp-test" },
    });
    const slackAdapter = [...slack.adapters][0];
    const slackRejection = () => {
      const error: any = new Error("An API error occurred: invalid_file");
      error.code = "slack_webapi_platform_error";
      throw error;
    };
    slackAdapter.web = {
      chat: { postMessage: async () => slackRejection() },
      files: { uploadV2: async () => slackRejection() },
    };

    const onebot = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const onebotAdapter = [...onebot.adapters][0];
    onebotAdapter.callAction = () => {
      const task = Promise.reject(
        runtime.oneBotActionRejectedError({ wording: "message rejected" }),
      ) as Promise<any> & { dispatched?: Promise<void> };
      task.dispatched = Promise.resolve();
      return task;
    };

    const errors = {
      telegram: await rejected(telegram.bots[0].sendMessage("456", [file()])),
      discord: await rejected(discord.bots[0].sendMessage("456", [file()])),
      lark: await rejected(lark.bots[0].sendMessage("oc_1", [file()])),
      slack: await rejected(slack.bots[0].sendMessage("C1", [file()])),
      onebot: await rejected(onebot.bots[0].sendMessage("2", [file()])),
    };

    assert.deepEqual(
      Object.fromEntries(
        Object.entries(errors).map(([platform, error]) => [
          platform,
          error?.chatOutboxConfirmedNotDelivered === true,
        ]),
      ),
      {
        telegram: true,
        discord: true,
        lark: true,
        slack: true,
        onebot: true,
      },
    );
  });
});

test("slack adapter reports partial delivery when original-string fallback also fails", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "slack",
      name: "Slack",
      config: { token: "xapp", botToken: "xoxb" },
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    let delivered = 0;
    adapter.web = {
      chat: {
        postMessage: async (payload: any) => {
          if (/^\[image:/.test(payload.text)) {
            throw new Error("fallback unavailable");
          }
          delivered += 1;
          return { ts: `m${delivered}` };
        },
      },
      files: {
        uploadV2: async () => {
          throw new Error("unexpected_upload");
        },
      },
    };
    const missingPath = path.join(agentDir, "missing.png");

    await assert.rejects(
      () =>
        app.bots[0].sendMessage("C123", [
          h.text("before"),
          h("image", { src: missingPath, name: "missing" }),
          h.text("after"),
        ]),
      (error: any) => {
        assert.match(
          error.message,
          /^chat_delivery_partial:chat_media_file_missing:/,
        );
        assert.deepEqual(error.deliveredMessageIds, ["m1", "m2"]);
        return true;
      },
    );
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
