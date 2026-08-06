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
const helpers = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-helpers.js"))
    .href
);
const textUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "text-utils.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("chat chat helpers extract chat metadata", () => {
  assert.equal(helpers.safeString, textUtils.safeString);
  const session = {
    platform: "telegram",
    guildId: "g1",
    userId: "u1",
    channelId: "c1",
    author: {
      name: "AliceCard",
      groupNickname: "AliceCard",
      nickname: "AliceAccount",
    },
    stripped: { content: "/new hello", appel: true },
    content: "/new hello",
  };
  assert.equal(helpers.pickUserId(session), "u1");
  assert.equal(helpers.pickSenderNickname(session), "AliceAccount");
  assert.equal(helpers.pickSenderGroupNickname(session), "AliceCard");
  assert.equal(helpers.getChatId(session), "c1");
  assert.equal(helpers.getChatType(session), "group");
});

test("chat chat helpers treat explicit at-elements as mentions even when stripped.appel is missing", () => {
  const session = {
    platform: "telegram",
    guildId: "g1",
    selfId: "8623230033",
    bot: {
      selfId: "8623230033",
      username: "THE_cattail_rin_chan_bot",
    },
    elements: [
      { type: "at", attrs: { name: "THE_cattail_rin_chan_bot" } },
      { type: "text", attrs: { content: " ping" } },
    ],
    stripped: { content: "ping" },
  };
  assert.equal(helpers.mentionLike(session), true);
});

test("chat chat helpers extract reply ids from canonical quote rich text", () => {
  const elements = helpers.ensureSessionElements({
    elements: [
      {
        type: "quote",
        attrs: { id: "quoted-42" },
      },
    ],
  });
  assert.equal(helpers.pickReplyToMessageId(elements), "quoted-42");
});

test("chat chat helpers inline only an unsessioned own user quote", () => {
  const ownUserMessage = {
    role: "user",
    userId: "owner-1",
    text: "  first half  ",
  };
  assert.equal(
    helpers.pickUnsessionedOwnQuoteText({
      senderUserId: "owner-1",
      linked: ownUserMessage,
    }),
    "  first half  ",
  );
  assert.equal(
    helpers.pickUnsessionedOwnQuoteText({
      senderUserId: "owner-1",
      linked: ownUserMessage,
      linkedSessionFile: "/sessions/linked.jsonl",
    }),
    null,
  );
  assert.equal(
    helpers.pickUnsessionedOwnQuoteText({
      senderUserId: "other-1",
      linked: ownUserMessage,
    }),
    null,
  );
  assert.equal(
    helpers.pickUnsessionedOwnQuoteText({
      senderUserId: "owner-1",
      linked: {
        ...ownUserMessage,
        text: "",
        strippedContent: "fallback should not leak",
      },
    }),
    "",
  );
  assert.equal(
    helpers.prependQuoteTextToPromptBody("  second half  ", "  first half  "),
    "  first half  \n\n  second half  ",
  );
});

test("chat chat helpers derive incoming text from elements", () => {
  assert.equal(
    helpers.elementsToText([
      { type: "text", attrs: { content: "check /tmp/demo.log" } },
    ]),
    "check /tmp/demo.log",
  );
  assert.equal(
    helpers.elementsToText([
      { type: "at", attrs: { id: "1" } },
      { type: "text", attrs: { content: " check /tmp/demo.log" } },
    ]),
    "[@1](at:1) check /tmp/demo.log",
  );
  assert.equal(
    helpers.elementsToText([
      {
        type: "paragraph",
        children: [{ type: "text", attrs: { content: "first line" } }],
      },
      { type: "br" },
      { type: "text", attrs: { content: "second line" } },
    ]),
    "first line\n\nsecond line",
  );
  assert.equal(
    helpers.elementsToText([
      { type: "at", attrs: { id: "1" } },
      {
        type: "p",
        children: [
          { type: "text", attrs: { content: " mixed" } },
          { type: "br" },
          { type: "text", attrs: { content: "element" } },
        ],
      },
      { type: "text", attrs: { content: " done" } },
    ]),
    "[@1](at:1) mixed\nelement\ndone",
  );
  assert.equal(
    helpers.elementsToText([{ type: "img", attrs: { file: "demo.png" } }]),
    "[image: demo.png](demo.png)",
  );
  assert.equal(
    helpers.hasMediaElements([{ type: "img", attrs: { file: "demo.png" } }]),
    true,
  );
  assert.equal(
    helpers.hasMediaElements([{ type: "image", attrs: { src: "demo.png" } }]),
    true,
  );
  assert.equal(
    helpers.hasMediaElements([{ type: "file", attrs: { src: "demo.txt" } }]),
    true,
  );
  assert.equal(helpers.hasMediaElements([{ type: "text" }]), false);
});

