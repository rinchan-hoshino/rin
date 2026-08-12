import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const common = await importBuiltModule<
  typeof import("../../src/core/chat-runtime/common.js")
>("dist/core/chat-runtime/common.js");
await import("./chat-runtime-common.test.js");

test("rich delivery fallback preserves heterogeneous source nodes", () => {
  assert.equal(
    common.renderRichDeliveryFallback([
      "prefix ",
      [{ type: "br" }, { raw: "raw" }],
      { type: "text", attrs: { value: " value" } },
      { type: "paragraph", children: [" child"] },
      42,
      null,
    ] as any),
    "prefix \nraw value child",
  );
});

test("rich delivery fallback hides local media paths and preserves public URLs", () => {
  const fallback = common.renderRichDeliveryFallback([
    { type: "image", attrs: { src: "/home/rin/private/photo.png" } },
    { type: "file", attrs: { src: "file:///tmp/private/report.pdf" } },
    { type: "audio", attrs: { src: "C:\\Users\\Rin\\private\\voice.wav" } },
    {
      type: "video",
      attrs: { src: "https://example.com/public/demo.mp4" },
    },
  ]);

  assert.match(fallback, /\[image: photo\.png\]/);
  assert.match(fallback, /\[file: report\.pdf\]/);
  assert.match(fallback, /\[audio: voice\.wav\]/);
  assert.match(fallback, /https:\/\/example\.com\/public\/demo\.mp4/);
  assert.doesNotMatch(fallback, /\/home\/rin|\/tmp\/private|C:\\Users/);
});

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-common-owner-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("chat runtime working copy and editable sections preserve explicit ownership", async () => {
  await withTempDir(async () => {
    assert.deepEqual(common.resolveChatRuntimeWorkingCopy(), {
      workingText: "Working...",
      progressTexts: ["Working...", "Working", "Working.", "Working.."],
    });
    assert.equal("randomWorkingText" in common, false);

    assert.equal(common.editableIntermediateHeadText(""), "");
    assert.equal(common.editableIntermediateHeadText("... ready"), "... ready");
    assert.equal(common.editableIntermediateHeadText("ready"), "... ready");
    assert.equal(common.isEditableWorkingText(" Working. "), true);
    assert.equal(common.isEditableWorkingText("custom", ["custom"]), true);
    assert.equal(common.isEditableWorkingText(""), false);

    assert.deepEqual(common.emptyEditableMessageSections(), {
      workingTextChunks: [],
      contentTextChunks: [],
      todoTextChunks: [],
    });
    assert.deepEqual(
      common.editableMessageSectionsFromRecord({
        kind: "working",
        mainTextChunks: ["old", " work"],
      }),
      {
        workingTextChunks: ["old", " work"],
        contentTextChunks: [],
        todoTextChunks: [],
      },
    );
    assert.deepEqual(
      common.editableMessageSectionsFromRecord({
        kind: "todo",
        text: "task",
      }).todoTextChunks,
      ["task"],
    );
    assert.deepEqual(
      common.editableMessageSectionsFromRecord({
        kind: "final",
        contentTextChunks: ["answer"],
        workingText: "wait",
        todoText: "task",
      }),
      {
        workingTextChunks: ["wait"],
        contentTextChunks: ["answer"],
        todoTextChunks: ["task"],
      },
    );

    const working = common.updateEditableMessageSections({
      kind: "working",
      textChunks: ["progress"],
      fallbackTodoTextChunks: ["todo"],
    });
    assert.deepEqual(working, {
      workingTextChunks: ["progress"],
      contentTextChunks: [],
      todoTextChunks: ["todo"],
    });
    const todo = common.updateEditableMessageSections({
      kind: "todo",
      textChunks: ["next"],
      persisted: working,
    });
    assert.deepEqual(todo.todoTextChunks, ["next"]);
    assert.deepEqual(todo.workingTextChunks, ["progress"]);
    const content = common.updateEditableMessageSections({
      kind: "final",
      textChunks: ["done"],
      persisted: todo,
      finalize: true,
    });
    assert.deepEqual(content, {
      workingTextChunks: [],
      contentTextChunks: ["done"],
      todoTextChunks: [],
    });
    assert.match(
      common.composeEditableMessageText(todo),
      /progress[\s\S]*next/,
    );
  });
});

test("chat delivery errors preserve confirmed non-delivery semantics", () => {
  const rejection = new Error("rejected");
  assert.equal(common.confirmedChatDeliveryError(rejection), rejection);
  assert.equal((rejection as any).chatOutboxConfirmedNotDelivered, true);

  const normalized = common.confirmedChatDeliveryError("transport rejected");
  assert.equal(normalized.message, "transport rejected");
  assert.equal((normalized as any).chatOutboxConfirmedNotDelivered, true);
  assert.equal(
    common.confirmedChatDeliveryError(null).message,
    "chat_delivery_rejected",
  );

  const primary = new Error("rich delivery failed");
  assert.equal(common.richFallbackDeliveryError(primary, rejection), primary);
  assert.equal((primary as any).chatOutboxConfirmedNotDelivered, true);

  const uncertain = common.richFallbackDeliveryError("primary failed", null);
  assert.equal(uncertain.message, "primary failed");
  assert.equal("chatOutboxConfirmedNotDelivered" in uncertain, false);
  assert.equal(
    common.richFallbackDeliveryError(null, null).message,
    "rich_delivery_failed",
  );
});

