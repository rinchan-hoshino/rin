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
const evalModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-bridge", "eval.js"))
    .href
);
const runtimeModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-bridge", "runtime.js"))
    .href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-bridge-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createH() {
  return Object.assign((type, attrs) => ({ type, attrs }), {
    text(content) {
      return { type: "text", attrs: { content } };
    },
    quote(id) {
      return { type: "quote", attrs: { id } };
    },
    at(id, options) {
      return { type: "at", attrs: { id, ...(options || {}) } };
    },
    image(src) {
      return { type: "image", attrs: { src } };
    },
    file(src, mimeType, options) {
      return { type: "file", attrs: { src, mimeType, ...(options || {}) } };
    },
  });
}

test("chat bridge eval runs constrained code with bot, internal, helpers, store, and identity", async () => {
  await withTempDir(async (agentDir) => {
    const sends = [];
    const runtime = runtimeModule.createChatBridgeRuntime({
      app: {
        bots: [
          {
            platform: "telegram",
            selfId: "1",
            status: 1,
            async sendMessage(chatId, content) {
              sends.push({ chatId, content });
              return ["m1"];
            },
            async getGuild(chatId) {
              return { id: chatId, name: "Demo Chat" };
            },
            internal: {
              client: { kind: "demo-client" },
              async getChat(payload) {
                return {
                  ok: true,
                  chat: { id: payload.chat_id, title: "Demo Chat" },
                };
              },
              async getChatMember(payload) {
                return { ok: true, payload };
              },
            },
          },
        ],
      },
      agentDir,
      dataDir: path.join(agentDir, "data"),
      currentChatKey: "telegram/1:2",
      h: createH(),
      requestId: "req-1",
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
    });

    const result = await evalModule.executeChatBridgeCode({
      code: `
const room = helpers.useChat("telegram/1:2");
const label: string = "hello 7";
const sent = await room.helpers.send(label);
const chatInfo = await room.internal.getChat({ chat_id: room.chat.chatId });
const member = await room.internal.getChatMember({ chat_id: room.chat.chatId, user_id: 7 });
const saved = room.identity.setTrust({ userId: "7", trust: "TRUSTED", name: "Alice" });
const stored = room.store.getMessage(sent[0])[0];
return {
  currentChatKey: helpers.currentChatKey,
  sent,
  chatInfo,
  member,
  saved,
  storedText: stored.text,
  botStatus: room.bot.status,
  botGetGuildType: typeof room.bot.getGuild,
  botSendMessageType: typeof room.bot.sendMessage,
  internalClientKind: room.internal.client?.kind,
};
`,
      context: runtime,
      timeoutMs: 5_000,
      filename: "chat-bridge-eval.test.ts",
    });

    assert.equal(result.value.botStatus, 1);
    assert.equal(result.value.currentChatKey, "telegram/1:2");
    assert.deepEqual(result.value.sent, ["m1"]);
    assert.equal(result.value.chatInfo.chat.title, "Demo Chat");
    assert.equal(result.value.member.payload.user_id, 7);
    assert.equal(result.value.saved.trust, "TRUSTED");
    assert.equal(result.value.storedText, "hello 7");
    assert.equal(result.value.botGetGuildType, "undefined");
    assert.equal(result.value.botSendMessageType, "function");
    assert.equal(result.value.internalClientKind, "demo-client");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].chatId, "2");

    const stored = messageStore.getChatMessage(agentDir, "telegram/1:2", "m1");
    assert.equal(stored?.text, "hello 7");
    assert.equal(stored?.sessionId, undefined);
    assert.equal(stored?.sessionFile, undefined);
  });
});

test("chat bridge eval reports the actual omitted string length", () => {
  const serialized = evalModule.serializeBridgeValue("x".repeat(4100));
  assert.equal(typeof serialized, "string");
  assert.match(serialized, /… \[116 more chars\]$/);
  assert.equal(serialized.length, 4002);
});

test("chat bridge eval serializes thrown errors", async () => {
  await assert.rejects(
    () =>
      evalModule.executeChatBridgeCode({
        code: 'throw new Error("boom")',
        context: {},
        timeoutMs: 1_000,
      }),
    /boom/,
  );
});