test("chat chat helpers synthesize text elements only when upstream omitted elements", () => {
  assert.deepEqual(
    helpers.ensureSessionElements({
      stripped: { content: "check /tmp/demo.log" },
    }),
    [{ type: "text", attrs: { content: "check /tmp/demo.log" } }],
  );
});

test("chat chat helpers treat final assistant delivery as a replay boundary", async () => {
  await withTempDir(async (agentDir) => {
    const chatKey = "telegram/1:2";
    const base = {
      chatKey,
      platform: "telegram",
      botId: "1",
      chatId: "2",
      chatType: "private",
      receivedAt: new Date().toISOString(),
    };
    messageStore.saveChatMessage(agentDir, {
      ...base,
      messageId: "m-user",
      role: "user",
      text: "please check",
    });
    messageStore.saveChatMessage(agentDir, {
      ...base,
      messageId: "m-assistant",
      role: "assistant",
      replyToMessageId: "m-user",
      text: "I will check",
      deliveryKind: "final",
      processedAt: new Date().toISOString(),
    });

    assert.equal(
      helpers.hasDeliveredAssistantReplyForMessage(agentDir, chatKey, "m-user"),
      true,
    );
  });
});

test("chat chat helpers persist duplicate inbound messages without rewriting first-seen state", async () => {
  await withTempDir(async (agentDir) => {
    const chatKey = "lark/bot-1:oc-demo";
    const base = {
      chatKey,
      platform: "lark",
      botId: "bot-1",
      chatId: "oc-demo",
      chatType: "group",
    };
    messageStore.saveChatMessage(agentDir, {
      ...base,
      messageId: "m-user",
      role: "user",
      receivedAt: "2026-07-02T11:23:00.000Z",
      acceptedAt: "2026-07-02T11:23:01.000Z",
      processedAt: "2026-07-02T11:23:04.000Z",
      sessionFile: "sessions/rin-session.jsonl",
      text: "please check",
      rawContent: "please check",
      strippedContent: "please check",
    });
    messageStore.saveChatMessage(agentDir, {
      ...base,
      messageId: "m-assistant",
      role: "assistant",
      replyToMessageId: "m-user",
      receivedAt: "2026-07-02T11:23:05.000Z",
      processedAt: "2026-07-02T11:23:05.000Z",
      text: "checked",
      rawContent: "checked",
      strippedContent: "checked",
      deliveryKind: "final",
    });

    helpers.persistInboundMessage(
      agentDir,
      {
        platform: "lark",
        selfId: "bot-1",
        channelId: "oc-demo",
        messageId: "m-user",
        timestamp: 1783000000000,
        content: "please check",
        stripped: { content: "please check" },
        author: { name: "Owner" },
        user: { id: "owner-1" },
      },
      [{ type: "text", attrs: { content: "please check" } }],
      {},
      () => "OWNER",
      { chatKey },
    );

    const user = messageStore.findChatMessageByChatAndId(
      agentDir,
      chatKey,
      "m-user",
    );
    assert.equal(user.receivedAt, "2026-07-02T11:23:00.000Z");
    assert.equal(user.acceptedAt, "2026-07-02T11:23:01.000Z");
    assert.equal(user.processedAt, "2026-07-02T11:23:04.000Z");
    assert.equal(user.sessionFile, "sessions/rin-session.jsonl");
    assert.equal(user.duplicateCount, 1);
    assert.ok(
      Date.parse(user.lastReceivedAt) > Date.parse(user.receivedAt),
      "lastReceivedAt should record the duplicate delivery time",
    );

    const assistant = messageStore.findChatMessageByChatAndId(
      agentDir,
      chatKey,
      "m-assistant",
    );
    assert.equal(assistant.replyToMessageId, "m-user");
    assert.ok(Date.parse(assistant.receivedAt) > Date.parse(user.receivedAt));
  });
});

