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
const transport = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "transport.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-transport-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("chat transport buildPromptText keeps the original text intact", () => {
  const result = transport.buildPromptText("hello", [
    { kind: "file", path: "/tmp/a.txt", name: "a.txt" },
    { kind: "image", path: "/tmp/b.png", name: "b.png" },
  ]);
  assert.equal(result, "hello");
});

test("chat transport keeps image-only prompts native", () => {
  const result = transport.buildPromptText("", [
    { kind: "image", path: "/tmp/b.png", name: "b.png" },
  ]);
  assert.equal(result, "");
});

test("chat transport restorePromptParts rebuilds image payloads from disk", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    await fs.writeFile(imagePath, Buffer.from("abc"));
    const restored = await transport.restorePromptParts({
      text: "hi",
      startedAt: Date.now(),
      attachments: [
        {
          kind: "image",
          path: imagePath,
          name: "demo.png",
          mimeType: "image/png",
        },
      ],
    });
    assert.equal(restored.text, "hi");
    assert.equal(restored.images.length, 1);
    assert.equal(restored.images[0].mimeType, "image/png");
  });
});

test("chat transport forwards mixed parts as a single native chat send", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    await fs.writeFile(imagePath, Buffer.from("abc"));
    const sessionFile = path.join(dir, "sessions", "chat", "sess-42.jsonl");
    messageStore.saveChatMessage(dir, {
      messageId: "42",
      chatKey: "telegram/1:2",
      platform: "telegram",
      botId: "1",
      chatId: "2",
      chatType: "private",
      receivedAt: "2026-04-07T00:00:00.000Z",
      sessionFile,
      text: "incoming",
    });
    const sends = [];
    await transport.sendOutboxPayload(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "1",
            async sendMessage(chatId, content) {
              sends.push({ chatId, content });
              return ["m1"];
            },
          },
        ],
      },
      dir,
      {
        type: "parts_delivery",
        chatKey: "telegram/1:2",
        parts: [
          { type: "quote", id: "42" },
          { type: "text", text: "intro" },
          { type: "image", path: imagePath, mimeType: "image/png" },
          { type: "image", path: imagePath, mimeType: "image/png" },
        ],
      },
      Object.assign((type, attrs) => ({ type, attrs }), {
        text(content) {
          return { type: "text", attrs: { content } };
        },
        quote(id) {
          return { type: "quote", attrs: { id } };
        },
      }),
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0].chatId, "2");
    assert.equal(sends[0].content[0].type, "quote");
    assert.equal(sends[0].content[1].type, "text");
    assert.equal(sends[0].content[2].type, "image");
    assert.equal(sends[0].content[3].type, "image");

    const stored = messageStore.getChatMessage(dir, "telegram/1:2", "m1");
    assert.equal(stored?.text, "intro");
    assert.equal(stored?.replyToMessageId, "42");
    assert.equal(stored?.sessionFile, undefined);
  });
});

test("chat transport stores summarized content for non-text part deliveries", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    const filePath = path.join(dir, "demo.txt");
    await fs.writeFile(imagePath, Buffer.from("abc"));
    await fs.writeFile(filePath, "hello\n");

    await transport.sendOutboxPayload(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "1",
            async sendMessage() {
              return ["m-parts-summary"];
            },
          },
        ],
      },
      dir,
      {
        type: "parts_delivery",
        chatKey: "telegram/1:2",
        parts: [
          { type: "image", path: imagePath, mimeType: "image/png" },
          { type: "file", path: filePath, name: "demo.txt" },
        ],
      },
      Object.assign((type, attrs) => ({ type, attrs }), {
        text(content) {
          return { type: "text", attrs: { content } };
        },
        quote(id) {
          return { type: "quote", attrs: { id } };
        },
        file(src, mimeType, options) {
          return { type: "file", attrs: { src, mimeType, ...options } };
        },
      }),
    );

    const stored = messageStore.getChatMessage(
      dir,
      "telegram/1:2",
      "m-parts-summary",
    );
    assert.match(stored?.text || "", /\[#image\]/);
    assert.match(stored?.text || "", /\[#file\]/);
    assert.match(stored?.rawContent || "", /demo\.txt/);
  });
});

