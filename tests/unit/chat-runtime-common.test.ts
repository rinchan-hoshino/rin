import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const chatRuntimeCommon = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "common.js"))
    .href
);

test("chat runtime common helpers normalize and render nodes consistently", () => {
  const nodes = chatRuntimeCommon.flattenNodes([
    chatRuntimeCommon.normalizeNode("text", { content: "Hello" }),
    [
      chatRuntimeCommon.normalizeNode("at", { id: "42", name: "Rin" }),
      chatRuntimeCommon.normalizeNode("paragraph", {}, [
        chatRuntimeCommon.normalizeNode("text", { content: " world" }),
      ]),
      null,
    ],
  ]);

  assert.equal(
    chatRuntimeCommon.renderPlainTextFromNodes(nodes),
    "Hello@Rin world",
  );
  assert.equal(
    chatRuntimeCommon.renderPlainTextFromNodes([
      { type: "text", text: "  fallback text  " },
    ]),
    "fallback text",
  );
  assert.equal(
    chatRuntimeCommon.renderPlainTextFromNodes(nodes, {
      renderAt: (attrs) => `<@${attrs.id}>`,
    }),
    "Hello<@42> world",
  );
  assert.equal(
    chatRuntimeCommon.renderPlainTextFromNodes([
      chatRuntimeCommon.normalizeNode("markdown", {
        content: "**bold** [link](https://example.com)",
      }),
      chatRuntimeCommon.normalizeNode("image", {
        src: "https://example.com/cat.png",
        name: "cat.png",
      }),
    ]),
    "bold link\nimage: cat.png",
  );
  assert.equal(
    chatRuntimeCommon.renderPlainTextFromNodes([
      chatRuntimeCommon.normalizeNode("markdown", {
        content: "- one\n* two\n+ three\n1. first\n2) second\n> quoted",
      }),
    ]),
    "- one\n- two\n- three\n1. first\n2. second\n> quoted",
  );
  assert.equal(
    chatRuntimeCommon.renderPlainTextFromNodes(
      [
        chatRuntimeCommon.normalizeNode("markdown", {
          content: "**bold**",
        }),
      ],
      { markdown: "preserve" },
    ),
    "**bold**",
  );
  assert.match(
    chatRuntimeCommon.renderTelegramHtmlFromNodes([
      chatRuntimeCommon.normalizeNode("markdown", {
        content: "**bold** [link](https://example.com)",
      }),
    ]),
    /<b>bold<\/b> <a href="https:\/\/example\.com">link<\/a>/,
  );
  assert.equal(
    chatRuntimeCommon.renderPlainTextFromNodes(
      [
        chatRuntimeCommon.normalizeNode("at", { id: "42", name: "Rin" }),
        chatRuntimeCommon.normalizeNode("quote", { id: "m1" }),
        chatRuntimeCommon.normalizeNode("file", {
          src: "https://example.com/spec.pdf",
          name: "spec.pdf",
        }),
      ],
      { markdown: "preserve" },
    ),
    "[@Rin](at:42)[quote:m1]\n[file: spec.pdf](https://example.com/spec.pdf)",
  );

  assert.equal(
    chatRuntimeCommon.extractQuoteMessageId([
      chatRuntimeCommon.normalizeNode("quote", { id: "abc123" }),
    ]),
    "abc123",
  );

  const prepared = chatRuntimeCommon.prepareOutboundNodes([
    "Hello",
    chatRuntimeCommon.normalizeNode("quote", { id: "abc123" }),
    [chatRuntimeCommon.normalizeNode("at", { id: "42", name: "Rin" })],
  ]);
  assert.deepEqual(
    prepared.nodes.map((node) => node.type),
    ["text", "quote", "at"],
  );
  assert.deepEqual(
    prepared.work.map((node) => node.type),
    ["text", "at"],
  );
  assert.equal(prepared.replyToMessageId, "abc123");
});

test("chat runtime common helpers expand markdown rich object syntax", () => {
  const markdown = chatRuntimeCommon.prepareOutboundNodes([
    chatRuntimeCommon.normalizeNode("markdown", {
      content:
        "Hello [@Rin](at:42) [quote:m1] [image: cat](https://example.com/cat.png) [file: spec.pdf](https://example.com/spec.pdf) [video: demo](https://example.com/demo.mp4) [audio: voice](https://example.com/voice.mp3) [sticker: yay](https://example.com/yay.webp)",
    }),
  ]);
  assert.deepEqual(
    markdown.nodes.map((node) => node.type),
    ["markdown", "at", "quote", "image", "file", "video", "audio", "sticker"],
  );
  assert.equal(markdown.replyToMessageId, "m1");
  assert.equal(markdown.nodes[1].attrs.id, "42");
  assert.equal(markdown.nodes[3].attrs.src, "https://example.com/cat.png");
  assert.equal(markdown.nodes[4].attrs.name, "spec.pdf");
});

