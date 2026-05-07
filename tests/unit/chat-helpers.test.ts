import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
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

test("chat chat helpers extract reply ids and quote text from canonical chat quote", () => {
  const session = {
    quote: {
      messageId: "quoted-42",
      userId: "owner-1",
      nickname: "Owner",
      content: "older context",
    },
  };
  assert.equal(helpers.pickReplyToMessageId(session), "quoted-42");
  assert.deepEqual(helpers.summarizeQuote(session), {
    messageId: "quoted-42",
    userId: "owner-1",
    nickname: "Owner",
    content: "older context",
  });
});

test("chat chat helpers pick only own unsessioned quote text", () => {
  const ownQuoteSession = {
    userId: "owner-1",
    quote: {
      messageId: "quoted-42",
      userId: "owner-1",
      content: "older context",
    },
  };
  assert.equal(
    helpers.pickUnsessionedOwnQuoteText({ session: ownQuoteSession }),
    "older context",
  );
  assert.equal(
    helpers.prependQuoteTextToPromptBody("please continue", "older context"),
    "older context\n\nplease continue",
  );
  assert.equal(
    helpers.pickUnsessionedOwnQuoteText({
      session: ownQuoteSession,
      linkedSessionFile: "/tmp/session.jsonl",
    }),
    "",
  );
  assert.equal(
    helpers.pickUnsessionedOwnQuoteText({
      session: {
        userId: "owner-1",
        quote: {
          messageId: "quoted-42",
          userId: "guest-1",
          content: "someone else's context",
        },
      },
    }),
    "",
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

test("chat chat helpers treat any delivered assistant text as a replay boundary", async () => {
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
      processedAt: new Date().toISOString(),
    });

    assert.equal(
      helpers.hasDeliveredAssistantReplyForMessage(agentDir, chatKey, "m-user"),
      true,
    );
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
