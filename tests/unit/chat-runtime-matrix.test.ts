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

function mockFetch(handler: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function mockMatrixMessageFetch(
  sent: Array<{ url: string; init: any; content: any }>,
) {
  return mockFetch(async (url: any, init: any) => {
    const content = JSON.parse(String(init?.body || "{}"));
    sent.push({ url: String(url), init, content });
    return new Response(JSON.stringify({ event_id: `$sent-${sent.length}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

test("matrix adapter sends typing through an isolated Matrix API request", async () => {
  const { adapter, app } = makeMatrixAdapter();
  adapter.client = {};
  const calls: Array<{ url: string; init: any }> = [];
  const restoreFetch = mockFetch(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  });
  try {
    const sent = await app.bot.internal.sendTyping("!room:matrix.example.test");

    assert.equal(sent, true);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://matrix.example.test/_matrix/client/v3/rooms/!room:matrix.example.test/typing/%40rinchan:matrix.example.test",
    );
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      typing: true,
      timeout: 60000,
    });
  } finally {
    restoreFetch();
  }
});

test("matrix adapter suppresses overlapping typing requests per room", async () => {
  const { adapter, app } = makeMatrixAdapter();
  adapter.client = {};
  const calls: string[] = [];
  let resolveTyping!: () => void;
  const restoreFetch = mockFetch(async (url: any) => {
    calls.push(String(url));
    await new Promise<void>((resolve) => {
      resolveTyping = resolve;
    });
    return new Response("{}", { status: 200 });
  });
  try {
    const first = app.bot.internal.sendTyping("!room:matrix.example.test");
    await new Promise((resolve) => setImmediate(resolve));
    const second = await app.bot.internal.sendTyping(
      "!room:matrix.example.test",
    );
    resolveTyping();

    assert.equal(second, false);
    assert.equal(await first, true);
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch();
  }
});

test("matrix adapter suppresses concurrent typing requests across rooms", async () => {
  const { adapter, app } = makeMatrixAdapter();
  adapter.client = {};
  const calls: string[] = [];
  let resolveTyping!: () => void;
  const restoreFetch = mockFetch(async (url: any) => {
    calls.push(String(url));
    await new Promise<void>((resolve) => {
      resolveTyping = resolve;
    });
    return new Response("{}", { status: 200 });
  });
  try {
    const first = app.bot.internal.sendTyping("!room-one:matrix.example.test");
    await new Promise((resolve) => setImmediate(resolve));
    const second = await app.bot.internal.sendTyping(
      "!room-two:matrix.example.test",
    );
    resolveTyping();

    assert.equal(second, false);
    assert.equal(await first, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /!room-one:matrix\.example\.test/);
  } finally {
    restoreFetch();
  }
});

test("matrix adapter refreshes typing after the shorter minimum interval", async () => {
  const { adapter, app } = makeMatrixAdapter();
  adapter.client = {};
  const calls: string[] = [];
  const restoreFetch = mockFetch(async (url: any) => {
    calls.push(String(url));
    return new Response("{}", { status: 200 });
  });
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    assert.equal(
      await app.bot.internal.sendTyping("!room:matrix.example.test"),
      true,
    );
    now += 9_999;
    assert.equal(
      await app.bot.internal.sendTyping("!room:matrix.example.test"),
      false,
    );
    now += 1;
    assert.equal(
      await app.bot.internal.sendTyping("!room:matrix.example.test"),
      true,
    );
    assert.equal(calls.length, 2);
  } finally {
    Date.now = originalNow;
    restoreFetch();
  }
});

test("matrix adapter sends rich text as non-Markdown Matrix plain text", async () => {
  const { adapter, app } = makeMatrixAdapter();
  const sent: Array<{ url: string; init: any; content: any }> = [];
  adapter.client = {
    async sendMessage() {
      throw new Error("matrix sdk sendMessage should not be used");
    },
  };
  const restoreFetch = mockMatrixMessageFetch(sent);
  try {
    await app.bot.sendMessage("!room:matrix.example.test", [
      {
        type: "markdown",
        attrs: { content: "**bold** [link](https://example.test)" },
      },
    ]);

    assert.equal(sent.length, 1);
    assert.match(
      sent[0].url,
      /^https:\/\/matrix\.example\.test\/_matrix\/client\/v3\/rooms\/!room:matrix\.example\.test\/send\/m\.room\.message\/rin-/,
    );
    assert.equal(sent[0].init.method, "PUT");
    assert.equal(sent[0].init.headers.Authorization, "Bearer matrix-token");
    assert.deepEqual(sent[0].content, {
      msgtype: "m.text",
      body: "bold link",
    });
  } finally {
    restoreFetch();
  }
});

test("matrix adapter sends quote nodes as Matrix native reply relations through isolated Matrix API", async () => {
  const { adapter, app } = makeMatrixAdapter();
  const sent: Array<{ url: string; init: any; content: any }> = [];
  adapter.client = {
    async sendMessage() {
      throw new Error("matrix sdk sendMessage should not be used");
    },
  };
  const restoreFetch = mockMatrixMessageFetch(sent);
  try {
    const delivered = await app.bot.sendMessage("!room:matrix.example.test", [
      { type: "quote", attrs: { id: "$parent-event" } },
      { type: "text", attrs: { content: "hello" } },
    ]);

    assert.deepEqual(delivered, ["$sent-1"]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /\/send\/m\.room\.message\/rin-/);
    assert.deepEqual(sent[0].content, {
      msgtype: "m.text",
      body: "hello",
      "m.relates_to": {
        "m.in_reply_to": { event_id: "$parent-event" },
      },
    });
  } finally {
    restoreFetch();
  }
});

test("matrix adapter sends image-only rich content as Matrix media", async () => {
  const { adapter, app } = makeMatrixAdapter();
  const sent: Array<{ url: string; init: any; content: any }> = [];
  const uploaded: Array<{ data: Buffer; opts: any }> = [];
  adapter.client = {
    async uploadContent(data: Buffer, opts: any) {
      uploaded.push({ data, opts });
      return { content_uri: "mxc://matrix.example.test/image-1" };
    },
    async sendMessage() {
      throw new Error("matrix sdk sendMessage should not be used");
    },
  };
  const restoreFetch = mockMatrixMessageFetch(sent);
  try {
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
  } finally {
    restoreFetch();
  }
});

test("matrix adapter preserves text and media order while only quoting the first event", async () => {
  const { adapter, app } = makeMatrixAdapter();
  const sent: Array<{ url: string; init: any; content: any }> = [];
  adapter.client = {
    async uploadContent() {
      return { content_uri: "mxc://matrix.example.test/file-1" };
    },
    async sendMessage() {
      throw new Error("matrix sdk sendMessage should not be used");
    },
  };
  const restoreFetch = mockMatrixMessageFetch(sent);
  try {
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
  } finally {
    restoreFetch();
  }
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
