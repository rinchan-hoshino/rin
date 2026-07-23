import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
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
  installChatControllerSessionClient(controller.constructor);
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

function deliveryText(delivery: any) {
  return (delivery?.parts || [])
    .map((part: any) =>
      part?.type === "text" || part?.type === "markdown" ? part.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

test("chat controller settles an abort while prompt submission is still pending", async () => {
  const controller = await createController();
  const deliveries: string[] = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  let promptRequestTag = "";
  let abortCalled = false;
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
  assert.deepEqual(deliveries, ["Aborted current operation."]);
});

test("chat controller treats /new as a reset barrier for an active turn", async () => {
  const controller = await createController();
  const deliveries: string[] = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  let sessionFile = "/tmp/reset-old-chat.jsonl";
  let sessionId = "session-old";
  let promptRequestTag = "";
  let abortCalled = false;
  let newSessionCalled = false;
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({ sessionFile, sessionId }),
    agent: {
      abort: () => {
        abortCalled = true;
      },
    },
    newSession: async () => {
      newSessionCalled = true;
      sessionFile = "/tmp/reset-new-chat.jsonl";
      sessionId = "session-new";
      return true;
    },
    prompt: async (_text: string, options: { requestTag?: string } = {}) => {
      promptRequestTag = options.requestTag || "";
      await new Promise(() => {});
    },
  };

  const activeTurn = controller.runTurn({
    text: "active before new",
    attachments: [],
    replyToMessageId: "m1",
    incomingMessageId: "m1",
  });
  activeTurn.catch(() => {});
  await waitUntil(() => Boolean(promptRequestTag), "active turn did not start");

  await withTimeout(
    controller.runCommand("/new", "m-new", "m-new"),
    100,
    "/new command was delayed by the active turn",
  );
  const result = await withTimeout(
    activeTurn,
    100,
    "active turn did not settle after /new reset",
  );

  assert.equal(abortCalled, true);
  assert.equal(newSessionCalled, true);
  assert.deepEqual(result, {
    aborted: true,
    sessionId: "session-new",
    sessionFile: "/tmp/reset-new-chat.jsonl",
  });
  assert.equal(
    (controller as any).currentSessionFile(),
    "/tmp/reset-new-chat.jsonl",
  );
  assert.deepEqual(deliveries, ["Started a new session."]);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.hasActiveTurn(), false);
});

test("chat controller suppresses aborted turn errors and queues later text as a fresh prompt", async () => {
  const controller = await createController();
  const deliveries: string[] = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  const promptCalls: Array<{ text: string; streamingBehavior: string }> = [];
  let firstRequestTag = "";
  let secondRequestTag = "";
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
  assert.equal(controller.hasActiveTurn(), true);

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
  assert.equal(controller.hasActiveTurn(), false);
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
  assert.deepEqual(deliveries, ["Aborted current operation.", "second done"]);
});
