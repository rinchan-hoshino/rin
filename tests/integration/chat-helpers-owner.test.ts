import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import * as helpers from "../../dist/core/chat/chat-helpers.js";
import * as store from "../../dist/core/chat/message-store.js";

await import("./chat-helpers.test.js");

async function withTempDir(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-helper-owner-"),
  );
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const chatKey = "telegram/bot:owner";
const base = {
  chatKey,
  platform: "telegram",
  botId: "bot",
  chatId: "owner",
  chatType: "private" as const,
};

function save(root: string, value: Record<string, unknown>) {
  return store.saveChatMessage(root, { ...base, ...value } as any);
}

test("chat helpers recognize content, images, files, and media element families", async () => {
  assert.equal(helpers.hasMediaElements(null as any), false);
  assert.equal(helpers.hasMediaElements([]), false);
  assert.equal(helpers.hasMediaElements([{ type: "text" }]), false);
  assert.equal(helpers.hasMediaElements([null]), false);
  for (const type of [
    "img",
    "image",
    "file",
    "video",
    "audio",
    "voice",
    "sticker",
    "record",
    "face",
    "mface",
  ]) {
    assert.equal(
      helpers.hasMediaElements([{ type: type.toUpperCase() }]),
      true,
      type,
    );
  }
  assert.equal(
    helpers.extractTextFromContent([
      { type: "thinking", thinking: "reason" },
      { type: "text", text: " answer " },
    ]),
    "answer",
  );
  assert.match(
    helpers.extractTextFromContent(
      [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "answer" },
      ],
      { includeThinking: true },
    ),
    /reason.*answer/s,
  );
  assert.deepEqual(
    helpers.extractImageParts([
      { type: "image", data: "abc", mimeType: "image/png" },
    ]),
    [{ data: "abc", mimeType: "image/png" }],
  );
  assert.deepEqual(
    helpers.extractExistingFilePaths(
      `see ${pathToFileURL(import.meta.filename).href}`,
    ),
    [import.meta.filename],
  );
});

test("chat helpers persist inbound identity and resolve reply session state", async () => {
  await withTempDir(async (root) => {
    const session = {
      platform: "telegram",
      selfId: "bot",
      channelId: "owner",
      messageId: "incoming-1",
      timestamp: Date.parse("2026-04-05T12:00:00.000Z"),
      userId: "owner-user",
      user: { id: "owner-user" },
      author: { name: "Owner" },
      content: "hello",
      stripped: { content: "hello" },
    };
    let trustArgs: unknown[] = [];
    const stored = helpers.persistInboundMessage(
      root,
      session,
      [{ type: "text", attrs: { content: "hello" } }],
      { role: "owner" },
      (...args) => {
        trustArgs = args;
        return "OWNER";
      },
      { chatKey },
    );
    assert.ok(stored);
    assert.deepEqual(trustArgs, [{ role: "owner" }, "telegram", "owner-user"]);
    assert.equal(
      helpers.persistInboundMessage(root, {}, [], {}, () => "UNKNOWN"),
      null,
    );
    assert.equal(
      helpers.persistInboundMessage(
        root,
        { ...session, messageId: "" },
        [],
        {},
        () => "OWNER",
      ),
      null,
    );
    assert.equal(helpers.lookupReplyMessage(root, "", "incoming-1"), null);
    assert.equal(helpers.lookupReplyMessage(root, chatKey, ""), null);
    assert.equal(helpers.lookupReplyMessage(root, chatKey, "missing"), null);

    helpers.markProcessedChatMessage(root, chatKey, "incoming-1", {
      processedAt: "2026-04-05T12:00:02.000Z",
      sessionFile: path.join(root, "sessions", "owner.jsonl"),
      sessionId: "removed",
    });
    const reply = helpers.lookupReplySession(root, chatKey, "incoming-1");
    assert.equal(reply?.linked.messageId, "incoming-1");
    assert.equal(
      reply?.sessionFile,
      path.join(root, "sessions", "owner.jsonl"),
    );
    assert.equal((reply?.linked as any).sessionId, undefined);
    assert.equal(helpers.lookupReplySession(root, chatKey, "missing"), null);
    assert.equal(
      helpers.isInboundChatMessageProcessed(root, chatKey, "incoming-1"),
      true,
    );
    assert.equal(
      helpers.isInboundChatMessageProcessed(root, "", "incoming-1"),
      false,
    );
  });
});

test("chat helper replay boundaries distinguish substantive latest delivery and later /new", async () => {
  await withTempDir(async (root) => {
    save(root, {
      messageId: "user-1",
      role: "user",
      text: "first",
      receivedAt: "2026-04-05T12:00:00.000Z",
    });
    save(root, {
      messageId: "assistant-1",
      role: "assistant",
      text: "answer",
      deliveryKind: "final",
      processedAt: "2026-04-05T12:00:01.000Z",
      receivedAt: "2026-04-05T12:00:01.000Z",
      replyToMessageId: "user-1",
    });
    save(root, {
      messageId: "working",
      role: "assistant",
      text: "working",
      deliveryKind: "working",
      processedAt: "2026-04-05T12:00:02.000Z",
      receivedAt: "2026-04-05T12:00:02.000Z",
      replyToMessageId: "user-1",
    });
    assert.equal(
      helpers.hasDeliveredAssistantReplyForMessage(root, chatKey, "user-1"),
      true,
    );
    assert.equal(
      helpers.isReplyToLatestAssistantMessage(root, chatKey, "assistant-1"),
      true,
    );

    save(root, {
      messageId: "assistant-2",
      role: "assistant",
      text: "newer",
      deliveryKind: "generic",
      processedAt: "2026-04-05T12:00:03.000Z",
      receivedAt: "2026-04-05T12:00:03.000Z",
      recordKey: "z",
    });
    assert.equal(
      helpers.isReplyToLatestAssistantMessage(root, chatKey, "assistant-1"),
      false,
    );
    assert.equal(
      helpers.isReplyToLatestAssistantMessage(root, chatKey, "user-1"),
      false,
    );

    save(root, {
      messageId: "new-boundary",
      role: "user",
      text: "/NEW now",
      processedAt: "2026-04-05T12:00:04.000Z",
      receivedAt: "2026-04-05T12:00:04.000Z",
    });
    assert.equal(
      helpers.hasLaterNewSessionBoundary(root, chatKey, "user-1"),
      true,
    );
    assert.equal(helpers.hasLaterNewSessionBoundary(root, "", "user-1"), false);
    assert.equal(
      helpers.hasLaterNewSessionBoundary(root, chatKey, "missing"),
      false,
    );
    assert.equal(
      helpers.hasInboundChatMessageReplyBoundary(root, chatKey, "user-1"),
      true,
    );
  });
});