test("chat transport forwards text delivery kind to adapters", async () => {
  await withTempDir(async (dir) => {
    const sends = [];
    await transport.sendOutboxPayload(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "1",
            async sendMessage(chatId, content, options) {
              sends.push({ chatId, content, options });
              return ["m-kind"];
            },
          },
        ],
      },
      dir,
      {
        type: "text_delivery",
        chatKey: "telegram/1:2",
        deliveryKind: "passive_notice",
        text: "notice",
      },
      Object.assign((type, attrs) => ({ type, attrs }), {
        text(content) {
          return { type: "text", attrs: { content } };
        },
        quote(id) {
          return { type: "quote", attrs: { id } };
        },
      }),
    );

    assert.equal(sends.length, 1);
    assert.equal(sends[0].chatId, "2");
    assert.deepEqual(sends[0].options, { deliveryKind: "passive_notice" });
  });
});

test("chat transport defaults text delivery kind to final", async () => {
  await withTempDir(async (dir) => {
    const sends = [];
    await transport.sendOutboxPayload(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "1",
            async sendMessage(chatId, content, options) {
              sends.push({ chatId, content, options });
              return ["m-kind-default"];
            },
          },
        ],
      },
      dir,
      {
        type: "text_delivery",
        chatKey: "telegram/1:2",
        text: "final",
      },
      Object.assign((type, attrs) => ({ type, attrs }), {
        text(content) {
          return { type: "text", attrs: { content } };
        },
        quote(id) {
          return { type: "quote", attrs: { id } };
        },
      }),
    );

    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].options, { deliveryKind: "final" });
  });
});

test("chat transport keeps tool and task text deliveries sessionless", async () => {
  await withTempDir(async (dir) => {
    await transport.sendOutboxPayload(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "1",
            async sendMessage() {
              return ["m-text"];
            },
          },
        ],
      },
      dir,
      {
        type: "text_delivery",
        chatKey: "telegram/1:2",
        text: "scheduled hello",
        sessionFile: ` ${path.join(dir, "sessions", "scheduled", "task-session.jsonl")} `,
      },
      Object.assign((type, attrs) => ({ type, attrs }), {
        text(content) {
          return { type: "text", attrs: { content } };
        },
        quote(id) {
          return { type: "quote", attrs: { id } };
        },
      }),
    );
    const stored = messageStore.getChatMessage(dir, "telegram/1:2", "m-text");
    assert.equal(stored?.text, "scheduled hello");
    assert.equal(stored?.sessionFile, undefined);
  });
});

test("chat transport keeps local image and file parts as file urls", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    const filePath = path.join(dir, "demo.txt");
    await fs.writeFile(imagePath, Buffer.from("abc"));
    await fs.writeFile(filePath, "hello\n");
    const h = Object.assign((type, attrs) => ({ type, attrs }), {
      image(src) {
        return { type: "img", attrs: { src } };
      },
      text(content) {
        return { type: "text", attrs: { content } };
      },
      at(id, options) {
        return { type: "at", attrs: { id, ...options } };
      },
      file(src, mimeType, options) {
        return { type: "file", attrs: { src, mimeType, ...options } };
      },
    });
    const imageNode = await transport.messagePartToNode(
      { type: "image", path: imagePath, mimeType: "image/png" },
      h,
    );
    const fileNode = await transport.messagePartToNode(
      {
        type: "file",
        path: filePath,
        mimeType: "text/plain",
        name: "demo.txt",
      },
      h,
    );
    assert.equal(imageNode.type, "image");
    assert.match(imageNode.attrs.src, /^file:\/\//);
    assert.equal(imageNode.attrs.mimeType, "image/png");
    assert.equal(fileNode.type, "file");
    assert.match(fileNode.attrs.src, /^file:\/\//);
    assert.equal(fileNode.attrs.mimeType, "text/plain");
    assert.equal(fileNode.attrs.name, "demo.txt");
  });
});

