import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
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
    pathToFileURL(path.resolve("dist/core/chat-runtime/slack.js")).href
  ),
);

test("slack adapter owns socket lifecycle, SDK wrappers, file ingress, and rich delivery", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const socket = new EventEmitter() as any;
    socket.start = async () => {
      socket.emit("connected");
    };
    socket.disconnect = async () => socket.emit("disconnected");
    const calls: any[] = [];
    const web = {
      auth: { test: async () => ({ user_id: "B1", user: "rin" }) },
      apiCall: async (...args: any[]) => (calls.push(["api", ...args]), "api"),
      chat: {
        postMessage: async (payload: any) => {
          calls.push(["post", payload]);
          return { ts: `ts-${calls.length}` };
        },
        update: async (payload: any) => (
          calls.push(["update", payload]),
          { ts: payload.ts }
        ),
        delete: async (payload: any) => (calls.push(["delete", payload]), true),
      },
      conversations: {
        info: async (payload: any) => (calls.push(["info", payload]), payload),
        members: async (payload: any) => (
          calls.push(["members", payload]),
          payload
        ),
      },
      reactions: {
        add: async (payload: any) => (
          calls.push(["reaction-add", payload]),
          true
        ),
        remove: async (payload: any) => (
          calls.push(["reaction-remove", payload]),
          true
        ),
      },
      files: {
        uploadV2: async (payload: any) => (
          calls.push(["upload", payload]),
          { files: [{ id: "F1" }] }
        ),
      },
      users: {
        info: async () => ({
          user: {
            real_name: "Owner Real",
            name: "owner",
            profile: { display_name: "Owner Display" },
          },
        }),
      },
    };
    owner.slackWeb = web;
    owner.slackSocket = socket;
    const targetApp = app();
    const log = logger();
    const noBot = new adapters.SlackAdapter(targetApp, directory, {}, log);
    await assert.rejects(noBot.start(), /slack_bot_token_required/);
    const noApp = new adapters.SlackAdapter(
      targetApp,
      directory,
      { botToken: "xoxb" },
      log,
    );
    await assert.rejects(noApp.start(), /slack_app_token_required/);

    const adapter = new adapters.SlackAdapter(
      targetApp,
      directory,
      { token: "xapp", botToken: "xoxb" },
      log,
    );
    await adapter.start();
    const bot = adapter.bot;
    assert.equal(bot.selfId, "B1");
    assert.equal(bot.status, 1);
    assert.equal(
      await bot.internal.apiCall("owner.method", { ok: true }),
      "api",
    );
    await bot.internal.postMessage({ text: "owner" });
    await bot.internal.updateMessage({ ts: "1" });
    await bot.internal.deleteMessage({ ts: "1" });
    await bot.internal.conversationsInfo({ channel: "C1" });
    await bot.internal.conversationsMembers({ channel: "C1" });
    await bot.internal.reactionsAdd({ name: "fire" });
    await bot.internal.reactionsRemove({ name: "fire" });
    await bot.internal.filesUploadV2({ file: Buffer.from("owner") });
    await bot.createReaction("C1", "1", "🔥");
    await bot.deleteReaction("C1", "1", ":custom:");
    await assert.rejects(bot.createReaction("C1", "1", ""), /emoji_required/);

    const originalTransportFetch = (adapter as any).httpTransport.fetch;
    (adapter as any).httpTransport.fetch = async () =>
      new Response(Buffer.from("owner-file"), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    try {
      await (adapter as any).handleSlackEvent({ type: "ignored" });
      await (adapter as any).handleSlackEvent({
        type: "events_api",
        body: { event: { type: "reaction_added" } },
      });
      await (adapter as any).handleSlackEvent({
        type: "events_api",
        body: {
          team_id: "T1",
          event: {
            type: "message",
            user: "U1",
            channel: "C1",
            ts: "123.5",
            text: "<@B1> hello",
            files: [
              {
                id: "F1",
                name: "owner.txt",
                mimetype: "text/plain",
                url_private_download: "https://owner/file",
              },
              {},
            ],
          },
        },
        ack: async () => calls.push(["ack"]),
      });
    } finally {
      (adapter as any).httpTransport.fetch = originalTransportFetch;
    }
    const inbound = targetApp.records.find(([name]) => name === "message")?.[1];
    assert.equal(inbound.stripped.content, "hello");
    assert.equal(inbound.elements[1].type, "file");
    assert.equal(inbound.guildId, "T1");

    const h = (type: string, attrs: any = {}) => ({
      type,
      attrs,
      children: [],
    });
    const todo = {
      type: "todo",
      attrs: {
        title: "Owner tasks",
        items: [
          { text: "done", done: true },
          { text: "next", done: false },
        ],
      },
      children: [],
    };
    const result = await bot.sendMessage("C1", [
      h("quote", { id: "thread" }),
      h("text", { content: "hello" }),
      todo,
      h("file", { data: Buffer.from("file"), name: "owner.txt" }),
    ]);
    assert.equal(result.length, 3);
    assert.equal(
      calls.some(([name]) => name === "upload"),
      true,
    );

    socket.emit("error", new Error("socket owner"));
    socket.emit("slack_event", { type: "events_api", body: { event: {} } });
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.stop();
    assert.equal(bot.status, 0);
  });
});

test("slack adapter owns authenticated file downloads and failures", async () => {
  await withTempDir(async (directory) => {
    const server = http.createServer((request, response) => {
      if (request.url === "/bad") {
        response.writeHead(503).end("no");
        return;
      }
      assert.equal(request.headers.authorization, "Bearer owner");
      response.writeHead(200).end("downloaded");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;
      const target = path.join(directory, "downloaded.txt");
      const body = await adapters.__rinOwnerDownloadToFile(
        target,
        `${base}/ok`,
        { Authorization: "Bearer owner" },
      );
      assert.equal(body.toString(), "downloaded");
      await assert.rejects(
        () => adapters.__rinOwnerDownloadToFile(target, `${base}/bad`),
        /download_failed:503/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("slack adapter discards failed download response bodies", async () => {
  for (const response of [
    {
      ok: false,
      status: 503,
      bodyError: "download_failed:503",
      async arrayBuffer() {
        throw new Error("arrayBuffer should not run");
      },
    },
    {
      ok: true,
      status: 200,
      bodyError: "body_read_failed",
      async arrayBuffer() {
        throw new Error("body_read_failed");
      },
    },
  ]) {
    let cancelled = 0;
    const transport = {
      async fetch() {
        return {
          ...response,
          body: {
            async cancel() {
              cancelled += 1;
            },
          },
        };
      },
      async close() {},
    };

    await assert.rejects(
      adapters.__rinOwnerDownloadToFile(
        "/tmp/rin-download-should-not-exist",
        "https://example.com/failure",
        undefined,
        transport,
      ),
      new RegExp(response.bodyError),
    );
    assert.equal(cancelled, 1);
  }
});