test("chat chat helpers persist outbound image parts", async () => {
  await withTempDir(async (dir) => {
    const images = [
      { data: Buffer.from("demo").toString("base64"), mimeType: "image/png" },
    ];
    const out = await helpers.persistImageParts(dir, images, "sample");
    assert.equal(out.length, 1);
    const stat = await fs.stat(out[0].path);
    assert.ok(stat.isFile());
  });
});

test("chat chat helpers report unresolved media placeholders clearly", async () => {
  await withTempDir(async (dir) => {
    const result = await helpers.extractInboundAttachments(
      [{ type: "img" }],
      dir,
    );
    assert.deepEqual(result.attachments, []);
    assert.deepEqual(result.failures, [
      {
        type: "img",
        kind: "image",
        reason: "unresolved_resource",
      },
    ]);
    assert.match(
      helpers.buildInboundAttachmentNotice(result.failures),
      /chat bridge runtime did not resolve a downloadable resource/i,
    );
  });
});

test("chat chat helpers save inbound media when a standard resource is present", async () => {
  await withTempDir(async (dir) => {
    const src = `data:text/plain;base64,${Buffer.from("demo").toString("base64")}`;
    const result = await helpers.extractInboundAttachments(
      [
        { type: "file", attrs: { src, file: "demo.txt" } },
        { type: "image", attrs: { src, file: "demo.png", mime: "image/png" } },
      ],
      dir,
    );
    assert.equal(result.failures.length, 0);
    assert.equal(result.attachments.length, 2);
    assert.equal(result.attachments[0].kind, "file");
    assert.equal(result.attachments[1].kind, "image");
    const stat = await fs.stat(result.attachments[0].path);
    assert.ok(stat.isFile());
  });
});

test("chat chat helpers render saved media as markdown local paths for prompts", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    const filePath = path.join(dir, "demo.txt");
    await fs.writeFile(imagePath, Buffer.from("demo"));
    await fs.writeFile(filePath, "hello", "utf8");

    const text = helpers.renderPromptTextWithSavedAttachments(
      [
        { type: "at", attrs: { id: "owner", name: "Owner" } },
        { type: "text", attrs: { content: " look " } },
        { type: "image", attrs: { file: "demo.png" } },
        { type: "file", attrs: { file: "demo.txt" } },
      ],
      [
        {
          kind: "image",
          path: imagePath,
          name: "demo.png",
          mimeType: "image/png",
        },
        {
          kind: "file",
          path: filePath,
          name: "demo.txt",
          mimeType: "text/plain",
        },
      ],
    );

    assert.match(text, /^\[@Owner\]\(at:owner\) look\n/);
    assert.match(text, /\[image: demo\.png\]\(.*demo\.png\)/);
    assert.match(text, /\[file: demo\.txt\]\(.*demo\.txt\)/);
    assert.doesNotMatch(text, /file:\/\//);
  });
});

test("chat chat helpers do not shift saved media onto unmatched same-kind nodes", async () => {
  await withTempDir(async (dir) => {
    const secondImagePath = path.join(dir, "second.png");
    await fs.writeFile(secondImagePath, Buffer.from("demo"));

    const namedText = helpers.renderPromptTextWithSavedAttachments(
      [
        { type: "image", attrs: { file: "missing.png" } },
        { type: "image", attrs: { file: "second.png" } },
      ],
      [
        {
          kind: "image",
          path: secondImagePath,
          name: "second.png",
          mimeType: "image/png",
        },
      ],
    );

    assert.match(namedText, /\[image: missing\.png\]\(missing\.png\)/);
    assert.match(namedText, /\[image: second\.png\]\(.*second\.png\)/);

    const indexedText = helpers.renderPromptTextWithSavedAttachments(
      [{ type: "image" }, { type: "image" }],
      [
        {
          kind: "image",
          path: secondImagePath,
          name: "second.png",
          mimeType: "image/png",
          sourceMediaIndex: 2,
        },
      ],
    );

    assert.match(indexedText, /^\[image: image\]/);
    assert.match(indexedText, /\[image: second\.png\]\(.*second\.png\)/);

    const ambiguousText = helpers.renderPromptTextWithSavedAttachments(
      [{ type: "image" }],
      [
        {
          kind: "image",
          path: secondImagePath,
          name: "second.png",
          mimeType: "image/png",
        },
      ],
    );

    assert.equal(ambiguousText, "[image: image]");
  });
});

