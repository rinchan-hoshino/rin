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
);
const inbox = await import(
  pathToFileURL(path.resolve("dist/core/chat/inbox.js")).href
);

test("runtime app owns durable ingress, adapter ordering, builders, and provider registration", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const app = runtime.createChatRuntimeApp(directory) as any;
    const lifecycle: string[] = [];
    const presentationTexts: string[] = [];
    app.register(
      {
        start: async () => lifecycle.push("start-1"),
        stop: async () => lifecycle.push("stop-1"),
        setWorkingText: (text: string) => presentationTexts.push(text),
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
    app.setWorkingText("Localized");
    assert.deepEqual(presentationTexts, ["Localized"]);

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
    app.emit("message", {
      platform: "telegram",
      selfId: "bot",
      channelId: "topic",
      messageId: "thread-message",
      userId: "user",
      content: "owner",
      stripped: { content: "owner" },
      elements: [{ type: "text", attrs: { content: "owner" } }],
      telegram: { message: { message_thread_id: 42 } },
    });
    app.emit("message", { platform: "owner" });
    app.emit("other", {});
    assert.equal(seen, 3);
    const pending = inbox.listPendingChatInboxItems(directory);
    assert.equal(pending.length, 2);
    assert.equal(
      pending.some(
        (entry: any) => entry.chatKey === "telegram/bot:topic?thread=42",
      ),
      true,
    );

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
      ["telegram", "onebot", "lark", "discord", "slack"],
    );
    assert.equal(all.bots.length, 5);
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