test("chat transport direct send helpers prepend quotes and reuse file urls", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    const filePath = path.join(dir, "demo.txt");
    await fs.writeFile(imagePath, Buffer.from("abc"));
    await fs.writeFile(filePath, "hello\n");
    const sends = [];
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          async sendMessage(chatId, content) {
            sends.push({ chatId, content });
            return [`m-${sends.length}`];
          },
        },
      ],
    };
    const h = Object.assign((type, attrs) => ({ type, attrs }), {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      quote(id) {
        return { type: "quote", attrs: { id } };
      },
    });

    await transport.sendText(app, "telegram/1:2", "hello", h, "41");
    await transport.sendImageFile(
      app,
      "telegram/1:2",
      imagePath,
      h,
      "image/png",
      "42",
    );
    await transport.sendGenericFile(
      app,
      "telegram/1:2",
      filePath,
      h,
      "demo.txt",
      "43",
    );

    assert.equal(sends.length, 3);
    assert.deepEqual(
      sends.map((entry) => entry.content.map((node) => node.type)),
      [
        ["quote", "text"],
        ["quote", "image"],
        ["quote", "file"],
      ],
    );
    assert.equal(sends[0].chatId, "2");
    assert.equal(sends[0].content[0].attrs.id, "41");
    assert.equal(sends[1].content[1].attrs.mimeType, "image/png");
    assert.match(sends[1].content[1].attrs.src, /^file:\/\//);
    assert.equal(sends[2].content[1].attrs.name, "demo.txt");
    assert.match(sends[2].content[1].attrs.src, /^file:\/\//);
  });
});

test("chat transport rejects invalid parts and empty deliveries early", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      transport.messagePartToNode(
        { type: "image" },
        {
          image(src) {
            return { type: "image", attrs: { src } };
          },
        },
      ),
      /chat_outbox_invalid_part:image/,
    );

    await assert.rejects(
      transport.sendOutboxPayload(
        {
          bots: [
            {
              platform: "telegram",
              selfId: "1",
              async sendMessage() {
                return ["ignored"];
              },
            },
          ],
        },
        dir,
        {
          type: "text_delivery",
          chatKey: "telegram/1:2",
          text: "   ",
        },
        {
          text(content) {
            return { type: "text", attrs: { content } };
          },
          quote(id) {
            return { type: "quote", attrs: { id } };
          },
        },
      ),
      /chat_outbox_empty_message/,
    );

    await assert.rejects(
      transport.sendOutboxPayload(
        {
          bots: [
            {
              platform: "telegram",
              selfId: "1",
              async sendMessage() {
                return [];
              },
            },
          ],
        },
        dir,
        {
          type: "parts_delivery",
          chatKey: "telegram/1:2",
          parts: [{ type: "text", text: "hello" }],
        },
        {
          text(content) {
            return { type: "text", attrs: { content } };
          },
          quote(id) {
            return { type: "quote", attrs: { id } };
          },
        },
      ),
      /chat_send_message_empty_result/,
    );
  });
});

test("chat transport prefers internal telegram reaction calls for working reactions", async () => {
  const calls = [];
  const app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        internal: {
          async setMessageReaction(payload) {
            calls.push(payload);
          },
        },
      },
    ],
  };

  const first = await transport.rotateWorkingReaction(
    app,
    "telegram/1:2",
    "41",
    0,
    "",
  );
  const second = await transport.rotateWorkingReaction(
    app,
    "telegram/1:2",
    "41",
    1,
    first,
  );
  const cleared = await transport.clearWorkingReaction(
    app,
    "telegram/1:2",
    "41",
    second,
  );

  assert.equal(first, "🤔");
  assert.equal(second, "🔥");
  assert.equal(cleared, true);
  assert.deepEqual(calls, [
    {
      chat_id: "2",
      message_id: 41,
      reaction: [{ type: "emoji", emoji: "🤔" }],
    },
    {
      chat_id: "2",
      message_id: 41,
      reaction: [{ type: "emoji", emoji: "🔥" }],
    },
    {
      chat_id: "2",
      message_id: 41,
      reaction: [],
    },
  ]);
});

