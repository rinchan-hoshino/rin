import "../support/require-test-sandbox.ts";
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
const runtime = Object.assign(
  {},
  await import(
    pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat.js")).href
  ),
  await import(
    pathToFileURL(
      path.join(rootDir, "dist", "core", "chat", "platform", "telegram.js"),
    ).href
  ),
  await import(
    pathToFileURL(
      path.join(rootDir, "dist", "core", "chat", "platform", "discord.js"),
    ).href
  ),
);
const { EditableTextMessageGroup } = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "chat",
      "platform",
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
  const app = runtime.createChat(agentDir);
  runtime.addBuiltInPlatforms(app, {
    dataDir: path.join(agentDir, "data"),
    entries: [
      {
        platform: adapterEntry.platform || adapterEntry.key,
        name: adapterEntry.name,
        config: adapterEntry.config || {},
      },
    ],
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
    const adapter = [...app.platforms][0];
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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

test("telegram adapter keeps working and todo editable before final text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
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

    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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

test("discord adapter splits text and media into ordered messages", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "abc" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
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

test("telegram working indicator sends typing and visible working text without reactions", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "telegram",
      name: "Telegram",
      config: { token: "123:abc" },
    });
    const adapter = [...app.platforms][0];
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

test("discord working indicator adds one fixed reaction and removes it on end", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "discord",
      name: "Discord",
      config: { token: "abc" },
    });
    const adapter = [...app.platforms][0];
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
