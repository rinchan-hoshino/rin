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
const { ChatController } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js"))
    .href
);

async function createController(chatKey = "telegram/1:2") {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-controller-abort-"),
  );
  const dataDir = path.join(tempDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const controller = new ChatController({}, dataDir, chatKey, {
    logger: { info() {}, warn() {} },
    h: {
      text(content: string) {
        return { type: "text", attrs: { content } };
      },
      quote(id: string) {
        return { type: "quote", attrs: { id } };
      },
    },
  });
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["m1"];
        },
        async createReaction() {},
        async deleteReaction() {},
        internal: {
          async sendChatAction() {},
        },
      },
    ],
  };
  controller.connect = async () => {};
  return controller;
}

function emitRpcTurnComplete(
  controller: any,
  requestTag: string,
  finalText: string,
) {
  controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "complete",
      requestTag,
      finalText,
      result: {
        messages: [{ type: "text", text: finalText }],
      },
      sessionId: controller.session?.sessionManager?.getSessionId?.(),
      sessionFile: controller.session?.sessionManager?.getSessionFile?.(),
    },
  });
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("chat controller settles an abort while prompt submission is still pending", async () => {
  const controller = await createController();
  const deliveries: string[] = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery?.text || "");
    this.stagedDelivery = null;
  };

  let promptRequestTag = "";
  let abortCalled = false;
  controller.runActiveVoiceAcknowledgement = async (commandName: string) => {
    assert.equal(commandName, "abort");
    return "Active voice abort reply.";
  };
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => "/tmp/pending-submit-chat.jsonl",
      getSessionId: () => "session-pending-submit",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/pending-submit-chat.jsonl",
      sessionId: "session-pending-submit",
    }),
    agent: {
      abort: () => {
        abortCalled = true;
      },
    },
    prompt: async (_text: string, options: { requestTag?: string } = {}) => {
      promptRequestTag = options.requestTag || "";
      await new Promise(() => {});
    },
  };

  const turn = controller.runTurn({
    text: "pending prompt",
    attachments: [],
    replyToMessageId: "m1",
    incomingMessageId: "m1",
  });
  await waitUntil(() => Boolean(promptRequestTag), "prompt did not start");
  await withTimeout(
    controller.runCommand("/abort", "m-abort", "m-abort"),
    100,
    "abort command was delayed by pending prompt submission",
  );
  const result = await withTimeout(
    turn,
    100,
    "aborted turn did not settle while prompt submission was pending",
  );
  assert.equal(abortCalled, true);
  assert.deepEqual(result, {
    aborted: true,
    sessionId: "session-pending-submit",
    sessionFile: "/tmp/pending-submit-chat.jsonl",
  });
  assert.deepEqual(deliveries, ["Active voice abort reply."]);
});

test("chat controller suppresses aborted turn errors and queues later text as a fresh prompt", async () => {
  const controller = await createController();
  const deliveries: string[] = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery?.text || "");
    this.stagedDelivery = null;
  };

  const promptCalls: Array<{ text: string; streamingBehavior: string }> = [];
  let firstRequestTag = "";
  let secondRequestTag = "";
  controller.runActiveVoiceAcknowledgement = async (commandName: string) => {
    assert.equal(commandName, "abort");
    return "Active voice abort reply.";
  };
  let tuiInterruptCalled = false;
  let sessionAbortCalled = false;
  let ensureSessionReadyCalls = 0;
  let blockSessionReadiness = false;
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => "/tmp/fresh-chat.jsonl",
      getSessionId: () => "session-1",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => {
      ensureSessionReadyCalls += 1;
      if (blockSessionReadiness) {
        await new Promise(() => {});
      }
      return {
        sessionFile: "/tmp/fresh-chat.jsonl",
        sessionId: "session-1",
      };
    },
    agent: {
      abort: () => {
        tuiInterruptCalled = true;
      },
    },
    abort: async () => {
      sessionAbortCalled = true;
      await new Promise(() => {});
    },
    prompt: async (
      text: string,
      options: { requestTag?: string; streamingBehavior?: string } = {},
    ) => {
      promptCalls.push({
        text,
        streamingBehavior: options.streamingBehavior || "",
      });
      if (options.streamingBehavior) return;
      if (!firstRequestTag) {
        firstRequestTag = options.requestTag || "";
        await controller.handleClientEvent({
          type: "ui",
          payload: { type: "rpc_frontend_status", phase: "working" },
        });
        return;
      }
      secondRequestTag = options.requestTag || "";
    },
    runCommand: async () => {
      throw new Error("active chat abort should not run as a session command");
    },
  };

  const firstTurn = controller.runTurn({
    text: "first",
    attachments: [],
    replyToMessageId: "m1",
    incomingMessageId: "m1",
  });
  await waitUntil(() => Boolean(firstRequestTag), "first turn did not start");
  assert.equal(controller.canSteerActiveTurn(), true);

  blockSessionReadiness = true;
  await withTimeout(
    controller.runCommand("/abort", "m-abort", "m-abort"),
    100,
    "active chat abort was delayed by session readiness or backend abort",
  );
  blockSessionReadiness = false;
  assert.equal(tuiInterruptCalled, true);
  assert.equal(sessionAbortCalled, false);
  assert.equal(ensureSessionReadyCalls, 1);
  assert.equal(controller.canSteerActiveTurn(), false);
  assert.deepEqual(await firstTurn, {
    aborted: true,
    sessionId: "session-1",
    sessionFile: "/tmp/fresh-chat.jsonl",
  });

  const secondTurn = controller.runTurn(
    {
      text: "second",
      attachments: [],
      replyToMessageId: "m2",
      incomingMessageId: "m2",
    },
    "steer",
  );

  await waitUntil(() => Boolean(secondRequestTag), "second turn did not start");
  assert.deepEqual(promptCalls, [
    { text: "first", streamingBehavior: "" },
    { text: "second", streamingBehavior: "" },
  ]);
  emitRpcTurnComplete(controller, secondRequestTag, "second done");
  assert.equal((await secondTurn).finalText, "second done");
  assert.deepEqual(deliveries, ["Active voice abort reply.", "second done"]);
});