test("chat runtime common helpers preserve binary payload naming for buffers and file urls", async () => {
  const bufferPayload = await chatRuntimeCommon.readBinaryFromNode(
    chatRuntimeCommon.normalizeNode("file", {
      data: Buffer.from("demo"),
      name: "bad:/\\name?*",
      mimeType: "image/png",
    }),
  );
  assert.equal(bufferPayload?.name, "bad_name_.png");
  assert.equal(bufferPayload?.mimeType, "image/png");
  assert.equal(bufferPayload?.data.toString("utf8"), "demo");

  const tempDir = await fs.mkdtemp(
    path.join(rootDir, ".tmp-rin-chat-runtime-"),
  );
  try {
    const filePath = path.join(tempDir, "note");
    await fs.writeFile(filePath, "hello file\n", "utf8");
    const filePayload = await chatRuntimeCommon.readBinaryFromNode(
      chatRuntimeCommon.normalizeNode("file", {
        src: chatRuntimeCommon.fileUrl(filePath),
        mimeType: "text/plain",
      }),
    );
    assert.equal(filePayload?.name, "note.txt");
    assert.equal(filePayload?.mimeType, "text/plain");
    assert.equal(filePayload?.data.toString("utf8"), "hello file\n");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("chat runtime media stager copies local files to consumer-visible cache paths", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(rootDir, ".tmp-rin-chat-runtime-"),
  );
  try {
    const sourcePath = path.join(tempDir, "note");
    const cacheDir = path.join(tempDir, "cache");
    await fs.writeFile(sourcePath, "hello staged media\n", "utf8");

    const staged = await chatRuntimeCommon.stageChatMediaFromNode(
      chatRuntimeCommon.normalizeNode("file", {
        src: sourcePath,
        mimeType: "text/plain",
      }),
      { cacheDir, consumerDir: "/container/rin-media" },
    );

    assert.equal(staged?.remote, false);
    assert.match(staged?.src || "", /^file:\/\/\/container\/rin-media\//);
    assert.match(staged?.src || "", /note\.txt$/);
    assert.equal(
      await fs.readFile(staged?.path || "", "utf8"),
      "hello staged media\n",
    );

    const remote = await chatRuntimeCommon.stageChatMediaFromNode(
      chatRuntimeCommon.normalizeNode("image", {
        src: "https://example.com/cat.png",
      }),
      { cacheDir },
    );
    assert.deepEqual(remote, {
      src: "https://example.com/cat.png",
      name: "cat.png",
      mimeType: "",
      remote: true,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("chat runtime common helper utilities share adapter concerns", async () => {
  const calls = [];
  const logger = chatRuntimeCommon.createPrefixedLogger("chat-runtime:test", {
    warn: (...args) => calls.push(args),
  });
  logger.warn("hello");
  assert.deepEqual(calls, [["[chat-runtime:test]", "hello"]]);

  const emitted = [];
  const app = {
    emit(eventName, bot) {
      emitted.push([eventName, bot.status]);
    },
  };
  const bot = { status: 0 };
  chatRuntimeCommon.emitBotStatus(app, bot, 1);
  chatRuntimeCommon.emitBotStatus(app, bot, 1);
  chatRuntimeCommon.emitBotStatus(app, bot, 2);
  assert.deepEqual(emitted, [
    ["bot-status-updated", 1],
    ["bot-status-updated", 2],
  ]);

  assert.equal(
    chatRuntimeCommon.stripMentionTokens("  <@42>, hello <@42>  ", ["<@42>"]),
    "hello",
  );

  const tempDir = await fs.mkdtemp(
    path.join(rootDir, ".tmp-rin-chat-runtime-"),
  );
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer demo");
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("downloaded payload");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/demo.txt`;
    const filePath = path.join(tempDir, "download.txt");
    const buffer = await chatRuntimeCommon.downloadToFile(filePath, url, {
      Authorization: "Bearer demo",
    });
    assert.equal(buffer.toString("utf8"), "downloaded payload");
    assert.equal(await fs.readFile(filePath, "utf8"), "downloaded payload");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