test("chat chat helpers keep extractor media indexes aligned when rendering prompts", async () => {
  await withTempDir(async (dir) => {
    const imageOne = `data:image/png;base64,${Buffer.from("one").toString("base64")}`;
    const imageTwo = `data:image/png;base64,${Buffer.from("two").toString("base64")}`;
    const elements = [
      { type: "text", attrs: { content: "prefix" } },
      { type: "image", attrs: { src: imageOne } },
      { type: "text", attrs: { content: "middle" } },
      { type: "image", attrs: { src: imageTwo } },
    ];

    const result = await helpers.extractInboundAttachments(elements, dir);
    const text = helpers.renderPromptTextWithSavedAttachments(
      elements,
      result.attachments,
    );

    assert.equal(result.attachments.length, 2);
    assert.equal(result.attachments[0].sourceMediaIndex, 1);
    assert.equal(result.attachments[1].sourceMediaIndex, 2);
    assert.match(text, /prefix/);
    assert.match(text, /middle/);
    assert.ok(text.includes(`[image: ${result.attachments[0].name}]`));
    assert.ok(text.includes(`[image: ${result.attachments[1].name}]`));
    assert.ok(text.includes(`${result.attachments[0].name})`));
    assert.ok(text.includes(`${result.attachments[1].name})`));
  });
});

test("chat chat helpers report fetch failures consistently across media sources", async () => {
  await withTempDir(async (dir) => {
    const missingFileUrl = pathToFileURL(path.join(dir, "missing.txt")).href;
    const result = await helpers.extractInboundAttachments(
      [{ type: "image", attrs: { src: missingFileUrl } }, { type: "file" }],
      dir,
    );
    assert.deepEqual(result.attachments, []);
    assert.equal(result.failures.length, 2);
    assert.deepEqual(result.failures[0], {
      type: "image",
      kind: "image",
      reason: "fetch_failed",
      resource: missingFileUrl,
      detail: result.failures[0].detail,
    });
    assert.match(result.failures[0].detail, /no such file|ENOENT/i);
    assert.deepEqual(result.failures[1], {
      type: "file",
      kind: "file",
      reason: "unresolved_resource",
    });
    assert.match(
      helpers.buildInboundAttachmentNotice(result.failures),
      /could not be fetched.*did not resolve a downloadable resource|did not resolve a downloadable resource.*could not be fetched/i,
    );
  });
});

test("chat chat helpers only auto-attach explicit file URLs, not plain paths", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "demo.txt");
    await fs.writeFile(filePath, "demo", "utf8");

    assert.deepEqual(
      helpers.extractExistingFilePaths(`Path for reference only: ${filePath}`),
      [],
    );
    assert.deepEqual(
      helpers.extractExistingFilePaths(
        `Explicit attachment: file://${filePath}`,
      ),
      [filePath],
    );
  });
});

test("chat metadata enrichment preserves first-seen rich inbound evidence", async () => {
  await withTempDir(async (agentDir) => {
    const receivedAt = "2026-07-14T01:00:00.000Z";
    messageStore.saveInboundChatMessage(agentDir, {
      chatKey: "telegram/1:2",
      messageId: "rich-duplicate",
      role: "user",
      platform: "telegram",
      botId: "1",
      chatId: "2",
      receivedAt,
      text: "rich first content",
      rawContent: "rich first content",
      elements: [
        { type: "text", attrs: { content: "rich first content" } },
        { type: "at", attrs: { id: "1" } },
      ],
    });

    helpers.enrichInboundMessageMetadata(
      agentDir,
      {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        messageId: "rich-duplicate",
        userId: "trusted-user",
        timestamp: Date.now(),
        content: "",
        stripped: { content: "" },
      },
      [],
      {},
      () => "TRUSTED",
      { chatKey: "telegram/1:2" },
    );

    const stored = messageStore.getChatMessage(
      agentDir,
      "telegram/1:2",
      "rich-duplicate",
    );
    assert.equal(stored.receivedAt, receivedAt);
    assert.equal(stored.text, "rich first content");
    assert.equal(stored.elements.length, 2);
    assert.equal(stored.duplicateCount || 0, 0);
    assert.equal(stored.userId, "trusted-user");
    assert.equal(stored.trust, "TRUSTED");
  });
});