test("chat runtime utility helpers cover text, logging, and structured delivery", () => {
  assert.equal(common.extensionFromMimeType("text/plain"), ".txt");
  assert.equal(common.ensureExtension("report", "text/plain"), "report.txt");
  assert.deepEqual(
    common.compactObject({ a: 1, b: null, c: undefined, d: " ", e: false }),
    {
      a: 1,
      e: false,
    },
  );

  const calls: Array<[string, unknown[]]> = [];
  const logger = common.createPrefixedLogger(" owner ", {
    debug: (...args: unknown[]) => calls.push(["debug", args]),
    info: (...args: unknown[]) => calls.push(["info", args]),
    warn: (...args: unknown[]) => calls.push(["warn", args]),
    error: (...args: unknown[]) => calls.push(["error", args]),
  });
  logger.debug(1);
  logger.info(2);
  logger.warn(3);
  logger.error(4);
  common.createPrefixedLogger("", {}).debug("ignored");
  assert.deepEqual(
    calls.map(([kind, args]) => [kind, args[0]]),
    [
      ["debug", "[owner]"],
      ["info", "[owner]"],
      ["warn", "[owner]"],
      ["error", "[owner]"],
    ],
  );

  const emitted: unknown[] = [];
  const bot = { status: 0 };
  common.emitBotStatus(
    { emit: (...args: unknown[]) => emitted.push(args) },
    bot,
    1,
  );
  common.emitBotStatus(
    { emit: (...args: unknown[]) => emitted.push(args) },
    bot,
    1,
  );
  assert.equal(emitted.length, 1);
  assert.equal(
    common.stripMentionTokens(" , @a hello @a", ["@a", ""]),
    "hello",
  );

  assert.deepEqual(common.splitPlainText("", 10), []);
  assert.deepEqual(common.splitPlainText("one two three", 7), [
    "one",
    "two",
    "three",
  ]);
  assert.deepEqual(common.splitPlainText("abcdef", 0), [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
  ]);
  assert.deepEqual(common.splitPlainText("ab\n\ncd", 4), ["ab", "cd"]);

  const node = common.normalizeNode(" TEXT ", undefined, ["a", [null, "b"]]);
  assert.deepEqual(node, { type: "text", attrs: {}, children: ["a", "b"] });
  assert.deepEqual(common.flattenNodes(["a", [null, ["b"]]]), ["a", "b"]);
  assert.deepEqual(common.flattenNodes("one"), ["one"]);
  assert.deepEqual(common.flattenNodes(null), []);

  const prepared = common.prepareOutboundNodes([
    "hello ",
    common.normalizeNode("quote", { id: "m1" }),
    common.normalizeNode("at", { id: "owner", name: "Owner" }),
  ]);
  assert.equal(prepared.replyToMessageId, "m1");
  assert.deepEqual(
    prepared.work.map((item) => item.type),
    ["text", "at"],
  );
  assert.throws(
    () => common.prepareOutboundNodes([common.normalizeNode("at", {})]),
    /chat_send_at_id_required/,
  );
  assert.equal(common.extractQuoteMessageId([]), undefined);
  assert.equal(
    common.renderPlainTextFromNodes(prepared.nodes),
    "hello [quote:m1]@Owner",
  );
  assert.match(common.renderMarkdownFromNodes(prepared.nodes), /quote:m1/);
  assert.match(common.renderTelegramHtmlFromNodes(prepared.nodes), /hello/);
  assert.equal(common.isEditableProgressDeliveryKind(" interim "), true);
  assert.equal(common.isEditableProgressDeliveryKind("passive_notice"), true);
  assert.equal(common.isEditableProgressDeliveryKind("final"), false);
});

test("chat runtime binary and download helpers keep real I/O boundaries", async () => {
  await withTempDir(async (directory) => {
    const local = path.join(directory, "note");
    await fs.writeFile(local, "owner data");

    const buffered = await common.readBinaryFromNode({
      type: "image",
      attrs: { data: Buffer.from("png"), name: "asset", mimeType: "image/png" },
    });
    assert.equal(buffered?.name, "asset.png");
    assert.equal(buffered?.data.toString(), "png");
    assert.equal(await common.readBinaryFromNode({ attrs: {} }), null);

    const filePayload = await common.readBinaryFromNode({
      type: "file",
      attrs: { src: common.fileUrl(local), mimeType: "text/plain" },
    });
    assert.equal(filePayload?.name, "note.txt");
    assert.equal(filePayload?.data.toString(), "owner data");
    const pathPayload = await common.readBinaryFromNode({
      type: "file",
      attrs: { src: local, name: "preferred" },
    });
    assert.equal(pathPayload?.name, "note");
    const remote = await common.readBinaryFromNode({
      type: "video",
      attrs: { src: "https://example.com/media.mp4", mimeType: "video/mp4" },
    });
    assert.deepEqual(remote, {
      url: "https://example.com/media.mp4",
      name: "media.mp4",
      mimeType: "video/mp4",
    });
    await assert.rejects(
      () =>
        common.readBinaryFromNode({
          attrs: { src: path.join(directory, "missing") },
        }),
      /chat_media_file_missing/,
    );
    await assert.rejects(
      () =>
        common.readBinaryFromNode({
          attrs: { src: common.fileUrl(path.join(directory, "missing")) },
        }),
      /chat_media_file_missing/,
    );

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
      const body = await common.downloadToFile(target, `${base}/ok`, {
        Authorization: "Bearer owner",
      });
      assert.equal(body.toString(), "downloaded");
      await assert.rejects(
        () => common.downloadToFile(target, `${base}/bad`),
        /download_failed:503/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