test("chat transport sends the fixed Telegram working pair without checking chat reaction compatibility", async () => {
  const calls = [];
  const chats = [];
  const app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        internal: {
          async getChat(payload) {
            chats.push(payload);
            return {
              available_reactions: [
                { type: "emoji", emoji: "❤️" },
                { type: "emoji", emoji: "🌕" },
              ],
            };
          },
          async setMessageReaction(payload) {
            calls.push(payload);
          },
        },
      },
    ],
  };

  const first = await transport.rotateWorkingReaction(
    app,
    "telegram/1:2",
    "41",
    0,
    "",
  );
  const second = await transport.rotateWorkingReaction(
    app,
    "telegram/1:2",
    "41",
    1,
    first,
  );

  assert.equal(first, "🤔");
  assert.equal(second, "🔥");
  assert.deepEqual(chats, []);
  assert.deepEqual(calls, [
    {
      chat_id: "2",
      message_id: 41,
      reaction: [{ type: "emoji", emoji: "🤔" }],
    },
    {
      chat_id: "2",
      message_id: 41,
      reaction: [{ type: "emoji", emoji: "🔥" }],
    },
  ]);
});

test("chat transport uses bot reaction helpers for onebot working reactions", async () => {
  const calls = [];
  const app = {
    bots: [
      {
        platform: "onebot",
        selfId: "2301401877",
        async createReaction(chatId, messageId, emoji) {
          calls.push({ kind: "create", chatId, messageId, emoji });
        },
        async deleteReaction(chatId, messageId, emoji, userId) {
          calls.push({ kind: "delete", chatId, messageId, emoji, userId });
        },
      },
    ],
  };

  const first = await transport.rotateWorkingReaction(
    app,
    "onebot/2301401877:1067390680",
    "52",
    0,
    "",
  );
  const second = await transport.rotateWorkingReaction(
    app,
    "onebot/2301401877:1067390680",
    "52",
    1,
    first,
  );
  const cleared = await transport.clearWorkingReaction(
    app,
    "onebot/2301401877:1067390680",
    "52",
    second,
  );

  assert.equal(first, "🤔");
  assert.equal(second, "🔥");
  assert.equal(cleared, true);
  assert.deepEqual(calls, [
    { kind: "create", chatId: "1067390680", messageId: "52", emoji: "🤔" },
    {
      kind: "delete",
      chatId: "1067390680",
      messageId: "52",
      emoji: "🤔",
      userId: "2301401877",
    },
    { kind: "create", chatId: "1067390680", messageId: "52", emoji: "🔥" },
    {
      kind: "delete",
      chatId: "1067390680",
      messageId: "52",
      emoji: "🔥",
      userId: "2301401877",
    },
  ]);
});

test("chat transport skips onebot working reactions in private chats", async () => {
  const calls = [];
  const app = {
    bots: [
      {
        platform: "onebot",
        selfId: "2301401877",
        async createReaction() {
          calls.push("create");
        },
        async deleteReaction() {
          calls.push("delete");
        },
      },
    ],
  };

  const first = await transport.rotateWorkingReaction(
    app,
    "onebot/2301401877:private:519418441",
    "52",
    0,
    "",
  );
  const cleared = await transport.clearWorkingReaction(
    app,
    "onebot/2301401877:private:519418441",
    "52",
    "🤔",
  );

  assert.equal(first, "");
  assert.equal(cleared, false);
  assert.deepEqual(calls, []);
});
