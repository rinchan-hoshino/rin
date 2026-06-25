import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const extraAdapters = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-runtime", "extra-adapters.js"),
  ).href
);

function makeMatrixAdapter() {
  const sessions: any[] = [];
  const app = {
    bot: null as any,
    register(_adapter: any, bot: any) {
      this.bot = bot;
    },
    emit(type: string, session: any) {
      if (type === "message") sessions.push(session);
    },
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-matrix-test-"));
  const adapter = new extraAdapters.MatrixAdapter(
    app,
    dataDir,
    {
      name: "test",
      homeserverUrl: "https://matrix.example.test",
      accessToken: "matrix-token",
    },
    console,
  );
  adapter.baseUrl = "https://matrix.example.test";
  adapter.accessToken = "matrix-token";
  adapter.bot.selfId = "@rinchan:matrix.example.test";
  return { adapter, app, sessions };
}

test("matrix adapter sends quote nodes as Matrix native reply relations through the SDK", async () => {
  const { adapter, app } = makeMatrixAdapter();
  const sent: Array<{ roomId: string; content: any; txnId: string }> = [];
  adapter.client = {
    async sendMessage(roomId: string, content: any, txnId: string) {
      sent.push({ roomId, content, txnId });
      return { event_id: `$sent-${sent.length}` };
    },
  };

  const delivered = await app.bot.sendMessage("!room:matrix.example.test", [
    { type: "quote", attrs: { id: "$parent-event" } },
    { type: "text", attrs: { content: "hello" } },
  ]);

  assert.deepEqual(delivered, ["$sent-1"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].roomId, "!room:matrix.example.test");
  assert.match(sent[0].txnId, /^rin-/);
  assert.deepEqual(sent[0].content, {
    msgtype: "m.text",
    body: "hello",
    "m.relates_to": {
      "m.in_reply_to": { event_id: "$parent-event" },
    },
  });
});

test("matrix adapter sends image-only rich content as Matrix media", async () => {
  const { adapter, app } = makeMatrixAdapter();
  const sent: Array<{ roomId: string; content: any; txnId: string }> = [];
  const uploaded: Array<{ data: Buffer; opts: any }> = [];
  adapter.client = {
    async uploadContent(data: Buffer, opts: any) {
      uploaded.push({ data, opts });
      return { content_uri: "mxc://matrix.example.test/image-1" };
    },
    async sendMessage(roomId: string, content: any, txnId: string) {
      sent.push({ roomId, content, txnId });
      return { event_id: `$sent-${sent.length}` };
    },
  };

  const delivered = await app.bot.sendMessage("!room:matrix.example.test", [
    { type: "quote", attrs: { id: "$parent-event" } },
    {
      type: "image",
      attrs: {
        data: Buffer.from("png-bytes"),
        name: "preview.png",
        mimeType: "image/png",
      },
    },
  ]);

  assert.deepEqual(delivered, ["$sent-1"]);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].data.toString(), "png-bytes");
  assert.deepEqual(uploaded[0].opts, {
    name: "preview.png",
    type: "image/png",
  });
  assert.deepEqual(sent[0].content, {
    msgtype: "m.image",
    body: "preview.png",
    url: "mxc://matrix.example.test/image-1",
    info: { mimetype: "image/png", size: 9 },
    "m.relates_to": {
      "m.in_reply_to": { event_id: "$parent-event" },
    },
  });
});

test("matrix adapter preserves text and media order while only quoting the first event", async () => {
  const { adapter, app } = makeMatrixAdapter();
  const sent: Array<{ content: any }> = [];
  adapter.client = {
    async uploadContent() {
      return { content_uri: "mxc://matrix.example.test/file-1" };
    },
    async sendMessage(_roomId: string, content: any) {
      sent.push({ content });
      return { event_id: `$sent-${sent.length}` };
    },
  };

  const delivered = await app.bot.sendMessage("!room:matrix.example.test", [
    { type: "quote", attrs: { id: "$parent-event" } },
    { type: "text", attrs: { content: "before" } },
    {
      type: "file",
      attrs: {
        data: Buffer.from("file-bytes"),
        name: "report.bin",
        mimeType: "application/octet-stream",
      },
    },
    { type: "text", attrs: { content: "after" } },
  ]);

  assert.deepEqual(delivered, ["$sent-1", "$sent-2", "$sent-3"]);
  assert.equal(sent[0].content.msgtype, "m.text");
  assert.equal(sent[0].content.body, "before");
  assert.deepEqual(sent[0].content["m.relates_to"], {
    "m.in_reply_to": { event_id: "$parent-event" },
  });
  assert.equal(sent[1].content.msgtype, "m.file");
  assert.equal(sent[1].content["m.relates_to"], undefined);
  assert.equal(sent[2].content.msgtype, "m.text");
  assert.equal(sent[2].content.body, "after");
  assert.equal(sent[2].content["m.relates_to"], undefined);
});

test("matrix adapter exposes inbound Matrix reply relations as chat quotes", () => {
  const { adapter, sessions } = makeMatrixAdapter();

  adapter.handleRoomEvent("!room:matrix.example.test", {
    type: "m.room.message",
    event_id: "$reply-event",
    sender: "@owner:matrix.example.test",
    origin_server_ts: 123,
    content: {
      msgtype: "m.text",
      body: "reply body",
      "m.relates_to": {
        "m.in_reply_to": { event_id: "$parent-event" },
      },
    },
  });

  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].quote, { messageId: "$parent-event" });
  assert.equal(sessions[0].messageId, "$reply-event");
  assert.equal(sessions[0].content, "reply body");
});