test("chat helpers persist outbound image parts and format failure notices", async () => {
  await withTempDir(async (root) => {
    const images = await helpers.persistImageParts(
      root,
      [
        { data: Buffer.from("one").toString("base64"), mimeType: "image/png" },
        { data: Buffer.from("two").toString("base64"), mimeType: "image/jpeg" },
      ],
      "owner",
    );
    assert.deepEqual(
      images.map((item) => item.name),
      ["owner-1.png", "owner-2.jpg"],
    );
    assert.equal(await fs.readFile(images[0].path, "utf8"), "one");

    assert.equal(helpers.buildInboundAttachmentNotice([]), "");
    assert.equal(helpers.buildInboundAttachmentNotice(null as any), "");
    assert.match(
      helpers.buildInboundAttachmentNotice([
        { type: "img", kind: "image", reason: "unresolved_resource" },
      ]),
      /1 media element was present/,
    );
    assert.match(
      helpers.buildInboundAttachmentNotice([
        { type: "file", kind: "file", reason: "fetch_failed" },
      ]),
      /1 media resource could not be fetched/,
    );
    assert.match(
      helpers.buildInboundAttachmentNotice([
        { type: "img", kind: "image", reason: "unresolved_resource" },
        { type: "file", kind: "file", reason: "unresolved_resource" },
        { type: "file", kind: "file", reason: "fetch_failed" },
        { type: "file", kind: "file", reason: "fetch_failed" },
      ]),
      /2 media elements were present.*2 media resources could not be fetched/,
    );
  });
});

test("chat helpers save file and data resources and report unresolved or failed media", async () => {
  await withTempDir(async (root) => {
    const local = path.join(root, "owner source.txt");
    await fs.writeFile(local, "local-owner");
    const data = `data:text/plain;base64,${Buffer.from("data-owner").toString("base64")}`;
    const result = await helpers.extractInboundAttachments(
      [
        { type: "text", attrs: { content: "ignored" } },
        { type: "img" },
        {
          type: "image",
          attrs: {
            src: pathToFileURL(local).href,
            title: "owner?.png",
            mimeType: "image/png; charset=binary",
          },
        },
        { type: "file", attrs: { url: data, name: "data-owner" } },
        {
          type: "voice",
          attrs: { path: pathToFileURL(path.join(root, "missing.ogg")).href },
        },
        { type: "audio", attrs: { src: "not a valid URL" } },
      ],
      root,
    );
    assert.equal(result.attachments.length, 2);
    assert.deepEqual(
      result.attachments.map((item) => item.kind),
      ["image", "file"],
    );
    assert.equal(result.attachments[0].mimeType, "image/png");
    assert.match(result.attachments[0].name, /owner.*\.png$/);
    assert.equal(result.attachments[1].mimeType, "text/plain");
    assert.deepEqual(
      result.attachments.map((item) => item.sourceMediaIndex),
      [1, 2],
    );
    assert.equal(result.failures.length, 3);
    assert.equal(result.failures[0].reason, "unresolved_resource");
    assert.equal(result.failures[1].reason, "fetch_failed");
    assert.ok(result.failures[1].detail);
    assert.equal(result.failures[2].type, "audio");
  });
});

test("chat helpers render only correctly matched saved attachments", async () => {
  await withTempDir(async (root) => {
    const image = path.join(root, "image.png");
    const file = path.join(root, "owner.txt");
    await fs.writeFile(image, "image");
    await fs.writeFile(file, "file");
    const rendered = helpers.renderPromptTextWithSavedAttachments(
      [
        { type: "text", attrs: { content: "look" } },
        { type: "image", attrs: { file: "missing.png" } },
        { type: "image", attrs: { file: "image.png" } },
        { type: "file", attrs: { name: "owner.txt" } },
        { type: "video", attrs: { file: "unmatched.mp4" } },
      ],
      [
        {
          kind: "image",
          path: image,
          name: "image.png",
          mimeType: "image/png",
        },
        { kind: "file", path: file, name: "owner.txt", mimeType: "text/plain" },
        { kind: "file", path: "", name: "unmatched.mp4", sourceMediaIndex: 4 },
      ],
    );
    assert.match(rendered, /look/);
    assert.match(rendered, /missing\.png/);
    assert.match(
      rendered,
      new RegExp(image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(
      rendered,
      new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    const indexed = helpers.renderPromptTextWithSavedAttachments(
      [{ type: "image" }, { type: "image" }],
      [{ kind: "image", path: image, name: "image.png", sourceMediaIndex: 2 }],
    );
    assert.match(indexed, /^\[image: image\]/);
    assert.match(indexed, /image\.png/);
    assert.equal(
      helpers.renderPromptTextWithSavedAttachments(null as any, null as any),
      "",
    );
  });
});
