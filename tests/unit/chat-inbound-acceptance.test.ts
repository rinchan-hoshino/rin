import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { installChatControllerSessionClient } from "../support/chat-controller-session-client.js";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { ChatController } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js"))
    .href
);
const { getChatMessage, saveChatMessage } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);
const { lookupReplySession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-helpers.js"))
    .href
);

async function createController(chatKey = "telegram/1:2") {
  await fs.mkdir("/home/rin/tmp", { recursive: true });
  const tempDir = await fs.mkdtemp(
    path.join("/home/rin/tmp", "rin-chat-acceptance-"),
  );
  const dataDir = path.join(tempDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const controller = new ChatController({}, dataDir, chatKey, {
    logger: { info() {}, warn() {} },
    h: {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      quote(id) {
        return { type: "quote", attrs: { id } };
      },
    },
  });
  installChatControllerSessionClient(controller.constructor);
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["m1"];
        },
        internal: {
          async sendChatAction() {},
        },
      },
    ],
  };
  controller.connect = async () => {};
  return controller;
}

test("chat controller does not accept an inbound prompt before the turn actually starts", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-inbound",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  controller.commitPendingDelivery = async function (clearProcessing = false) {
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  const acceptanceSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "acceptance-chat.jsonl",
  );
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => acceptanceSessionFile,
      getSessionId: () => "session-acceptance",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: acceptanceSessionFile,
      sessionId: "session-acceptance",
    }),
    prompt: async (_message, options = {}) => {
      const beforeStart = getChatMessage(
        controller.agentDir,
        chatKey,
        "m-inbound",
      );
      assert.equal(beforeStart?.acceptedAt, undefined);
      assert.equal(beforeStart?.processedAt, undefined);
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      const afterStart = getChatMessage(
        controller.agentDir,
        chatKey,
        "m-inbound",
      );
      assert.ok(afterStart?.acceptedAt);
      assert.equal(afterStart?.processedAt, undefined);
      assert.equal(afterStart?.sessionFile, "acceptance-chat.jsonl");
      controller.session.messages = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "accepted final" }],
        },
      ];
      controller.session.isStreaming = false;
      controller.handleSessionEvent({ type: "agent_end" });
      controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "rpc_turn_event",
          event: "complete",
          requestTag: options.requestTag,
          finalText: "accepted final",
          result: { messages: [{ type: "text", text: "accepted final" }] },
          sessionId: "session-acceptance",
          sessionFile: acceptanceSessionFile,
        },
      });
    },
    setSessionName: async () => {},
    switchSession: async () => {},
  };

  await controller.runTurn(
    { text: "hello", attachments: [], incomingMessageId: "m-inbound" },
    "prompt",
  );

  const stored = getChatMessage(controller.agentDir, chatKey, "m-inbound");
  assert.ok(stored?.acceptedAt);
  assert.ok(stored?.processedAt);
  assert.equal(stored?.sessionFile, "acceptance-chat.jsonl");
});

test("reply session lookup can continue from an accepted inbound message before final delivery", async () => {
  const controller = await createController("telegram/1:3");
  const chatKey = "telegram/1:3";
  let linkedDuringTurn = null;
  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "3",
    chatType: "private",
    messageId: "m-reply",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "continue here",
  });

  const replySessionFile = path.join(
    controller.agentDir,
    "sessions",
    "reply-session.jsonl",
  );
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => replySessionFile,
      getSessionId: () => "session-reply",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: replySessionFile,
      sessionId: "session-reply",
    }),
    prompt: async (_message, options = {}) => {
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      const linked = lookupReplySession(
        controller.agentDir,
        chatKey,
        "m-reply",
      );
      assert.equal(linked?.sessionFile, replySessionFile);
      assert.equal(linked?.linked?.processedAt, undefined);
      assert.ok(linked?.linked?.acceptedAt);
      linkedDuringTurn = linked;
      controller.session.messages = [
        { role: "user", content: [{ type: "text", text: "continue here" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "continued" }],
        },
      ];
      controller.session.isStreaming = false;
      controller.handleSessionEvent({ type: "agent_end" });
      controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "rpc_turn_event",
          event: "complete",
          requestTag: options.requestTag,
          finalText: "continued",
          result: { messages: [{ type: "text", text: "continued" }] },
          sessionId: "session-reply",
          sessionFile: replySessionFile,
        },
      });
    },
    setSessionName: async () => {},
    switchSession: async () => {},
  };

  await controller.runTurn(
    { text: "continue here", attachments: [], incomingMessageId: "m-reply" },
    "prompt",
  );

  const stored = getChatMessage(controller.agentDir, chatKey, "m-reply");
  assert.equal(linkedDuringTurn?.sessionFile, replySessionFile);
  assert.ok(stored?.acceptedAt);
  assert.ok(stored?.processedAt);
  assert.equal(stored?.sessionFile, "reply-session.jsonl");
});
