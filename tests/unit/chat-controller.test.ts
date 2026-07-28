import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const { getChatMessage, saveChatMessage } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);
const { lookupReplySession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-helpers.js"))
    .href
);
const { openChatDatabase, readChatState } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);
const {
  claimChatInboxItem,
  enqueueChatInboxItem,
  requeueClaimedChatInboxItem,
} = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const {
  enqueueChatOutboxPayload,
  listChatOutboxHistoryItems,
  listChatOutboxItems,
  readChatOutboxItemById,
  writeChatOutboxItem,
} = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
);
async function readOnlyChatOutboxHistoryItem(agentDir, status) {
  const items = listChatOutboxHistoryItems(agentDir, status);
  assert.equal(items.length, 1);
  return items[0];
}

function rejectedBeforeDispatch(message) {
  const error = new Error(message);
  const delivery = Promise.reject(error);
  delivery.dispatched = Promise.reject(error);
  return delivery;
}

function deliveryText(delivery) {
  return (delivery?.parts || [])
    .map((part) =>
      part?.type === "text" || part?.type === "markdown" ? part.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

function deliveryQuoteId(delivery) {
  return (
    (delivery?.parts || []).find((part) => part?.type === "quote")?.id ||
    undefined
  );
}

function attachTestChatApp(controller) {
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

async function createController(chatKey = "telegram/1:2", deps = {}) {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-controller-"),
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
    ...deps,
  });
  installChatControllerSessionClient(controller.constructor);
  return attachTestChatApp(controller);
}

function setDurableCurrentTurn(controller, messageId = "m-todo-owner") {
  const [platform, address = ""] = controller.chatKey.split("/", 2);
  const separator = address.indexOf(":");
  const selfId = separator >= 0 ? address.slice(0, separator) : "1";
  const channelId = separator >= 0 ? address.slice(separator + 1) : address;
  const item = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId,
    session: {
      platform,
      selfId,
      channelId,
      messageId,
      content: "track todo",
      stripped: { content: "track todo" },
    },
    elements: [{ type: "text", attrs: { content: "track todo" } }],
  }).item;
  const claim = claimChatInboxItem(controller.agentDir, item.itemId);
  assert.ok(claim);
  controller.currentTurn = {
    startedAt: Date.now(),
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: claim.itemId,
      chatKey: claim.chatKey,
      messageId: claim.messageId,
      ownerEpoch: claim.ownerEpoch,
      attempt: claim.attemptCount,
    },
  };
  return claim;
}

function createRecoveredController(previousController) {
  const controller = new ChatController(
    {},
    previousController.dataDir,
    previousController.chatKey,
    {
      logger: { info() {}, warn() {} },
      h: previousController.h,
    },
  );
  installChatControllerSessionClient(controller.constructor);
  return attachTestChatApp(controller);
}

test("chat frontend event failures are visible without terminating the active turn", async () => {
  const warnings = [];
  let connected = false;
  let frontendSubscriber = null;
  const frontendClient = {
    isConnected: () => connected,
    async connect() {
      connected = true;
    },
    subscribe(listener) {
      frontendSubscriber = listener;
      return () => {
        if (frontendSubscriber === listener) frontendSubscriber = null;
      };
    },
    async getState() {
      return {};
    },
  };
  const controller = await createController("telegram/1:2", {
    logger: {
      info() {},
      warn(message) {
        warnings.push(String(message));
      },
    },
    frontendClientFactory: () => frontendClient,
  });
  setDurableCurrentTurn(controller, "observable-turn-message");
  controller.currentTurn.requestTag = "observable-turn";
  const activeTurn = controller.currentTurn;
  let sends = 0;
  controller.app.bots[0].sendMessage = async () => {
    sends += 1;
    return [`event-error-${sends}`];
  };

  await controller.driver.connect();
  controller.driver.handleClientEvent = async () => {
    throw new Error("projection exploded");
  };
  for (let occurrence = 0; occurrence < 2; occurrence += 1) {
    await frontendSubscriber({
      type: "ui",
      payload: { type: "working_visible", visible: true },
    });
  }
  for (let attempt = 0; attempt < 20 && warnings.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (let attempt = 0; attempt < 50 && sends < 1; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(controller.currentTurn, activeTurn);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /stage=client_event event=ui/);
  assert.equal(sends, 1);
});

test("chat controller settles a canonical turn after known partial delivery", async () => {
  const controller = await createController("telegram/1:2");
  let sends = 0;
  controller.app.bots[0].sendMessage = () => {
    sends += 1;
    const error = Object.assign(new Error("chat_delivery_partial:upload"), {
      deliveredMessageIds: ["placeholder-1"],
      partialDelivery: true,
    });
    const delivery = Promise.reject(error);
    delivery.dispatched = Promise.resolve();
    return delivery;
  };

  const outcome = await controller.enqueueAndDrainDelivery(
    {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:2",
      deliveryKind: "final",
      parts: [{ type: "text", text: "final" }],
    },
    {
      deliveryKind: "final",
      postDelivery: {
        markProcessed: {
          chatKey: "telegram/1:2",
          messageId: "incoming-1",
          bindSession: false,
        },
      },
      requireDelivery: true,
      waitUntilDeliverySettled: true,
    },
  );

  assert.deepEqual(outcome, {
    messageIds: ["placeholder-1"],
    accepted: true,
    settled: true,
  });
  assert.equal(sends, 1);
  const failed = await readOnlyChatOutboxHistoryItem(
    controller.agentDir,
    "failed",
  );
  assert.equal(failed.failureKind, "partial");
  assert.ok(failed.postDeliveryAppliedAt);
});

test("detached controller cannot overwrite authoritative chat session binding", async () => {
  const owner = await createController("telegram/1:2");
  const ownerSession = path.join(owner.agentDir, "sessions", "owner.jsonl");
  const detachedSession = path.join(
    owner.agentDir,
    "sessions",
    "detached.jsonl",
  );
  await fs.mkdir(path.dirname(ownerSession), { recursive: true });
  await fs.writeFile(ownerSession, "");
  await fs.writeFile(detachedSession, "");
  owner.updateStoredSessionFile(ownerSession);
  const detachedStatePath = path.join(owner.dataDir, "detached-state.json");
  await fs.writeFile(
    detachedStatePath,
    JSON.stringify({
      chatKey: owner.chatKey,
      sessionFile: detachedSession,
    }),
  );

  const detached = new ChatController({}, owner.dataDir, owner.chatKey, {
    logger: { info() {}, warn() {} },
    h: owner.h,
    affectChatBinding: false,
    statePath: detachedStatePath,
  });
  detached.updateStoredSessionFile(detachedSession);

  const stored = openChatDatabase(owner.agentDir)
    .prepare(`SELECT session_file FROM chat_state WHERE chat_key = ?`)
    .get(owner.chatKey).session_file;
  assert.match(stored, /owner\.jsonl$/);
  assert.match(detached.state.sessionFile, /detached\.jsonl$/);

  const mismatchedStatePath = path.join(
    owner.dataDir,
    "mismatched-detached-state.json",
  );
  await fs.writeFile(
    mismatchedStatePath,
    JSON.stringify({
      chatKey: owner.chatKey,
      sessionFile: ownerSession,
    }),
  );
  const otherChatKey = "telegram/1:3";
  const other = new ChatController({}, owner.dataDir, otherChatKey, {
    logger: { info() {}, warn() {} },
    h: owner.h,
    affectChatBinding: true,
    statePath: mismatchedStatePath,
  });
  assert.equal(other.state.sessionFile, undefined);
  assert.equal(
    openChatDatabase(owner.agentDir)
      .prepare(`SELECT session_file FROM chat_state WHERE chat_key = ?`)
      .get(otherChatKey)?.session_file || null,
    null,
  );
});

test("chat controller tells the frontend driver not to reconnect for an idle command", async () => {
  const controller = await createController();
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "existing-command.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "");
  controller.updateStoredSessionFile(sessionFile);
  let controllerConnectCalls = 0;
  let commandOptions;
  controller.connect = async () => {
    controllerConnectCalls += 1;
    controller.driver.client = { isConnected: () => true };
    controller.driver.frontendState = { sessionFile };
    return true;
  };
  controller.driver.runCommand = async (_commandLine, options) => {
    commandOptions = options;
    return { handled: true, text: "usage done" };
  };
  controller.deliverAssistantReply = async () => {};

  await controller.runCommand("/usage");

  assert.equal(controllerConnectCalls, 1);
  assert.equal(commandOptions?.assumeConnected, true);
  assert.equal(commandOptions?.assumeSessionReady, true);
});

test("chat controller tells the frontend driver not to reconnect for a prompt", async () => {
  const controller = await createController();
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "existing-prompt.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "");
  controller.updateStoredSessionFile(sessionFile);
  let controllerConnectCalls = 0;
  let turnInput;
  controller.connect = async () => {
    controllerConnectCalls += 1;
    controller.driver.client = { isConnected: () => true };
    controller.driver.frontendState = { sessionFile };
    return true;
  };
  controller.driver.runTurn = async (input) => {
    turnInput = input;
    return { finalText: "done" };
  };

  await controller.runTurn({
    text: "hello",
    attachments: [],
    deliverFinal: false,
  });

  assert.equal(controllerConnectCalls, 1);
  assert.equal(turnInput?.assumeConnected, true);
  assert.equal(turnInput?.assumeSessionReady, true);
});

test("chat controller does not assume session readiness after an ineffective restore", async () => {
  const controller = await createController();
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "wanted-command.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "");
  controller.updateStoredSessionFile(sessionFile);
  let commandOptions;
  controller.connect = async () => {
    controller.driver.client = { isConnected: () => true };
    controller.driver.frontendState = {
      sessionFile: path.join(controller.agentDir, "sessions", "other.jsonl"),
    };
    return true;
  };
  controller.driver.runCommand = async (_commandLine, options) => {
    commandOptions = options;
    return { handled: true, text: "usage done" };
  };
  controller.deliverAssistantReply = async () => {};

  await controller.runCommand("/usage");

  assert.equal(commandOptions?.assumeConnected, true);
  assert.equal(commandOptions?.assumeSessionReady, false);
});

test("chat controller never imports legacy session state at runtime and trusts SQLite", async () => {
  const first = await createController();
  await fs.mkdir(path.dirname(first.statePath), { recursive: true });
  await fs.writeFile(
    first.statePath,
    JSON.stringify({
      chatKey: first.chatKey,
      sessionFile: "sessions/legacy-binding.jsonl",
    }),
  );
  openChatDatabase(first.agentDir)
    .prepare(
      `UPDATE chat_state
       SET legacy_session_imported = 0, session_file = NULL
       WHERE chat_key = ?`,
    )
    .run(first.chatKey);

  const imported = createRecoveredController(first);
  assert.equal(imported.state.sessionFile, undefined);
  imported.updateStoredSessionFile("sessions/sqlite-binding.jsonl");
  imported.saveState();
  await fs.writeFile(
    imported.statePath,
    JSON.stringify({
      chatKey: imported.chatKey,
      sessionFile: "sessions/stale-json-binding.jsonl",
    }),
  );

  const recovered = createRecoveredController(imported);
  assert.equal(recovered.state.sessionFile, "sessions/sqlite-binding.jsonl");
  assert.equal(
    openChatDatabase(recovered.agentDir)
      .prepare(`SELECT session_file FROM chat_state WHERE chat_key = ?`)
      .get(recovered.chatKey).session_file,
    "sessions/sqlite-binding.jsonl",
  );
});

test("chat controller keeps the inbox request tag stable across frontend recreation", async () => {
  const first = await createController("discord/1:2");
  const second = createRecoveredController(first);
  const seen = [];
  for (const controller of [first, second]) {
    controller.driver.runTurn = async (input) => {
      seen.push(input.requestTag);
      return { finalText: "done" };
    };
    await controller.runTurn({
      text: "same inbox message",
      attachments: [],
      incomingMessageId: "message-1",
      deliverFinal: false,
    });
  }

  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.match(seen[0], /^chat-inbox-[a-f0-9]{64}$/);
});

test("chat controller keeps the logical inbox request tag stable across owner retries", async () => {
  const controller = await createController("discord/1:2");
  const seen = [];
  controller.driver.runTurn = async (input) => {
    seen.push(input.requestTag);
    return { finalText: "done" };
  };
  for (const [ownerEpoch, attempt] of [
    ["owner-1", 1],
    ["owner-2", 2],
  ]) {
    await controller.runTurn({
      text: "same logical inbox turn",
      attachments: [],
      incomingMessageId: "message-retry",
      outboxTurnFence: {
        agentDir: controller.agentDir,
        turnId: "turn-retry",
        chatKey: controller.chatKey,
        messageId: "message-retry",
        ownerEpoch,
        attempt,
      },
      deliverFinal: false,
    });
  }

  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.match(seen[0], /^chat-inbox-[a-f0-9]{64}$/);
});

test("chat controller preserves an explicit durable turn identity through delivery", async () => {
  const controller = await createController("discord/1:2");
  const driverCalls = [];
  const deliveries = [];
  controller.driver.runTurn = async (input) => {
    driverCalls.push(input);
    return {
      finalText: "scheduled final",
      sessionFile: "/tmp/scheduled-turn.jsonl",
    };
  };
  controller.deliverAssistantReply = async (input) => {
    deliveries.push(input);
  };

  const runTurn = controller.runTurn.bind(controller) as any;
  await runTurn({
    text: "scheduled prompt",
    attachments: [],
    requestTag: "scheduled:task-1:run-1",
    deliveryIdempotencyKey: "scheduled-final:task-1:run-1",
  });

  assert.equal(driverCalls.length, 1);
  assert.equal(driverCalls[0].requestTag, "scheduled:task-1:run-1");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].idempotencyKey, "scheduled-final:task-1:run-1");
});

test("detached non-chat controllers do not synthesize a chat frontend identity", async () => {
  const controller = await createController("cron:cli-123", {
    useChatFrontendIdentity: false,
  });

  assert.equal((controller.driver as any).frontendIdentity.kind, "chat-bridge");
});

function testPollingIndicator(actions = [], reactions = [], selfId = "1") {
  let emoji = "";
  return {
    type: "polling",
    async tick({ chatId, messageId, tick, reactionDue, reactionTick }) {
      actions.push({ chat_id: chatId, action: "typing" });
      if (messageId && reactionDue !== false) {
        emoji = Number(reactionTick ?? tick ?? 0) % 2 ? "🔥" : "🤔";
        reactions.push(["create", chatId, messageId, emoji]);
      }
      return true;
    },
    async end({ chatId, messageId }) {
      if (!messageId || !emoji) return false;
      reactions.push(["delete", chatId, messageId, emoji, selfId]);
      emoji = "";
      return true;
    },
  };
}

function testReactionPollingIndicator(reactions = [], selfId = "1") {
  let emoji = "";
  return {
    type: "polling",
    async tick({ chatId, messageId, tick, reactionDue, reactionTick }) {
      if (!messageId) return false;
      if (reactionDue === false) return true;
      emoji = Number(reactionTick ?? tick ?? 0) % 2 ? "🔥" : "🤔";
      reactions.push(["create", chatId, messageId, emoji]);
      return true;
    },
    async end({ chatId, messageId }) {
      if (!messageId || !emoji) return false;
      reactions.push(["delete", chatId, messageId, emoji, selfId]);
      emoji = "";
      return true;
    },
  };
}

async function waitUntil(condition, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function emitRpcTurnComplete(controller, options, finalText, result) {
  controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: options?.requestTag,
      finalText,
      result: result || {
        messages: [{ type: "text", text: finalText }],
      },
      sessionId: controller.session?.sessionManager?.getSessionId?.(),
      sessionFile: controller.session?.sessionManager?.getSessionFile?.(),
    },
  });
}

test("chat controller fences terminal projections by inbox request tag", async () => {
  const controller = await createController("telegram/1:2");
  controller.currentTurn = {
    incomingMessageId: "m-current",
    replyToMessageId: "m-current",
    requestTag: "request-current",
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: "turn-current",
      chatKey: controller.chatKey,
      messageId: "m-current",
      ownerEpoch: "owner-current",
      attempt: 1,
    },
  };

  const completed = [];
  const failed = [];
  controller.settleProjectedTurnComplete = async (event) => {
    completed.push(event.requestTag);
  };
  controller.settleProjectedTurnError = async (event) => {
    failed.push(event.requestTag);
  };

  await controller.handleFrontendEvent({
    type: "turn_complete",
    requestTag: "request-newer",
    latestAssistantText: "newer final",
  });
  await controller.handleFrontendEvent({
    type: "turn_error",
    requestTag: "request-newer",
    message: "newer error",
  });
  assert.deepEqual(completed, []);
  assert.deepEqual(failed, []);

  await controller.handleFrontendEvent({
    type: "turn_complete",
    requestTag: "request-current",
    latestAssistantText: "current final",
  });
  await controller.handleFrontendEvent({
    type: "turn_error",
    requestTag: "request-current",
    message: "current error",
  });
  assert.deepEqual(completed, ["request-current"]);
  assert.deepEqual(failed, ["request-current"]);
});

test("chat controller logs one received-to-backend startup timing decomposition", async () => {
  const logs = [];
  const controller = await createController("telegram/1:2", {
    logger: {
      info(...args) {
        logs.push(args.join(" "));
      },
      warn() {},
    },
  });
  const now = Date.now();
  controller.currentTurn = {
    incomingMessageId: "m-latency",
    replyToMessageId: "m-latency",
    startedAt: now - 80,
    receivedAtMs: now - 150,
    frontendReadyAt: now - 20,
  };

  await controller.handleFrontendEvent({ type: "turn_accepted" });
  await controller.handleFrontendEvent({ type: "turn_accepted" });

  assert.equal(logs.length, 1);
  assert.match(
    logs[0],
    /chat turn startup .*messageId=m-latency .*receivedToRunMs=70 .*connectMs=60 .*runToAcceptedMs=/,
  );
});

test("chat controller delivers compact collapsed notice without summary text", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (chatId, content, options) => {
    deliveries.push({
      chatId,
      content,
      kind: options?.deliveryKind,
      coalesce: options?.coalesceWithWorkingMessage === true,
    });
    return [`compact-${deliveries.length}`];
  };

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      tokensBefore: 108642,
      result: { summary: "Summary of conversation must not reach chat" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deliveries, [
    {
      chatId: "2",
      content: [
        {
          type: "markdown",
          attrs: {
            content: "Compacted from 108,642 tokens",
          },
        },
      ],
      kind: "interim",
      coalesce: false,
    },
  ]);
});

test("chat controller does not deliver compact summary when token count is unavailable", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (chatId, content) => {
    deliveries.push({ chatId, content });
    return [`compact-${deliveries.length}`];
  };

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      result: { summary: "Summary of conversation must not reach chat" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deliveries, []);
});

test("chat controller terminates the frontend session before disposing", async () => {
  const controller = await createController();
  const calls = [];
  controller.driver.terminateSession = async () => {
    calls.push("terminateSession");
  };
  controller.driver.dispose = () => {
    calls.push("dispose");
  };

  await controller.terminateSession();

  assert.deepEqual(calls, ["terminateSession", "dispose"]);
});

test("chat controller daemon shutdown detach preserves visible turn state", async () => {
  const controller = await createController();
  const calls = [];
  const currentTurn = { id: "active-turn" };
  controller.currentTurn = currentTurn;
  controller.driver.detachForDaemonShutdown = async () => {
    calls.push("detachForDaemonShutdown");
  };
  controller.clearWorkingReaction = async () => {
    calls.push("clearWorkingReaction");
  };
  controller.clearCompactionWorkingReaction = async () => {
    calls.push("clearCompactionWorkingReaction");
  };

  await controller.detachForDaemonShutdown();

  assert.deepEqual(calls, ["detachForDaemonShutdown"]);
  assert.equal(controller.currentTurn, currentTurn);
});

test("detached chat controllers persist their session file for later termination", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-controller-"),
  );
  try {
    const dataDir = path.join(tempDir, "data");
    const statePath = path.join(tempDir, "detached", "state.json");
    await fs.mkdir(dataDir, { recursive: true });
    const controller = new ChatController({}, dataDir, "cron:task", {
      logger: { info() {}, warn() {} },
      h: {
        text(content) {
          return { type: "text", attrs: { content } };
        },
      },
      affectChatBinding: false,
      statePath,
    });

    controller.updateStoredSessionFile(
      path.join(tempDir, "sessions", "managed", "task", "cron_task.jsonl"),
    );
    controller.saveState();

    const stored = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(stored.sessionFile, "managed/task/cron_task.jsonl");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("chat controller bootstraps a fresh session before the first command", async () => {
  const controller = await createController();
  const calls = [];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  let currentSessionFile;
  controller.session = {
    sessionManager: {
      getSessionFile: () => currentSessionFile,
      getSessionId: () => "",
      getSessionName: () => "",
    },
    newSession: async (options = {}) => {
      calls.push(`newSession:${options.managedSessionLeaf}`);
      currentSessionFile = path.join(
        controller.agentDir,
        "sessions",
        "managed",
        options.managedSessionLeaf,
        "created-command.jsonl",
      );
      return true;
    },
    switchSession: async (sessionFile) => {
      calls.push(
        `switchSession:${path.relative(controller.agentDir, sessionFile)}`,
      );
      currentSessionFile = sessionFile;
    },
    ensureSessionReady: async () => {
      calls.push("ensureSessionReady");
      return {
        sessionFile: currentSessionFile,
        sessionId: "session-1",
      };
    },
    runCommand: async (commandLine) => {
      calls.push(`runCommand:${commandLine}`);
      return { handled: true, text: "Session stats" };
    },
  };

  await controller.runCommand("/session");

  assert.equal(calls[0], "newSession:chat");
  assert.deepEqual(calls.slice(1), [
    "ensureSessionReady",
    "runCommand:/session",
  ]);
  assert.deepEqual(deliveries, ["Session stats"]);
  assert.match(controller.state.sessionFile || "", /^managed\/chat\//);
});

test("chat controller allocates fresh prompt sessions under managed chat", async () => {
  const controller = await createController();
  const calls = [];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  let currentSessionFile;
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => currentSessionFile,
      getSessionId: () => "session-prompt",
      getSessionName: () => controller.chatKey,
    },
    newSession: async (options = {}) => {
      calls.push(`newSession:${options.managedSessionLeaf}`);
      currentSessionFile = path.join(
        controller.agentDir,
        "sessions",
        "managed",
        options.managedSessionLeaf,
        "created-prompt.jsonl",
      );
      return true;
    },
    switchSession: async (sessionFile) => {
      calls.push(
        `switchSession:${path.relative(controller.agentDir, sessionFile)}`,
      );
      currentSessionFile = sessionFile;
    },
    ensureSessionReady: async () => {
      calls.push("ensureSessionReady");
      return {
        sessionFile: currentSessionFile,
        sessionId: "session-prompt",
      };
    },
    prompt: async (_text, options = {}) => {
      calls.push("prompt");
      emitRpcTurnComplete(controller, options, "managed prompt final");
    },
  };

  const result = await controller.runTurn({ text: "hello", attachments: [] });

  assert.equal(calls[0], "newSession:chat");
  assert.deepEqual(calls.slice(1), ["ensureSessionReady", "prompt"]);
  assert.equal(result.finalText, "managed prompt final");
  assert.deepEqual(deliveries, ["managed prompt final"]);
  assert.match(controller.state.sessionFile || "", /^managed\/chat\//);
});

test("chat controller forwards startup session names to the frontend turn driver", async () => {
  const controller = await createController();
  let captured: any = undefined;
  controller.driver.runTurn = async (input: any) => {
    captured = input;
    return {
      finalText: "named final",
      result: { messages: [{ type: "text", text: "named final" }] },
      sessionId: "named-session",
      sessionFile: "/tmp/named-session.jsonl",
    };
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    sessionName: "daily audit",
    deliverFinal: false,
  });

  assert.equal(captured.sessionName, "daily audit");
  assert.equal(result.finalText, "named final");
});

test("chat controller delivers Pi-native overflow recovery finals", async () => {
  const controller = await createController();
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  const currentSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "overflow.jsonl",
  );
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => currentSessionFile,
      getSessionId: () => "session-overflow",
      getSessionName: () => controller.chatKey,
    },
    newSession: async () => true,
    ensureSessionReady: async () => ({
      sessionFile: currentSessionFile,
      sessionId: "session-overflow",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleClientEvent({
        type: "ui",
        payload: { type: "agent_start" },
      });
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "context_length_exceeded",
            content: [],
          },
        },
      });
      await controller.handleClientEvent({
        type: "ui",
        payload: { type: "agent_end" },
      });
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "compaction_end",
          reason: "overflow",
          willRetry: true,
          aborted: false,
        },
      });
      await controller.handleClientEvent({
        type: "ui",
        payload: { type: "agent_start" },
      });
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "continued answer" }],
          },
        },
      });
      await controller.handleClientEvent({
        type: "ui",
        payload: { type: "agent_end" },
      });
      emitRpcTurnComplete(controller, options, "continued answer");
    },
  };

  const result = await controller.runTurn({ text: "hello", attachments: [] });

  assert.equal(result.finalText, "continued answer");
  assert.deepEqual(deliveries, ["continued answer"]);
});

test("chat controller resets chat prompt sessions through the session settings reload path", async () => {
  const controller = await createController();
  const calls = [];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  const restoredSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "stale.jsonl",
  );
  await fs.mkdir(path.dirname(restoredSessionFile), { recursive: true });
  await fs.writeFile(restoredSessionFile, "");
  controller.state.sessionFile = "managed/chat/stale.jsonl";

  let currentSessionFile = restoredSessionFile;
  let currentModel = "openai-codex/old";
  controller.session = {
    isStreaming: false,
    messages: [],
    thinkingLevel: "low",
    resetModelOptionsFromSettings: async () => {
      currentModel = "openai-codex/gpt-5.5";
      controller.session.thinkingLevel = "high";
      calls.push("resetModelOptionsFromSettings");
    },
    sessionManager: {
      getSessionFile: () => currentSessionFile,
      getSessionId: () => "session-settings",
      getSessionName: () => controller.chatKey,
    },
    switchSession: async (sessionFile) => {
      currentSessionFile = sessionFile;
      calls.push(
        `switchSession:${path.relative(controller.agentDir, sessionFile)}`,
      );
    },
    ensureSessionReady: async () => {
      calls.push("ensureSessionReady");
      return {
        sessionFile: currentSessionFile,
        sessionId: "session-settings",
      };
    },
    prompt: async (_text, options = {}) => {
      calls.push(`prompt:${currentModel}:${controller.session.thinkingLevel}`);
      emitRpcTurnComplete(controller, options, "settings prompt final");
    },
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
  });

  assert.deepEqual(calls, [
    "switchSession:sessions/managed/chat/stale.jsonl",
    "ensureSessionReady",
    "resetModelOptionsFromSettings",
    "prompt:openai-codex/gpt-5.5:high",
  ]);
  assert.equal(result.finalText, "settings prompt final");
  assert.deepEqual(deliveries, ["settings prompt final"]);
});

test("chat controller applies turn model options after settings reload", async () => {
  const controller = await createController();
  const calls = [];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  let currentModel = "openai-codex/default";
  controller.session = {
    isStreaming: false,
    messages: [],
    thinkingLevel: "medium",
    modelRegistry: {
      getAvailable: async () => [{ provider: "openai-codex", id: "gpt-5.5" }],
    },
    setModel: async (model) => {
      currentModel = `${model.provider}/${model.id}`;
      calls.push(`setModel:${currentModel}`);
    },
    resetModelOptionsFromSettings: async () => {
      currentModel = "openai-codex/default";
      controller.session.thinkingLevel = "high";
      calls.push("resetModelOptionsFromSettings");
    },
    sessionManager: {
      getSessionFile: () => "",
      getSessionId: () => "session-model-options",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => {
      calls.push("ensureSessionReady");
      return { sessionId: "session-model-options" };
    },
    prompt: async (_text, options = {}) => {
      calls.push(`prompt:${currentModel}:${controller.session.thinkingLevel}`);
      emitRpcTurnComplete(controller, options, "model options final");
    },
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    model: "openai-codex/gpt-5.5",
    thinkingLevel: "low",
  });

  assert.deepEqual(calls, [
    "ensureSessionReady",
    "resetModelOptionsFromSettings",
    "setModel:openai-codex/gpt-5.5",
    "prompt:openai-codex/gpt-5.5:low",
  ]);
  assert.equal(result.finalText, "model options final");
  assert.deepEqual(deliveries, ["model options final"]);
});

test("chat controller does not bind a transient default session before managed prompt creation", async () => {
  const controller = await createController();
  delete controller.connect;
  controller.commitPendingDelivery = async function () {
    this.stagedDelivery = null;
  };

  const defaultSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "default-before-managed.jsonl",
  );
  const managedSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "created-after-connect.jsonl",
  );
  let currentSessionFile = defaultSessionFile;
  const observedStateAtPrompt = [];
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => currentSessionFile,
      getSessionId: () => "session-managed",
      getSessionName: () => controller.chatKey,
    },
    newSession: async () => {
      currentSessionFile = managedSessionFile;
      return true;
    },
    ensureSessionReady: async () => ({
      sessionFile: currentSessionFile,
      sessionId: "session-managed",
    }),
    prompt: async (_text, options = {}) => {
      observedStateAtPrompt.push(controller.state.sessionFile);
      emitRpcTurnComplete(controller, options, "managed prompt final");
    },
    switchSession: async (sessionFile) => {
      currentSessionFile = sessionFile;
    },
  };

  await controller.runTurn({ text: "hello", attachments: [] });

  assert.deepEqual(observedStateAtPrompt, [undefined]);
  assert.equal(
    controller.state.sessionFile,
    "managed/chat/created-after-connect.jsonl",
  );
});

test("chat controller skips recovery bootstrap and uses configured copy for /new", async () => {
  const controller = await createController();
  const calls = [];
  const prompts = [];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  let currentSessionFile;
  controller.connect = async function (options = {}) {
    calls.push(`connect:${String(options.restoreSession)}`);
    this.session = {
      isStreaming: false,
      sessionManager: {
        getSessionFile: () => currentSessionFile,
        getSessionId: () => "session-2",
        getSessionName: () => this.chatKey,
      },
      newSession: async (options = {}) => {
        calls.push(`newSession:${options.managedSessionLeaf}`);
        currentSessionFile = path.join(
          controller.agentDir,
          "sessions",
          "managed",
          "chat",
          "created-new.jsonl",
        );
        return true;
      },
      switchSession: async (sessionFile) => {
        calls.push(
          `switchSession:${path.relative(controller.agentDir, sessionFile)}`,
        );
        currentSessionFile = sessionFile;
      },
      ensureSessionReady: async () => {
        calls.push("ensureSessionReady");
        return {
          sessionFile: currentSessionFile,
          sessionId: "session-2",
        };
      },
      prompt: async (text, options = {}) => {
        prompts.push(text);
        emitRpcTurnComplete(controller, options, "unexpected temp reply");
      },
    };
  };

  await controller.runCommand("/new");

  assert.deepEqual(calls, ["connect:false", "newSession:chat"]);
  assert.deepEqual(prompts, []);
  assert.deepEqual(deliveries, ["Started a new session."]);
  assert.match(controller.state.sessionFile || "", /^managed\/chat\//);
});

test("chat controller /new clears the old binding when the logical session has no file yet", async () => {
  const controller = await createController();
  const oldSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "old-chat.jsonl",
  );
  await fs.mkdir(path.dirname(oldSessionFile), { recursive: true });
  await fs.writeFile(oldSessionFile, "", "utf8");
  controller.state.sessionFile = oldSessionFile;
  readChatState(controller.agentDir, controller.chatKey);
  openChatDatabase(controller.agentDir)
    .prepare("UPDATE chat_state SET session_file = ? WHERE chat_key = ?")
    .run(oldSessionFile, controller.chatKey);
  controller.commitPendingDelivery = async function () {
    this.stagedDelivery = null;
  };
  controller.connect = async () => true;
  let liveSessionFile = "";
  controller.driver.runCommand = async () => ({
    handled: true,
    text: "Started a new session.",
    sessionId: "session-empty-new",
  });
  controller.driver.currentSessionId = () => "session-empty-new";
  controller.driver.currentSessionFile = () => liveSessionFile;

  await controller.runCommand("/new", "m-new", "m-new");

  assert.equal(controller.state.sessionFile, undefined);
  assert.equal(
    readChatState(controller.agentDir, controller.chatKey).sessionFile,
    undefined,
  );
  assert.equal(
    readChatState(controller.agentDir, controller.chatKey).currentGeneration,
    1,
  );

  let submittedTurn: any;
  const promptSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "created-on-first-prompt.jsonl",
  );
  controller.driver.runTurn = async (input: any) => {
    submittedTurn = input;
    liveSessionFile = promptSessionFile;
    return { finalText: "fresh", sessionFile: promptSessionFile };
  };

  await controller.runTurn({
    text: "hello",
    attachments: [],
    deliverFinal: false,
  });

  assert.equal(submittedTurn.restoreSessionFile, "");
  assert.equal(submittedTurn.managedSessionLeaf, "chat");
  assert.equal(
    controller.state.sessionFile,
    "managed/chat/created-on-first-prompt.jsonl",
  );
});

test("chat controller does not send working notices before deterministic non-compact command acknowledgements", async () => {
  for (const [command, expectedText] of [
    ["/new", "Started a new session."],
    ["/abort", "Aborted current operation."],
    ["/reload", "Reloaded extensions, prompts, skills, and themes."],
  ]) {
    const controller = await createController();
    const actions = [];
    const reactions = [];
    controller.app.bots[0].workingIndicators = [
      testPollingIndicator(actions, reactions),
    ];
    const deliveries = [];
    controller.commitPendingDelivery = async function () {
      deliveries.push(deliveryText(this.stagedDelivery));
      this.stagedDelivery = null;
    };

    let currentSessionFile = path.join(
      controller.agentDir,
      "sessions",
      `${command.slice(1)}-without-working.jsonl`,
    );
    controller.session = {
      isStreaming: false,
      sessionManager: {
        getSessionFile: () => currentSessionFile,
        getSessionId: () => `session-${command.slice(1)}`,
        getSessionName: () => controller.chatKey,
      },
      newSession: async (options = {}) => {
        currentSessionFile = path.join(
          controller.agentDir,
          "sessions",
          "managed",
          options.managedSessionLeaf,
          "created-without-working.jsonl",
        );
        return true;
      },
      ensureSessionReady: async () => ({
        sessionFile: currentSessionFile,
        sessionId: `session-${command.slice(1)}`,
      }),
      runCommand: async () => ({
        handled: true,
        text: "backend text should be localized",
        sessionFile: currentSessionFile,
      }),
      compact: async () => ({
        handled: true,
        text: "backend text should be localized",
        sessionFile: currentSessionFile,
      }),
      switchSession: async () => {},
    };

    await controller.runCommand(
      command,
      `m-${command.slice(1)}`,
      `m-${command.slice(1)}`,
    );

    assert.deepEqual(actions, []);
    assert.deepEqual(reactions, []);
    assert.deepEqual(deliveries, [expectedText]);
  }
});

test("chat controller can deliver image-only builtin command parts", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery);
    this.stagedDelivery = null;
  };

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "usage-command-parts.jsonl",
  );
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-usage",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-usage",
    }),
    runCommand: async () => ({
      handled: true,
      text: "",
      parts: [{ type: "image", path: "/tmp/usage.png", mimeType: "image/png" }],
      sessionFile,
    }),
    switchSession: async () => {},
  };

  await controller.runCommand("/usage", "m-usage", "m-usage");

  assert.deepEqual(deliveries[0].parts, [
    { type: "quote", id: "m-usage" },
    { type: "image", path: "/tmp/usage.png", mimeType: "image/png" },
  ]);
});

test("chat controller starts command reactions from backend working visibility", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  controller.app.bots[0].workingIndicators = [
    testPollingIndicator(actions, reactions),
  ];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "compact-command-working-reaction.jsonl",
  );
  let commandStarted = () => {};
  let releaseCommand = () => {};
  const commandStartedPromise = new Promise((resolve) => {
    commandStarted = resolve;
  });
  const releaseCommandPromise = new Promise((resolve) => {
    releaseCommand = resolve;
  });
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-compact",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-compact",
    }),
    compact: async () => {
      commandStarted();
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "extension_ui_request",
          method: "setWorkingVisible",
          visible: true,
        },
      });
      await releaseCommandPromise;
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "extension_ui_request",
          method: "setWorkingVisible",
          visible: false,
        },
      });
      return {
        handled: true,
        text: "backend text should be localized",
        sessionFile,
      };
    },
    switchSession: async () => {},
  };

  const command = controller.runCommand("/compact", "m-compact", "m-compact");
  await commandStartedPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.currentTurn?.incomingMessageId, "m-compact");
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [["create", "2", "m-compact", "🤔"]]);

  releaseCommand();
  await command;

  assert.equal(controller.currentTurn, null);

  assert.deepEqual(reactions, [
    ["create", "2", "m-compact", "🤔"],
    ["delete", "2", "m-compact", "🤔", "1"],
  ]);
  assert.deepEqual(deliveries, []);
});

test("chat controller command failure atomically terminalizes its durable inbox turn", async () => {
  const controller = await createController("telegram/1:2");
  const item = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "m-command-failure-terminal",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "m-command-failure-terminal",
      content: "/compact",
      stripped: { content: "/compact" },
    },
    elements: [{ type: "text", attrs: { content: "/compact" } }],
  }).item;
  const claim = claimChatInboxItem(controller.agentDir, item.itemId);
  assert.ok(claim);
  const fence = {
    agentDir: controller.agentDir,
    turnId: claim.itemId,
    chatKey: claim.chatKey,
    messageId: claim.messageId,
    ownerEpoch: claim.ownerEpoch,
    attempt: claim.attemptCount,
  };
  controller.driver.runCommand = async () => {
    throw new Error("compaction exploded");
  };

  await assert.rejects(
    controller.runCommand(
      "/compact",
      claim.messageId,
      claim.messageId,
      "",
      undefined,
      fence,
    ),
    /compaction exploded/,
  );

  const turn = openChatDatabase(controller.agentDir)
    .prepare("SELECT state, terminal_kind FROM turns WHERE turn_id = ?")
    .get(claim.itemId);
  assert.deepEqual(turn, {
    state: "terminal",
    terminal_kind: "outbox_error",
  });
  const outbox = listChatOutboxHistoryItems(controller.agentDir, "delivered");
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].deliveryKind, "error");
});

test("chat controller sends compaction notices as interim progress and reacts on that notice", async () => {
  const controller = await createController("telegram/1:2");
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "compaction-notice-chat.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "", "utf8");
  controller.driver.frontendState = {
    sessionFile,
    sessionId: "session-compaction-notice",
  };
  const actions = [];
  const reactions = [];
  const deliveries = [];
  let nextMessageId = 1;
  controller.app.bots[0].workingIndicators = [
    testPollingIndicator(actions, reactions),
  ];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join(" ");
    deliveries.push({
      text,
      kind: options?.deliveryKind,
      coalesce: Boolean(options?.coalesceWithWorkingMessage),
    });
    return [`m-out-${nextMessageId++}`];
  };

  await controller.handleClientEvent({
    type: "ui",
    payload: { type: "compaction_start", reason: "threshold" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.currentTurn, null);
  assert.equal(controller.compactionTurn?.incomingMessageId, "m-out-1");
  assert.deepEqual(deliveries, [
    { text: "Compacting...", kind: "interim", coalesce: true },
  ]);
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [["create", "2", "m-out-1", "🤔"]]);

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      tokensBefore: 108642,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.currentTurn, null);
  assert.equal(controller.compactionTurn, null);
  assert.deepEqual(reactions, [
    ["create", "2", "m-out-1", "🤔"],
    ["delete", "2", "m-out-1", "🤔", "1"],
  ]);
  assert.deepEqual(deliveries, [
    { text: "Compacting...", kind: "interim", coalesce: true },
    {
      text: "Compacted from 108,642 tokens",
      kind: "interim",
      coalesce: true,
    },
  ]);
  assert.equal(
    getChatMessage(controller.agentDir, "telegram/1:2", "m-out-1")?.sessionFile,
    "compaction-notice-chat.jsonl",
  );
  assert.equal(
    lookupReplySession(controller.agentDir, "telegram/1:2", "m-out-1")
      ?.sessionFile,
    sessionFile,
  );
  assert.equal(
    lookupReplySession(controller.agentDir, "telegram/1:2", "m-out-2")
      ?.sessionFile,
    sessionFile,
  );
});

test("chat controller coalesces automatic compaction completion into the active chat turn", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  const deliveries = [];
  let nextMessageId = 1;
  controller.app.bots[0].workingIndicators = [
    testPollingIndicator(actions, reactions),
  ];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join(" ");
    deliveries.push({
      text,
      quote: nodes.find((node) => node?.type === "quote")?.attrs?.id,
      kind: options?.deliveryKind,
      coalesce: Boolean(options?.coalesceWithWorkingMessage),
    });
    return [`m-out-${nextMessageId++}`];
  };
  controller.driver.frontendPhase = "working";
  controller.driver.frontendState = { isStreaming: true, turnActive: true };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-owner",
    replyToMessageId: "m-owner",
    workingNoticeSent: false,
  };

  await controller.handleClientEvent({
    type: "ui",
    payload: { type: "compaction_start", reason: "threshold" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.currentTurn?.incomingMessageId, "m-owner");
  assert.equal(controller.compactionTurn?.incomingMessageId, "m-out-1");
  assert.deepEqual(reactions, [["create", "2", "m-out-1", "🤔"]]);

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      tokensBefore: 108642,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.currentTurn?.incomingMessageId, "m-owner");
  assert.equal(controller.compactionTurn, null);
  assert.deepEqual(reactions, [
    ["create", "2", "m-out-1", "🤔"],
    ["delete", "2", "m-out-1", "🤔", "1"],
  ]);
  assert.deepEqual(deliveries, [
    {
      text: "Compacting...",
      quote: "m-owner",
      kind: "interim",
      coalesce: true,
    },
    {
      text: "Compacted from 108,642 tokens",
      quote: "m-owner",
      kind: "interim",
      coalesce: true,
    },
  ]);
});

test("chat controller keeps editable compaction in interim content", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].getWorkingIndicators = () => [
    {
      type: "polling",
      presentation: "editable-message",
      async tick() {
        return true;
      },
      async end() {
        return false;
      },
    },
  ];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    deliveries.push({
      text: nodes.map((node) => node?.attrs?.content || "").join(""),
      kind: options?.deliveryKind,
      coalesce: options?.coalesceWithWorkingMessage === true,
    });
    return [`m-out-${deliveries.length}`];
  };
  controller.driver.frontendPhase = "working";
  controller.driver.frontendState = { isStreaming: true, turnActive: true };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-owner",
    replyToMessageId: "m-owner",
    workingNoticeSent: true,
  };
  controller.awaitingTurnSettle = true;

  await controller.handleClientEvent({
    type: "ui",
    payload: { type: "compaction_start", reason: "threshold" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deliveries, [
    { text: "Compacting...", kind: "interim", coalesce: true },
  ]);

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      tokensBefore: 108642,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deliveries, [
    { text: "Compacting...", kind: "interim", coalesce: true },
    {
      text: "Compacted from 108,642 tokens",
      kind: "interim",
      coalesce: true,
    },
  ]);
});

test("chat controller delivers non-deferred passive notices during active turns", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join(" ");
    deliveries.push({ text, kind: options?.deliveryKind });
    return [`m-out-${deliveries.length}`];
  };
  controller.driver.frontendPhase = "working";
  controller.driver.frontendState = { isStreaming: true, turnActive: true };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-owner",
    replyToMessageId: "m-owner",
    workingNoticeSent: false,
  };

  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "- [x] finished",
      level: "info",
      deferDuringTurn: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.currentTurn?.incomingMessageId, "m-owner");
  assert.deepEqual(controller.pendingPassiveNotices, []);
  assert.deepEqual(deliveries, [
    { text: "- [x] finished", kind: "passive_notice" },
  ]);
});

test("chat controller delivers immediate passive errors as non-terminal errors", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  const claim = setDurableCurrentTurn(controller);
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join(" ");
    deliveries.push({ text, kind: options?.deliveryKind });
    return [`m-out-${deliveries.length}`];
  };
  controller.driver.frontendPhase = "working";
  controller.driver.frontendState = { isStreaming: true, turnActive: true };

  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "Compaction failed: summary backend unavailable",
      level: "error",
      deferDuringTurn: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deliveries, [
    {
      text: "rin error: Compaction failed: summary backend unavailable",
      kind: "error",
    },
  ]);
  assert.deepEqual(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT state, terminal_kind FROM turns WHERE turn_id = ?`)
      .get(claim.itemId),
    { state: "running", terminal_kind: null },
  );
});

test("chat controller renders todo notices as markdown for markdown chats", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  setDurableCurrentTurn(controller);
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    deliveries.push({ nodes, kind: options?.deliveryKind });
    return [`m-out-${deliveries.length}`];
  };

  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "[ ] Keep working\n[x] Ship renderer",
      noticeKind: "todo",
      deferDuringTurn: false,
      todoItems: [
        { id: 1, text: "Keep working", done: false },
        { id: 2, text: "Ship renderer", done: true },
      ],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].kind, "passive_notice");
  assert.deepEqual(deliveries[0].nodes, [
    {
      type: "markdown",
      attrs: {
        content: "⬜ Keep working\n✅ ~~Ship renderer~~",
      },
    },
  ]);
});

test("chat controller ignores todo replay without a durable active delivery target", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.latestTodoNoticeText = "⬜ Current durable state";
  controller.todoFallbackOwner = "current-owner";
  controller.todoFallbackHash = "current-hash";
  controller.todoFallbackRevision = 4;
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    deliveries.push({ nodes, kind: options?.deliveryKind });
    return [`m-out-${deliveries.length}`];
  };

  const replay = {
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "[ ] Must not replay",
      noticeKind: "todo",
      deferDuringTurn: false,
      sourceEventId: "historical-todo-call",
      todoItems: [{ id: 1, text: "Must not replay", done: false }],
    },
  };

  await controller.handleClientEvent(replay);
  controller.currentTurn = { startedAt: Date.now() };
  await controller.handleClientEvent(replay);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deliveries, []);
  assert.equal(controller.latestTodoNoticeText, "⬜ Current durable state");
  assert.equal(controller.todoFallbackOwner, "current-owner");
  assert.equal(controller.todoFallbackHash, "current-hash");
  assert.equal(controller.todoFallbackRevision, 4);
  assert.equal(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT COUNT(*) AS count FROM outbox`)
      .get().count,
    0,
  );
});

test("chat controller rejects todo after its durable turn is superseded", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  const claim = setDurableCurrentTurn(controller, "m-stale-todo");
  controller.latestTodoNoticeText = "⬜ Current durable state";
  controller.todoFallbackOwner = "current-owner";
  controller.todoFallbackHash = "current-hash";
  controller.todoFallbackRevision = 7;
  controller.app.bots[0].sendMessage = async (...args) => {
    deliveries.push(args);
    return ["unexpected"];
  };
  openChatDatabase(controller.agentDir)
    .prepare(
      `UPDATE turns SET state = 'superseded', terminal_kind = 'coalesced_steer',
         owner_epoch = NULL, lease_until = NULL WHERE turn_id = ?`,
    )
    .run(claim.itemId);

  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "Error: stale todo\n[ ] Must not replay",
      noticeKind: "todo",
      deferDuringTurn: false,
      todoItems: [{ id: 1, text: "Must not replay", done: false }],
      todoError: "stale todo",
    },
  });
  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "",
      noticeKind: "todo",
      deferDuringTurn: false,
      todoItems: [],
    },
  });
  await controller.todoDeliveryQueue;

  assert.deepEqual(deliveries, []);
  assert.equal(controller.latestTodoNoticeText, "⬜ Current durable state");
  assert.equal(controller.todoFallbackOwner, "current-owner");
  assert.equal(controller.todoFallbackHash, "current-hash");
  assert.equal(controller.todoFallbackRevision, 7);
  assert.equal(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT COUNT(*) AS count FROM outbox`)
      .get().count,
    0,
  );
});

test("chat controller does not commit Todo state after delivery ownership changes", async () => {
  const controller = await createController("telegram/1:2");
  const oldClaim = setDurableCurrentTurn(controller, "m-old-todo-owner");
  controller.latestTodoNoticeText = "⬜ Current state";
  controller.todoFallbackOwner = "current-owner";
  controller.todoFallbackHash = "current-hash";
  controller.todoFallbackRevision = 9;
  let resolveDeliveryStarted = () => {};
  const deliveryStarted = new Promise((resolve) => {
    resolveDeliveryStarted = resolve;
  });
  let releaseDelivery = () => {};
  const deliveryMayFinish = new Promise((resolve) => {
    releaseDelivery = resolve;
  });
  let sends = 0;
  controller.app.bots[0].sendMessage = async () => {
    sends += 1;
    resolveDeliveryStarted();
    await deliveryMayFinish;
    return ["m-old-todo-progress"];
  };

  const oldDelivery = controller.handleFrontendEvent({
    type: "passive_notice",
    text: "[ ] Old owner state",
    noticeKind: "todo",
    deferDuringTurn: false,
    todoItems: [{ id: 1, text: "Old owner state", done: false }],
  });
  await deliveryStarted;
  const queuedOldDelivery = controller.handleFrontendEvent({
    type: "passive_notice",
    text: "[ ] Queued old owner state",
    noticeKind: "todo",
    deferDuringTurn: false,
    todoItems: [{ id: 1, text: "Queued old owner state", done: false }],
  });
  const newClaim = setDurableCurrentTurn(controller, "m-new-todo-owner");
  releaseDelivery();
  await Promise.all([oldDelivery, queuedOldDelivery]);

  assert.notEqual(newClaim.itemId, oldClaim.itemId);
  assert.equal(controller.latestTodoNoticeText, "⬜ Current state");
  assert.equal(controller.todoFallbackOwner, "current-owner");
  assert.equal(controller.todoFallbackHash, "current-hash");
  assert.equal(controller.todoFallbackRevision, 9);
  assert.equal(sends, 1);
  assert.equal(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT COUNT(*) AS count FROM outbox WHERE turn_id = ?`)
      .get(oldClaim.itemId).count,
    1,
  );
  assert.equal(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT COUNT(*) AS count FROM outbox WHERE turn_id = ?`)
      .get(newClaim.itemId).count,
    0,
  );
});

test("chat controller does not mutate Todo state when delivery is unavailable", async () => {
  const controller = await createController("telegram/1:2");
  setDurableCurrentTurn(controller, "m-unavailable-todo");
  controller.app.bots = [];
  controller.latestTodoNoticeText = "⬜ Current state";
  controller.todoFallbackOwner = "current-owner";
  controller.todoFallbackHash = "current-hash";
  controller.todoFallbackRevision = 5;

  await controller.handleFrontendEvent({
    type: "passive_notice",
    text: "Error: unavailable",
    noticeKind: "todo",
    deferDuringTurn: false,
    todoItems: [],
    todoError: "unavailable",
  });

  assert.equal(controller.latestTodoNoticeText, "⬜ Current state");
  assert.equal(controller.todoFallbackOwner, "current-owner");
  assert.equal(controller.todoFallbackHash, "current-hash");
  assert.equal(controller.todoFallbackRevision, 5);
  assert.equal(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT COUNT(*) AS count FROM outbox`)
      .get().count,
    0,
  );
});

test("chat controller deduplicates exact todo replay while preserving A to B to A", async () => {
  const controller = await createController("telegram/1:2");
  const inbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "m-todo-dedup",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "m-todo-dedup",
      content: "track this",
      stripped: { content: "track this" },
    },
    elements: [{ type: "text", attrs: { content: "track this" } }],
  }).item;
  const claim = claimChatInboxItem(controller.agentDir, inbound.itemId);
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: claim.messageId,
    replyToMessageId: claim.messageId,
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: claim.itemId,
      chatKey: claim.chatKey,
      messageId: claim.messageId,
      ownerEpoch: claim.ownerEpoch,
      attempt: claim.attemptCount,
    },
  };
  const eventFor = (text, done, sourceEventId) => ({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text,
      noticeKind: "todo",
      deferDuringTurn: false,
      sourceEventId,
      todoItems: [{ id: 1, text: "One state", done }],
    },
  });
  const firstA = eventFor("[x] One state", true, "todo-call-a1");
  const mutatedFirstA = eventFor("[ ] One state", false, "todo-call-a1");
  const stateB = eventFor("[ ] One state", false, "todo-call-b");
  const secondA = eventFor("[x] One state", true, "todo-call-a2");

  await controller.handleClientEvent(firstA);
  await controller.handleClientEvent(firstA);
  await controller.handleClientEvent(stateB);
  await controller.handleClientEvent(firstA);
  await controller.handleClientEvent(mutatedFirstA);
  await controller.todoDeliveryQueue;
  assert.equal(controller.latestTodoNoticeText, "⬜ One state");

  await controller.handleClientEvent(secondA);
  await controller.handleClientEvent(secondA);
  await controller.todoDeliveryQueue;

  const rows = openChatDatabase(controller.agentDir)
    .prepare(
      `SELECT delivery_kind, idempotency_key FROM outbox
        WHERE turn_id = ? ORDER BY sequence`,
    )
    .all(claim.itemId);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.delivery_kind),
    ["passive_notice", "passive_notice", "passive_notice"],
  );
  assert.equal(new Set(rows.map((row) => row.idempotency_key)).size, 3);
  assert.ok(rows[0].idempotency_key.includes("todo-call-a1"));
  assert.ok(rows[1].idempotency_key.includes("todo-call-b"));
  assert.ok(rows[2].idempotency_key.includes("todo-call-a2"));
});

test("chat controller restores fallback Todo deduplication across restart", async () => {
  const controller = await createController("telegram/1:2");
  const claim = setDurableCurrentTurn(controller, "m-todo-restart-dedup");
  const eventFor = (done) => ({
    type: "passive_notice",
    text: done ? "[x] Restart state" : "[ ] Restart state",
    noticeKind: "todo",
    deferDuringTurn: false,
    todoItems: [{ id: 1, text: "Restart state", done }],
  });

  await controller.handleFrontendEvent(eventFor(true));

  const recovered = createRecoveredController(controller);
  recovered.currentTurn = {
    ...controller.currentTurn,
    outboxTurnFence: { ...controller.currentTurn.outboxTurnFence },
  };
  const recoveredDeliveries = [];
  recovered.app.bots[0].sendMessage = async (_chatId, nodes) => {
    recoveredDeliveries.push(
      nodes
        .map((node) => node?.attrs?.content || "")
        .filter(Boolean)
        .join(""),
    );
    return [`m-recovered-${recoveredDeliveries.length}`];
  };

  await recovered.handleFrontendEvent(eventFor(true));
  await recovered.handleFrontendEvent(eventFor(false));
  await recovered.handleFrontendEvent(eventFor(true));

  const rows = openChatDatabase(recovered.agentDir)
    .prepare(
      `SELECT idempotency_key, payload_json FROM outbox
       WHERE turn_id = ? ORDER BY sequence`,
    )
    .all(claim.itemId);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => JSON.parse(row.idempotency_key)[4]),
    [1, 2, 3],
  );
  assert.deepEqual(
    rows.map(
      (row) =>
        JSON.parse(row.payload_json).parts.find((part) => part.type === "text")
          .text,
    ),
    ["✅ ~~Restart state~~", "⬜ Restart state", "✅ ~~Restart state~~"],
  );
  assert.deepEqual(recoveredDeliveries, [
    "⬜ Restart state",
    "✅ ~~Restart state~~",
  ]);
});

test("chat controller restores fallback revision from a Todo error", async () => {
  const controller = await createController("telegram/1:2");
  const claim = setDurableCurrentTurn(controller, "m-todo-error-restart");
  const stateA = {
    type: "passive_notice",
    text: "[x] Error restart state",
    noticeKind: "todo",
    deferDuringTurn: false,
    todoItems: [{ id: 1, text: "Error restart state", done: true }],
  };
  await controller.handleFrontendEvent(stateA);
  await controller.handleFrontendEvent({
    type: "passive_notice",
    text: "Error: todo write failed",
    noticeKind: "todo",
    deferDuringTurn: false,
    todoItems: [],
    todoError: "todo write failed",
  });

  const recovered = createRecoveredController(controller);
  recovered.currentTurn = {
    ...controller.currentTurn,
    outboxTurnFence: { ...controller.currentTurn.outboxTurnFence },
  };
  await recovered.handleFrontendEvent(stateA);

  const rows = openChatDatabase(recovered.agentDir)
    .prepare(
      `SELECT delivery_kind, idempotency_key FROM outbox
       WHERE turn_id = ? ORDER BY sequence`,
    )
    .all(claim.itemId);
  assert.deepEqual(
    rows.map((row) => row.delivery_kind),
    ["passive_notice", "error", "passive_notice"],
  );
  assert.deepEqual(
    rows.map((row) => JSON.parse(row.idempotency_key)[4]),
    [1, 2, 3],
  );
  assert.equal(recovered.latestTodoNoticeText, "✅ ~~Error restart state~~");
});

test("chat controller serializes concurrent fallback Todo A to B to A", async () => {
  const controller = await createController("telegram/1:2");
  const claim = setDurableCurrentTurn(controller, "m-todo-concurrent");
  const deliveries = [];
  let resolveFirstStarted = () => {};
  const firstStarted = new Promise((resolve) => {
    resolveFirstStarted = resolve;
  });
  let releaseFirst = () => {};
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  controller.app.bots[0].sendMessage = async (_chatId, nodes) => {
    deliveries.push(
      nodes
        .map((node) => node?.attrs?.content || "")
        .filter(Boolean)
        .join(""),
    );
    if (deliveries.length === 1) {
      resolveFirstStarted();
      await firstMayFinish;
    }
    return [`m-concurrent-${deliveries.length}`];
  };
  const eventFor = (done) => ({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: done ? "[x] Concurrent state" : "[ ] Concurrent state",
      noticeKind: "todo",
      deferDuringTurn: false,
      todoItems: [{ id: 1, text: "Concurrent state", done }],
    },
  });

  const firstA = controller.handleClientEvent(eventFor(true));
  await firstStarted;
  const stateB = controller.handleClientEvent(eventFor(false));
  const secondA = controller.handleClientEvent(eventFor(true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, ["✅ ~~Concurrent state~~"]);

  releaseFirst();
  await Promise.all([firstA, stateB, secondA]);
  await controller.todoDeliveryQueue;

  assert.deepEqual(deliveries, [
    "✅ ~~Concurrent state~~",
    "⬜ Concurrent state",
    "✅ ~~Concurrent state~~",
  ]);
  const rows = openChatDatabase(controller.agentDir)
    .prepare(
      `SELECT idempotency_key, payload_json FROM outbox
        WHERE turn_id = ? ORDER BY sequence`,
    )
    .all(claim.itemId);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.idempotency_key)).size, 3);
  assert.deepEqual(
    rows.map((row) => JSON.parse(row.idempotency_key)[4]),
    [1, 2, 3],
  );
  assert.deepEqual(
    rows.map(
      (row) =>
        JSON.parse(row.payload_json).parts.find((part) => part.type === "text")
          .text,
    ),
    [
      "✅ ~~Concurrent state~~",
      "⬜ Concurrent state",
      "✅ ~~Concurrent state~~",
    ],
  );
  assert.equal(controller.todoFallbackRevision, 3);
  assert.equal(controller.latestTodoNoticeText, "✅ ~~Concurrent state~~");
});

test("chat controller leaves empty Todo clear to canonical final settlement", async () => {
  const controller = await createController("discord/1:2");
  const contexts = [];
  controller.app.bots[0].platform = "discord";
  controller.app.bots[0].getWorkingIndicators = () => [
    {
      type: "polling",
      presentation: "editable-message",
      async tick(context) {
        contexts.push(context);
        return true;
      },
      async end() {
        return true;
      },
    },
  ];
  controller.driver.frontendPhase = "working";
  controller.driver.frontendState = { isStreaming: true, turnActive: true };
  setDurableCurrentTurn(controller, "m-owner-clear");
  controller.currentTurn.workingNoticeSent = true;
  controller.awaitingTurnSettle = true;
  controller.latestTodoNoticeText = "⬜ Keep working";

  await controller.handleFrontendEvent({
    type: "passive_notice",
    text: "",
    noticeKind: "todo",
    deferDuringTurn: false,
    todoItems: [],
  });

  assert.equal(controller.latestTodoNoticeText, "⬜ Keep working");
  assert.deepEqual(contexts, []);
});

test("chat controller binds an empty-state Todo error without refreshing Working", async () => {
  const controller = await createController("discord/1:2");
  const contexts = [];
  const deliveries = [];
  controller.app.bots[0].platform = "discord";
  controller.app.bots[0].getWorkingIndicators = () => [
    {
      type: "polling",
      presentation: "editable-message",
      async tick(context) {
        contexts.push(context);
        return true;
      },
      async end() {
        return true;
      },
    },
  ];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    deliveries.push({
      text: nodes.map((node) => node?.attrs?.content || "").join(""),
      kind: options?.deliveryKind,
    });
    return [`m-out-${deliveries.length}`];
  };
  controller.driver.frontendPhase = "working";
  controller.driver.frontendState = { isStreaming: true, turnActive: true };
  setDurableCurrentTurn(controller, "m-owner-error");
  controller.currentTurn.workingNoticeSent = true;
  controller.awaitingTurnSettle = true;
  controller.latestTodoNoticeText = "⬜ Keep working";

  await controller.handleFrontendEvent({
    type: "passive_notice",
    text: "Error: invalid todo list",
    noticeKind: "todo",
    deferDuringTurn: false,
    todoItems: [],
    todoError: "invalid todo list",
  });

  assert.equal(controller.latestTodoNoticeText, "");
  assert.deepEqual(contexts, []);
  assert.deepEqual(deliveries, [
    { text: "rin error: invalid todo list", kind: "error" },
  ]);
});

test("chat controller does not replay todo after a new user message", async () => {
  const controller = await createController("onebot/1:2");
  const deliveries = [];
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-todo",
    replyToMessageId: "m-todo",
    workingNoticeSent: false,
  };
  controller.awaitingTurnSettle = true;
  controller.app.bots[0].sendMessage = async (...args) => {
    deliveries.push(args);
    return ["unexpected"];
  };

  await controller.handleFrontendEvent({
    type: "user_message_start",
    text: "continue",
  });

  assert.equal(
    controller.workingIndicatorContext({ event: "tick" }).todoNoticeText,
    undefined,
  );
  assert.deepEqual(deliveries, []);
});

test("chat controller ignores persisted-user events instead of replaying session todo", async () => {
  const controller = await createController("onebot/1:2");
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "todo-replay.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(
    sessionFile,
    `${[
      {
        type: "custom",
        id: "todo-state",
        parentId: null,
        customType: "rin.todo",
        data: {
          todos: [{ id: 1, text: "Must not replay", done: false }],
          nextId: 2,
        },
      },
      {
        type: "message",
        id: "user-message",
        parentId: "todo-state",
        message: {
          role: "user",
          content: [{ type: "text", text: "continue" }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8",
  );
  controller.driver.frontendState = {
    sessionFile,
    turnActive: true,
    isStreaming: true,
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-owner",
    replyToMessageId: "m-owner",
    workingNoticeSent: false,
  };
  controller.awaitingTurnSettle = true;
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (...args) => {
    deliveries.push(args);
    return ["unexpected"];
  };

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "message_start",
      userMessageId: "user-event",
      message: {
        role: "user",
        content: [{ type: "text", text: "continue" }],
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "rin_user_message_persisted",
      sessionLeafId: "user-message",
      userMessageId: "user-event",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.latestTodoNoticeText, "");
  assert.deepEqual(deliveries, []);
});

test("chat controller keeps todo errors outside editable progress", async () => {
  const controller = await createController("discord/1:2");
  const deliveries = [];
  const claim = setDurableCurrentTurn(controller);
  controller.app.bots[0].platform = "discord";
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join("\n");
    deliveries.push({
      text,
      kind: options?.deliveryKind,
      coalesce: options?.coalesceWithWorkingMessage === true,
    });
    return [`m-out-${deliveries.length}`];
  };

  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "Error: failed to persist todo state\n[ ] Keep working",
      noticeKind: "todo",
      deferDuringTurn: false,
      todoItems: [{ id: 1, text: "Keep working", done: false }],
      todoError: "failed to persist todo state",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deliveries, [
    {
      text: "⬜ Keep working",
      kind: "passive_notice",
      coalesce: true,
    },
    {
      text: "rin error: failed to persist todo state",
      kind: "error",
      coalesce: false,
    },
  ]);
  assert.equal(controller.latestTodoNoticeText, "⬜ Keep working");
  assert.deepEqual(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT delivery_kind, turn_id FROM outbox ORDER BY sequence`)
      .all(),
    [
      { delivery_kind: "passive_notice", turn_id: claim.itemId },
      { delivery_kind: "error", turn_id: claim.itemId },
    ],
  );
  assert.deepEqual(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT state, terminal_kind FROM turns WHERE turn_id = ?`)
      .get(claim.itemId),
    { state: "running", terminal_kind: null },
  );
});

test("chat controller attempts independent todo errors when progress delivery fails", async () => {
  for (const platform of ["discord", "slack"]) {
    const controller = await createController(`${platform}/1:2`);
    controller.app.bots[0].platform = platform;
    setDurableCurrentTurn(controller);
    const attempts = [];
    controller.enqueueAndDrainDelivery = async (_payload, options) => {
      attempts.push(options?.deliveryKind);
      if (options?.deliveryKind === "passive_notice") {
        throw new Error("progress delivery failed");
      }
      return { messageIds: ["m-error"], accepted: true, settled: true };
    };

    const delivered = await controller.sendTodoPassiveNoticeNow({
      todoItems: [{ id: 1, text: "Keep working", done: false }],
      todoError: "failed to persist todo state",
    });

    assert.equal(delivered, false);
    assert.deepEqual(attempts.sort(), ["error", "passive_notice"]);
  }
});

test("chat controller keeps todo text plain for character-only chats", async () => {
  const controller = await createController("minecraft/minecraft:overworld");
  controller.app.bots[0].platform = "minecraft";
  setDurableCurrentTurn(controller);
  controller.app.bots[0].selfId = "minecraft";
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    deliveries.push({ nodes, kind: options?.deliveryKind });
    return [`m-out-${deliveries.length}`];
  };

  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "[ ] Keep working\n[x] Ship renderer",
      noticeKind: "todo",
      deferDuringTurn: false,
      todoItems: [
        { id: 1, text: "Keep working", done: false },
        { id: 2, text: "Ship renderer", done: true },
      ],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].kind, "passive_notice");
  assert.deepEqual(deliveries[0].nodes, [
    {
      type: "markdown",
      attrs: {
        content: "⬜ Keep working\n✅ Ship renderer",
      },
    },
  ]);
});

test("chat controller sends structured todo nodes to native todo chats", async () => {
  const controller = await createController("slack/B1:C1");
  controller.app.bots[0].platform = "slack";
  setDurableCurrentTurn(controller);
  controller.app.bots[0].selfId = "B1";
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (chatId, nodes, options) => {
    deliveries.push({ chatId, nodes, kind: options?.deliveryKind });
    return [`m-out-${deliveries.length}`];
  };

  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "[ ] Keep working\n[x] Ship renderer",
      noticeKind: "todo",
      deferDuringTurn: false,
      todoItems: [
        { id: 1, text: "Keep working", done: false },
        { id: 2, text: "Ship renderer", done: true },
      ],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].chatId, "C1");
  assert.equal(deliveries[0].kind, "passive_notice");
  assert.deepEqual(deliveries[0].nodes, [
    {
      type: "todo",
      attrs: {
        title: "Todo",
        items: [
          { text: "Keep working", done: false },
          { text: "Ship renderer", done: true },
        ],
      },
      children: [],
    },
  ]);
});

test("chat controller binds passive notices to the current session for quote resume", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "passive-notice-chat.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "", "utf8");
  controller.driver.frontendState = {
    sessionFile,
    sessionId: "session-passive-notice",
    isStreaming: true,
    turnActive: true,
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-owner",
    replyToMessageId: "m-owner",
    workingNoticeSent: false,
  };
  controller.app.bots[0].sendMessage = async () => ["m-passive-notice"];

  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "- [x] tool finished",
      level: "info",
      deferDuringTurn: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const stored = getChatMessage(
    controller.agentDir,
    chatKey,
    "m-passive-notice",
  );
  assert.equal(stored?.text, "- [x] tool finished");
  assert.equal(stored?.sessionFile, "passive-notice-chat.jsonl");
  const linked = lookupReplySession(
    controller.agentDir,
    chatKey,
    "m-passive-notice",
  );
  assert.equal(linked?.sessionFile, sessionFile);
});

test("chat controller quiet mode suppresses progress deliveries", async () => {
  const controller = await createController("telegram/1:2");
  await fs.writeFile(
    path.join(controller.agentDir, "settings.json"),
    JSON.stringify({
      chat: { byChatKey: { "telegram/1:2": { quietMode: true } } },
    }),
    "utf8",
  );
  assert.equal(controller.shouldSuppressQuietDelivery("final"), false);
  assert.equal(controller.shouldSuppressQuietDelivery("error"), false);
  assert.equal(controller.shouldSuppressQuietDelivery("generic"), true);

  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join(" ");
    deliveries.push({ text, kind: options?.deliveryKind });
    return [`m-out-${deliveries.length}`];
  };

  await controller.handleClientEvent({
    type: "backend_event",
    payload: { type: "assistant_interim", text: "checking" },
  });
  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "- [ ] hidden todo",
      noticeKind: "todo",
      deferDuringTurn: false,
    },
  });
  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "Hidden generic notice",
      deferDuringTurn: false,
    },
  });
  await controller.handleClientEvent({
    type: "backend_event",
    payload: { type: "compaction_start" },
  });
  await controller.handleClientEvent({
    type: "backend_event",
    payload: {
      type: "passive_notice",
      text: "Compacted from 10,000 tokens",
      noticeKind: "compaction_end",
      deferDuringTurn: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deliveries, []);
  assert.equal(controller.compactionTurn, null);
});

test("chat controller quiet mode still sends final replies by delivery kind", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join(" ");
    deliveries.push({ text, kind: options?.deliveryKind });
    return [`m-final-${deliveries.length}`];
  };
  controller.driver.runTurn = async () => ({
    finalText: "quiet final",
    sessionFile: "quiet-final.jsonl",
  });

  await controller.runTurn({
    text: "hello",
    attachments: [],
    quietMode: true,
  });

  assert.deepEqual(deliveries, [{ text: "quiet final", kind: "final" }]);
});

test("chat controller quiet mode still sends independent errors", async () => {
  const controller = await createController("telegram/1:2");
  await fs.writeFile(
    path.join(controller.agentDir, "settings.json"),
    JSON.stringify({
      chat: { byChatKey: { "telegram/1:2": { quietMode: true } } },
    }),
    "utf8",
  );
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join(" ");
    deliveries.push({ text, kind: options?.deliveryKind });
    return [`m-error-${deliveries.length}`];
  };
  controller.session = {
    sessionManager: {
      getSessionFile: () => "/tmp/quiet-error.jsonl",
      getSessionId: () => "session-quiet-error",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/quiet-error.jsonl",
      sessionId: "session-quiet-error",
    }),
    runCommand: async () => {
      throw new Error("quiet failure");
    },
  };

  await assert.rejects(controller.runCommand("/reload"), /quiet failure/);

  assert.deepEqual(deliveries, [
    { text: "rin error: quiet failure", kind: "error" },
  ]);
});

test("chat controller runTurn quiet mode option overrides stored chat settings", async () => {
  const quietController = await createController("telegram/1:2");
  const quietDeliveries = [];
  quietController.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join(" ");
    quietDeliveries.push({ text, kind: options?.deliveryKind });
    return [`m-quiet-${quietDeliveries.length}`];
  };
  quietController.driver.runTurn = async () => {
    await quietController.handleFrontendEvent({
      type: "assistant_interim",
      text: "hidden interim",
    });
    await quietController.handleFrontendEvent({
      type: "passive_notice",
      text: "- [ ] hidden todo",
      noticeKind: "todo",
      deferDuringTurn: false,
    });
    await quietController.handleFrontendEvent({
      type: "passive_notice",
      text: "- [ ] hidden deferred todo",
      noticeKind: "todo",
    });
    await quietController.handleFrontendEvent({
      type: "passive_notice",
      text: "Hidden generic notice",
      deferDuringTurn: false,
    });
    await quietController.handleFrontendEvent({
      type: "compaction_start_notice",
      text: "Compacting...",
    });
    await quietController.handleFrontendEvent({
      type: "passive_notice",
      text: "Compacted from 10,000 tokens",
      noticeKind: "compaction_end",
      deferDuringTurn: false,
    });
    return { finalText: "final", sessionFile: "quiet-option.jsonl" };
  };
  await quietController.runTurn({
    text: "hello",
    attachments: [],
    deliverFinal: false,
    quietMode: true,
  });
  assert.deepEqual(quietDeliveries, []);
  assert.deepEqual(quietController.pendingPassiveNotices, []);
  assert.equal(quietController.compactionTurn, null);

  const loudController = await createController("telegram/1:2");
  await fs.writeFile(
    path.join(loudController.agentDir, "settings.json"),
    JSON.stringify({
      chat: { byChatKey: { "telegram/1:2": { quietMode: true } } },
    }),
    "utf8",
  );
  const loudDeliveries = [];
  loudController.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join(" ");
    loudDeliveries.push({ text, kind: options?.deliveryKind });
    return [`m-loud-${loudDeliveries.length}`];
  };
  loudController.driver.runTurn = async () => {
    await loudController.handleFrontendEvent({
      type: "assistant_interim",
      text: "visible interim",
    });
    await loudController.handleFrontendEvent({
      type: "passive_notice",
      text: "- [ ] visible todo",
      noticeKind: "todo",
      deferDuringTurn: false,
    });
    return { finalText: "final", sessionFile: "loud-option.jsonl" };
  };
  await loudController.runTurn({
    text: "hello",
    attachments: [],
    deliverFinal: false,
    quietMode: false,
  });
  assert.deepEqual(loudDeliveries, [
    { text: "... visible interim", kind: "interim" },
  ]);
});

test("chat controller drops deferred passive notices at the final boundary", async () => {
  const controller = await createController("telegram/1:2");
  await fs.writeFile(
    path.join(controller.agentDir, "settings.json"),
    JSON.stringify({
      chat: { byChatKey: { "telegram/1:2": { quietMode: true } } },
    }),
    "utf8",
  );
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || "")
      .filter(Boolean)
      .join(" ");
    deliveries.push({ text, kind: options?.deliveryKind });
    return [`m-deferred-${deliveries.length}`];
  };
  controller.driver.runTurn = async () => {
    await controller.handleFrontendEvent({
      type: "passive_notice",
      text: "- [ ] visible deferred todo",
      noticeKind: "todo",
    });
    return { finalText: "final", sessionFile: "loud-deferred.jsonl" };
  };

  await controller.runTurn({
    text: "hello",
    attachments: [],
    quietMode: false,
  });

  assert.deepEqual(deliveries, [{ text: "final", kind: "final" }]);
  assert.deepEqual(controller.pendingPassiveNotices, []);
});

test("chat controller does not create processing turns for slash commands", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  controller.app.bots[0].workingIndicators = [
    testPollingIndicator(actions, reactions),
  ];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "compact-without-working-poll.jsonl",
  );
  let releaseCommand = () => {};
  let commandStarted = () => {};
  const commandStartedPromise = new Promise((resolve) => {
    commandStarted = resolve;
  });
  const releaseCommandPromise = new Promise((resolve) => {
    releaseCommand = resolve;
  });
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-compact",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-compact",
    }),
    runCommand: async () => {
      commandStarted();
      await releaseCommandPromise;
      return { handled: true, text: "backend text should be localized" };
    },
  };

  const command = controller.runCommand("/session", "m-session", "m-session");
  await commandStartedPromise;

  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
  await controller.pollTyping();
  releaseCommand();
  await command;

  assert.deepEqual(actions, []);
  assert.deepEqual(reactions, []);
  assert.deepEqual(deliveries, ["backend text should be localized"]);
});

test("chat controller ignores replied session files for /new", async () => {
  const controller = await createController();
  const calls = [];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  const repliedSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "replied-old-session.jsonl",
  );
  await fs.mkdir(path.dirname(repliedSessionFile), { recursive: true });
  await fs.writeFile(repliedSessionFile, "", "utf8");

  let currentSessionFile;
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => currentSessionFile,
      getSessionId: () => "session-new",
      getSessionName: () => controller.chatKey,
    },
    newSession: async (options = {}) => {
      calls.push(`newSession:${options.managedSessionLeaf}`);
      currentSessionFile = path.join(
        controller.agentDir,
        "sessions",
        "managed",
        options.managedSessionLeaf,
        "created-with-reply.jsonl",
      );
      return true;
    },
    switchSession: async (sessionFile) => {
      calls.push(
        `switchSession:${path.relative(controller.agentDir, sessionFile)}`,
      );
      currentSessionFile = sessionFile;
    },
    ensureSessionReady: async () => ({
      sessionFile: currentSessionFile,
      sessionId: "session-new",
    }),
  };

  await controller.runCommand("/new", "m-new", "m-new", repliedSessionFile);

  assert.deepEqual(calls, ["newSession:chat"]);
  assert.deepEqual(deliveries, ["Started a new session."]);
  assert.match(controller.state.sessionFile || "", /^managed\/chat\//);
});

test("chat controller ignores replied session files for non-new commands", async () => {
  const controller = await createController("cron/detached:test");
  const calls = [];

  const currentSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "current-chat.jsonl",
  );
  const repliedSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "replied-old-session.jsonl",
  );
  await fs.mkdir(path.dirname(currentSessionFile), { recursive: true });
  await fs.writeFile(currentSessionFile, "", "utf8");
  await fs.writeFile(repliedSessionFile, "", "utf8");

  let liveSessionFile = currentSessionFile;
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => liveSessionFile,
      getSessionId: () => "session-current",
      getSessionName: () => controller.chatKey,
    },
    switchSession: async (sessionFile) => {
      calls.push(
        `switchSession:${path.relative(controller.agentDir, sessionFile)}`,
      );
      liveSessionFile = sessionFile;
    },
    ensureSessionReady: async () => {
      calls.push("ensureSessionReady");
      return {
        sessionFile: liveSessionFile,
        sessionId: "session-current",
      };
    },
    runCommand: async (commandLine) => {
      calls.push(`runCommand:${commandLine}`);
      return { handled: true, text: "Command done." };
    },
    compact: async () => {
      calls.push("compact");
      return { handled: true, text: "Compacted session." };
    },
  };

  await controller.runCommand(
    "/compact",
    "m-compact",
    "m-compact",
    repliedSessionFile,
  );

  assert.deepEqual(calls, ["ensureSessionReady", "compact"]);
  assert.equal(liveSessionFile, currentSessionFile);
});

test("chat controller uses configured command response overrides", async () => {
  const controller = await createController();
  controller.commandResponses = {
    new: "\u5df2\u5f00\u59cb\u65b0\u4f1a\u8bdd\u3002",
  };
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  let currentSessionFile;
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => currentSessionFile,
      getSessionId: () => "session-new",
      getSessionName: () => controller.chatKey,
    },
    newSession: async (options = {}) => {
      currentSessionFile = path.join(
        controller.agentDir,
        "sessions",
        "managed",
        options.managedSessionLeaf,
        "created-localized-command.jsonl",
      );
      return true;
    },
    ensureSessionReady: async () => ({
      sessionFile: currentSessionFile,
      sessionId: "session-new",
    }),
  };

  await controller.runCommand("/new", "m-new", "m-new");

  assert.deepEqual(deliveries, ["\u5df2\u5f00\u59cb\u65b0\u4f1a\u8bdd\u3002"]);
});

test("chat controller starts /new immediately through the TUI new-session path", async () => {
  const controller = await createController();
  const calls = [];
  const deliveries = [];
  let backendAbortCalled = false;
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  let sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "old-chat.jsonl",
  );
  let sessionId = "session-old";
  let firstRequestTag = "";
  const session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({ sessionFile, sessionId }),
    agent: {
      abort: () => {
        backendAbortCalled = true;
      },
    },
    prompt: async (_text, options = {}) => {
      firstRequestTag = options.requestTag || "";
      await controller.handleClientEvent({
        type: "ui",
        payload: { type: "rpc_frontend_status", phase: "working" },
      });
    },
    newSession: async (options = {}) => {
      calls.push(`newSession:${options.managedSessionLeaf}`);
      await controller.handleClientEvent({
        type: "rpc_turn_event",
        event: "error",
        requestTag: firstRequestTag,
        error: "chat_turn_aborted",
        sessionFile,
        sessionId,
      });
      sessionFile = path.join(
        controller.agentDir,
        "sessions",
        "new-chat.jsonl",
      );
      sessionId = "session-new";
      return true;
    },
  };
  controller.session = session;
  controller.connect = async () => {
    if (!controller.session) controller.session = session;
  };

  const firstTurn = controller.runTurn({
    text: "first",
    attachments: [],
    replyToMessageId: "m1",
    incomingMessageId: "m1",
  });
  while (!firstRequestTag) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  const newCommand = await Promise.race([
    controller.runCommand("/new", "m-new", "m-new"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("new command queued")), 50),
    ),
  ]);
  assert.equal(newCommand.text, "Started a new session.");
  assert.equal(backendAbortCalled, true);
  assert.deepEqual(await firstTurn, {
    aborted: true,
    sessionId: "session-new",
    sessionFile: path.join(controller.agentDir, "sessions", "new-chat.jsonl"),
  });

  await emitRpcTurnComplete(
    controller,
    { requestTag: firstRequestTag },
    "first done",
  );

  assert.deepEqual(calls, ["newSession:chat", "newSession:chat"]);
  assert.deepEqual(deliveries, ["Started a new session."]);
  assert.equal(controller.state.sessionFile, "new-chat.jsonl");
  assert.equal(
    readChatState(controller.agentDir, controller.chatKey).currentGeneration,
    1,
  );
});

test("chat controller leaves externally aborted inbound unprocessed for retry", async () => {
  const controller = await createController();
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "restart-chat.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  saveChatMessage(controller.agentDir, {
    chatKey: controller.chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    messageId: "m-restart",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "restart interrupted prompt",
  });

  let requestTag = "";
  const session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-restart",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-restart",
    }),
    prompt: async (_text, options = {}) => {
      requestTag = options.requestTag || "";
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "rpc_turn_event",
          event: "error",
          requestTag,
          error: "chat_turn_aborted",
          sessionFile,
          sessionId: "session-restart",
        },
      });
    },
  };
  controller.session = session;
  controller.connect = async () => {
    if (!controller.session) controller.session = session;
  };

  await assert.rejects(
    () =>
      controller.runTurn({
        text: "restart interrupted prompt",
        attachments: [],
        replyToMessageId: "m-restart",
        incomingMessageId: "m-restart",
      }),
    /chat_turn_aborted/,
  );

  const stored = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "m-restart",
  );
  assert.equal(stored?.processedAt, undefined);
  assert.equal(controller.currentTurn, null);
});

test("chat controller rethrows lifecycle cancellation without delivering an error final", async () => {
  const controller = await createController();
  const deliveries = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        async sendMessage(_chatId, nodes, options) {
          deliveries.push({ nodes, options });
          return ["m-error"];
        },
        internal: { async sendChatAction() {} },
      },
    ],
  };
  controller.connect = async () => {};
  controller.driver.runTurn = async () => {
    await controller.handleSessionEvent({ type: "agent_start" });
    throw new Error("Request was aborted");
  };
  saveChatMessage(controller.agentDir, {
    chatKey: controller.chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    messageId: "m-request-aborted",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "update now",
  });

  await assert.rejects(
    () =>
      controller.runTurn({
        text: "update now",
        attachments: [],
        replyToMessageId: "m-request-aborted",
        incomingMessageId: "m-request-aborted",
      }),
    /Request was aborted/,
  );

  assert.deepEqual(deliveries, []);
  const stored = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "m-request-aborted",
  );
  assert.equal(stored?.processedAt, undefined);
});

test("chat controller /new aborts without synthesizing pre-agent Working", async () => {
  const controller = await createController();
  const deliveries = [];
  const visibleEvents: string[] = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };
  controller.app.bots[0].workingIndicators = [
    {
      type: "polling",
      presentation: "editable-message",
      async tick() {
        visibleEvents.push("tick");
        return true;
      },
      async end() {
        visibleEvents.push("end");
        return true;
      },
    },
  ];

  let promptCalled = false;
  let abortCalled = false;
  let releasePrompt!: () => void;
  const promptReleased = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  controller.driver.runTurn = async () => {
    promptCalled = true;
    await promptReleased;
    throw new Error("chat_turn_aborted");
  };
  controller.driver.interruptActiveTurnLikeTui = () => {
    abortCalled = true;
    releasePrompt();
    return { sessionFile: "/tmp/old-chat.jsonl" };
  };
  controller.driver.runCommand = async (commandLine: string) => {
    assert.equal(commandLine, "/new");
    return {
      handled: true,
      text: "Started a new session.",
      sessionFile: "/tmp/new-chat.jsonl",
      sessionId: "session-new",
    };
  };
  controller.driver.currentSessionFile = () => "/tmp/new-chat.jsonl";
  controller.driver.currentSessionId = () => "session-new";

  const firstTurn = controller.runTurn({
    text: "/ne",
    attachments: [],
    replyToMessageId: "m-old",
    incomingMessageId: "m-old",
  });
  while (!promptCalled) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const [newCommand, aborted] = await Promise.all([
    controller.runCommand("/new", "m-new", "m-new"),
    firstTurn,
  ]);

  assert.equal(newCommand.text, "Started a new session.");
  assert.equal(abortCalled, true);
  assert.equal(aborted.aborted, true);
  assert.deepEqual(deliveries, ["Started a new session."]);
  assert.equal(visibleEvents.includes("tick"), false);
});

test("chat controller suppresses /compact acknowledgement but keeps configured /reload response", async () => {
  for (const [command, resultText, expectedDeliveries] of [
    ["/compact", "Compacted session.", []],
    [
      "/reload",
      "Reloaded extensions, prompts, skills, and themes.",
      ["Reloaded extensions, prompts, skills, and themes."],
    ],
  ]) {
    const controller = await createController();
    const calls = [];
    const prompts = [];
    const deliveries = [];
    controller.commitPendingDelivery = async function () {
      deliveries.push(deliveryText(this.stagedDelivery));
      this.stagedDelivery = null;
    };

    const sessionFile = path.join(
      controller.agentDir,
      "sessions",
      `${command.slice(1)}-chat.jsonl`,
    );
    controller.session = {
      isStreaming: false,
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => `session-${command.slice(1)}`,
        getSessionName: () => controller.chatKey,
      },
      ensureSessionReady: async () => {
        calls.push("ensureSessionReady");
        return {
          sessionFile,
          sessionId: `session-${command.slice(1)}`,
        };
      },
      runCommand: async (commandLine) => {
        calls.push(`runCommand:${commandLine}`);
        return { handled: true, text: resultText, sessionFile };
      },
      compact: async () => {
        calls.push("compact");
        return { handled: true, text: resultText, sessionFile };
      },
      prompt: async (text, options = {}) => {
        prompts.push(text);
        emitRpcTurnComplete(controller, options, "unexpected temp reply");
      },
      switchSession: async () => {},
    };

    await controller.runCommand(command);

    assert.deepEqual(
      calls,
      command === "/compact"
        ? ["ensureSessionReady", "compact"]
        : ["ensureSessionReady", `runCommand:${command}`],
    );
    assert.deepEqual(prompts, []);
    assert.deepEqual(deliveries, expectedDeliveries);
  }
});

test("chat controller marks /compact processed from compaction completion notice", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (chatId, content) => {
    deliveries.push({ chatId, content });
    return [`compact-${deliveries.length}`];
  };

  const acceptedAt = new Date().toISOString();
  saveChatMessage(controller.agentDir, {
    messageId: "m-compact",
    chatKey: controller.chatKey,
    platform: "telegram",
    chatId: "2",
    chatType: "private",
    role: "user",
    receivedAt: acceptedAt,
    acceptedAt,
    text: "/compact",
  });

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "compact-chat.jsonl",
  );
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-compact",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-compact",
    }),
    compact: async () => {
      await controller.handleClientEvent({
        type: "ui",
        payload: { type: "compaction_start", reason: "manual" },
      });
      await new Promise((resolve) => setImmediate(resolve));
      return {
        handled: true,
        text: "Compacted session.",
        sessionFile,
      };
    },
    prompt: async (text, options = {}) => {
      emitRpcTurnComplete(controller, options, "unexpected temp reply");
    },
    switchSession: async () => {},
  };

  await controller.runCommand("/compact", "m-compact", "m-compact");
  let stored = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "m-compact",
  );
  assert.ok(stored?.acceptedAt);
  assert.equal(stored?.processedAt, undefined);

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      tokensBefore: 77625,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  stored = getChatMessage(controller.agentDir, controller.chatKey, "m-compact");
  assert.ok(
    stored?.processedAt,
    "completion notice delivery should mark the original /compact processed",
  );
  assert.deepEqual(deliveries, [
    {
      chatId: "2",
      content: [
        {
          type: "quote",
          attrs: {
            id: "m-compact",
          },
        },
        {
          type: "markdown",
          attrs: {
            content: "Compacting...",
          },
        },
      ],
    },
    {
      chatId: "2",
      content: [
        {
          type: "quote",
          attrs: {
            id: "m-compact",
          },
        },
        {
          type: "markdown",
          attrs: {
            content: "Compacted from 77,625 tokens",
          },
        },
      ],
    },
  ]);
});

test("chat controller keeps the current Working target until Pi confirms the next ordinary input", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  let releaseFirstPrompt = () => {};
  let resolveFirstPromptStarted = () => {};
  const firstPromptStarted = new Promise((resolve) => {
    resolveFirstPromptStarted = resolve;
  });

  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        workingIndicators: [testPollingIndicator(actions, reactions)],
        async createReaction(chatId, messageId, emoji) {
          reactions.push(["create", chatId, messageId, emoji]);
        },
        async deleteReaction(chatId, messageId, emoji, userId) {
          reactions.push(["delete", chatId, messageId, emoji, userId]);
        },
        internal: {
          async sendChatAction(payload) {
            actions.push(payload);
          },
        },
      },
    ],
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/live-chat.jsonl",
      getSessionId: () => "session-live",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/live-chat.jsonl",
      sessionId: "session-live",
    }),
    prompt: async (_text, options = {}) => {
      if (controller.session.isStreaming) return { acceptedAs: "steer" };
      controller.session.isStreaming = true;
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "rpc_turn_event",
          event: "start",
          requestTag: options.requestTag,
        },
      });
      await controller.handleSessionEvent({
        type: "extension_ui_request",
        method: "setWorkingVisible",
        visible: true,
      });
      await controller.handleSessionEvent({ type: "agent_start" });
      resolveFirstPromptStarted();
      await new Promise((resolve) => {
        releaseFirstPrompt = resolve;
      });
      controller.session.isStreaming = false;
      await controller.handleSessionEvent({
        type: "extension_ui_request",
        method: "setWorkingVisible",
        visible: false,
      });
      await controller.handleSessionEvent({ type: "agent_end" });
      emitRpcTurnComplete(controller, options, "done");
    },
    switchSession: async () => {},
  };

  const firstTurn = controller.runTurn({
    text: "first",
    attachments: [],
    incomingMessageId: "m-first",
    replyToMessageId: "m-first",
  });
  await firstPromptStarted;

  saveChatMessage(controller.agentDir, {
    messageId: "m-steer",
    chatKey: controller.chatKey,
    platform: "telegram",
    chatId: "2",
    chatType: "private",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "steer now",
  });

  const submittedTurn = controller.runTurn({
    text: "steer now",
    attachments: [],
    incomingMessageId: "m-steer",
    replyToMessageId: "m-steer",
  });
  await waitUntil(
    () => controller.hasPendingSubmittedDeliveryTarget("m-steer"),
    "ordinary input did not reach backend admission",
  );

  assert.equal(controller.currentTurn?.incomingMessageId, "m-first");
  assert.equal(controller.currentTurn?.replyToMessageId, "m-first");
  assert.equal(controller.hasBackendAcceptedInboundMessage("m-steer"), false);
  assert.equal(controller.ownsInboundMessage("m-steer"), true);
  const steeredState = JSON.parse(
    await fs.readFile(controller.statePath, "utf8"),
  );
  assert.equal(
    steeredState.pendingSubmittedDeliveryTargets,
    undefined,
    "transport-pending input must not be persisted as steering state",
  );
  const restoredController = new ChatController(
    {},
    controller.dataDir,
    controller.chatKey,
    {
      logger: { info() {}, warn() {} },
      h: controller.h,
    },
  );
  assert.equal(
    restoredController.hasPendingSubmittedDeliveryTarget("m-steer"),
    false,
    "restart recovery must reconstruct steering from the SQLite turn ledger",
  );
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [["create", "2", "m-first", "🤔"]]);

  await controller.pollTyping();
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [["create", "2", "m-first", "🤔"]]);

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "steer now" }],
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const activatedState = JSON.parse(
    await fs.readFile(controller.statePath, "utf8"),
  );
  assert.equal(activatedState.pendingSubmittedDeliveryTargets, undefined);
  assert.equal(controller.currentTurn?.incomingMessageId, "m-steer");
  assert.equal(controller.currentTurn?.replyToMessageId, "m-steer");
  const steeredMessage = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "m-steer",
  );
  assert.ok(
    steeredMessage?.acceptedAt,
    "submitted inbox item should be accepted when Pi starts the user message",
  );
  assert.equal(
    steeredMessage?.processedAt,
    undefined,
    "submitted inbox remains running until a terminal outbox is committed",
  );
  assert.deepEqual(actions, [
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
  ]);
  assert.deepEqual(reactions, [
    ["create", "2", "m-first", "🤔"],
    ["delete", "2", "m-first", "🤔", "1"],
    ["create", "2", "m-steer", "🤔"],
  ]);

  releaseFirstPrompt();
  const [firstResult, submittedResult] = await Promise.all([
    firstTurn,
    submittedTurn,
  ]);
  assert.equal(firstResult.finalText, "done");
  assert.equal(submittedResult.finalText, "done");
  assert.equal(
    submittedResult.superseded,
    true,
    "a shared live-turn waiter must leave durable terminal ownership to the canonical final",
  );
});

test("chat controller delivers a backend terminal after remote-active admission without a local waiter", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push(this.stagedDelivery);
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
    return { accepted: true, settled: true, results: [] };
  };
  controller.session = {
    isStreaming: true,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/remote-active-chat.jsonl",
      getSessionId: () => "session-remote-active",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/remote-active-chat.jsonl",
      sessionId: "session-remote-active",
    }),
    prompt: async () => ({ acceptedAs: "steer" }),
    switchSession: async () => {},
  };

  const submittedTurn = controller.runTurn({
    text: "steer after reconnect",
    attachments: [],
    incomingMessageId: "m-remote-steer",
    replyToMessageId: "m-remote-steer",
  });
  await waitUntil(
    () => Boolean(controller.currentTurn),
    "remote-active input did not establish its display target",
  );

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "message_start",
      requestTag: controller.currentTurn?.requestTag,
      message: {
        role: "user",
        content: [{ type: "text", text: "steer after reconnect" }],
      },
    },
  });
  emitRpcTurnComplete(
    controller,
    { requestTag: controller.currentTurn?.requestTag },
    "remote steer final",
  );
  assert.equal((await submittedTurn).finalText, "remote steer final");

  assert.equal(deliveries.length, 1);
  assert.equal(deliveryText(deliveries[0]), "remote steer final");
  assert.equal(deliveryQuoteId(deliveries[0]), "m-remote-steer");
  assert.equal(controller.currentTurn, null);
});

test("chat controller delivers a backend error after remote-active admission without a local waiter", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push(this.stagedDelivery);
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
    return { accepted: true, settled: true, results: [] };
  };
  controller.session = {
    isStreaming: true,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/remote-active-error.jsonl",
      getSessionId: () => "session-remote-error",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/remote-active-error.jsonl",
      sessionId: "session-remote-error",
    }),
    prompt: async () => ({ acceptedAs: "steer" }),
    switchSession: async () => {},
  };

  const submittedTurn = controller.runTurn({
    text: "steer before failure",
    attachments: [],
    incomingMessageId: "m-remote-error",
    replyToMessageId: "m-remote-error",
  });
  await waitUntil(
    () => Boolean(controller.currentTurn),
    "remote-active input did not establish its error target",
  );

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "error",
      requestTag: controller.currentTurn?.requestTag,
      error: "remote failure",
      sessionId: "session-remote-error",
      sessionFile: "/tmp/remote-active-error.jsonl",
    },
  });
  await assert.rejects(submittedTurn, /remote failure/);

  assert.equal(deliveries.length, 1);
  assert.equal(deliveryText(deliveries[0]), "remote failure");
  assert.equal(deliveryQuoteId(deliveries[0]), "m-remote-error");
  assert.equal(controller.currentTurn, null);
});

test("chat controller accepts ordinary input after an assistant tool-call interim", async () => {
  const controller = await createController("telegram/1:2");
  const promptCalls = [];
  let releaseFirstPrompt = () => {};
  let firstRequestTag = "";
  let resolveFirstPromptStarted = () => {};
  const firstPromptStarted = new Promise((resolve) => {
    resolveFirstPromptStarted = resolve;
  });

  controller.commitPendingDelivery = async function (clearProcessing = false) {
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/live-chat.jsonl",
      getSessionId: () => "session-live",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/live-chat.jsonl",
      sessionId: "session-live",
    }),
    prompt: async (text, options = {}) => {
      promptCalls.push({ text, streamingBehavior: options.streamingBehavior });
      if (controller.session.isStreaming) return { acceptedAs: "steer" };
      firstRequestTag = String(options.requestTag || "");
      controller.session.isStreaming = true;
      resolveFirstPromptStarted();
      await new Promise((resolve) => {
        releaseFirstPrompt = resolve;
      });
      controller.session.isStreaming = false;
      emitRpcTurnComplete(controller, { requestTag: firstRequestTag }, "done");
    },
    switchSession: async () => {},
  };

  const firstTurn = controller.runTurn({
    text: "first",
    attachments: [],
    incomingMessageId: "m-first",
  });
  await firstPromptStarted;
  await controller.handleSessionEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "toolCall", name: "read", id: "call-1" },
      ],
    },
  });

  assert.equal(controller.hasActiveTurn(), true);
  const submittedTurn = controller.runTurn({
    text: "steer now",
    attachments: [],
    incomingMessageId: "m-steer-now",
  });
  await waitUntil(
    () => promptCalls.length === 2,
    "ordinary input did not reach Pi during the tool gap",
  );

  assert.deepEqual(promptCalls, [
    { text: "first", streamingBehavior: undefined },
    { text: "steer now", streamingBehavior: undefined },
  ]);

  releaseFirstPrompt();
  const [firstResult, submittedResult] = await Promise.all([
    firstTurn,
    submittedTurn,
  ]);
  assert.equal(firstResult.finalText, "done");
  assert.equal(submittedResult.finalText, "done");
});

test("chat controller stages raw non-transient command errors for the outbox", async () => {
  const controller = await createController();
  const deliveries = [];
  controller.commitPendingDelivery = async function (
    _clearProcessing,
    _postDelivery,
    options,
  ) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      kind: this.stagedDelivery?.deliveryKind,
      id: options.id,
      idempotencyKey: options.idempotencyKey,
    });
    this.stagedDelivery = null;
  };

  controller.session = {
    sessionManager: {
      getSessionFile: () => "/tmp/fresh-chat.jsonl",
      getSessionId: () => "session-1",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/fresh-chat.jsonl",
      sessionId: "session-1",
    }),
    runCommand: async () => {
      throw new Error("boom");
    },
  };

  await assert.rejects(
    controller.runCommand("/reload", "m-error", "m-error"),
    /boom/,
  );
  const contentHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ text: "rin error: boom", parts: [] }))
    .digest("hex");
  const idempotencyKey = JSON.stringify([
    "error",
    controller.chatKey,
    "m-error",
    "m-error",
    contentHash,
  ]);
  assert.deepEqual(deliveries, [
    {
      text: "boom",
      kind: "error",
      id: `error-${crypto.createHash("sha256").update(idempotencyKey).digest("hex")}`,
      idempotencyKey,
    },
  ]);
});

test("chat controller stages raw daemon command errors without retry classification", async () => {
  const controller = await createController();
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      kind: this.stagedDelivery?.deliveryKind,
    });
    this.stagedDelivery = null;
  };

  controller.session = {
    sessionManager: {
      getSessionFile: () => "/tmp/fresh-chat.jsonl",
      getSessionId: () => "session-1",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => {
      throw new Error("connect ENOENT /run/user/1001/rin-daemon/daemon.sock");
    },
    runCommand: async () => ({ handled: true, text: "unreachable" }),
  };

  await assert.rejects(
    controller.runCommand("/reload"),
    /connect ENOENT \/run\/user\/1001\/rin-daemon\/daemon.sock/,
  );
  assert.deepEqual(deliveries, [
    {
      text: "connect ENOENT /run/user/1001/rin-daemon/daemon.sock",
      kind: "error",
    },
  ]);
});

test("chat controller can expose external working indicators", async () => {
  const actions = [];
  const controller = await createController("telegram/1:2");
  controller.app.bots[0].getWorkingIndicators = () => [
    testPollingIndicator(actions),
  ];
  controller.driver.hasWorkerActiveTurn = () => true;

  await controller.beginExternalWorking();

  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
});

test("chat controller stops external typing when external working ends", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  controller.app.bots[0].getWorkingIndicators = () => [
    testPollingIndicator(actions),
  ];
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-active-external",
    workingNoticeSent: false,
  };
  controller.externalWorkingVisible = true;
  controller.awaitingTurnSettle = true;
  controller.driver.frontendState.turnActive = true;

  await controller.endExternalWorking();

  assert.equal(controller.currentTurn, null);
  assert.equal(controller.externalWorkingVisible, false);
  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(actions, []);
});

test("chat controller replaces editable Working with a completed assistant summary", async () => {
  const controller = await createController("telegram/1:2");
  const contexts: any[] = [];
  controller.app.bots[0].getWorkingIndicators = () => [
    {
      type: "polling",
      presentation: "editable-message",
      async tick(context) {
        contexts.push(context);
        return true;
      },
    },
  ];
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-summary",
    requestTag: "summary-tag",
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: "summary-turn",
      chatKey: controller.chatKey,
      messageId: "m-summary",
      ownerEpoch: "summary-owner",
      attempt: 1,
    },
    workingNoticeSent: true,
  };
  controller.awaitingTurnSettle = true;
  controller.driver.frontendState.turnActive = true;
  controller.driver.frontendState.workingVisible = true;
  controller.driver.hasVisibleChatWorkingTurn = () => true;

  await controller.handleFrontendEvent({
    type: "assistant_summary",
    text: "Stale summary",
    requestTag: "stale-tag",
  });
  assert.equal(contexts.length, 0);

  await controller.handleFrontendEvent({
    type: "assistant_summary",
    text: "**Planning the response**\n\n**Designing [casual](https://example.com) greeting response**",
    requestTag: "summary-tag",
  });

  assert.equal(contexts.length, 1);
  assert.equal(
    contexts[0].assistantSummaryText,
    "Designing casual greeting response",
  );
  assert.equal(
    controller.latestAssistantSummaryText,
    "Designing casual greeting response",
  );

  await controller.handleFrontendEvent({
    type: "assistant_summary",
    text: "**Checking the rendered result.**",
    requestTag: "summary-tag",
  });
  assert.equal(contexts.length, 2);
  assert.equal(
    contexts[1].assistantSummaryText,
    "Checking the rendered result.",
  );

  await controller.clearWorkingReaction();
  assert.equal(controller.latestAssistantSummaryText, "");
  controller.latestAssistantSummaryText = "Residual summary state";
  controller.awaitingTurnSettle = false;
  controller.clearCurrentTurn();
  assert.equal(controller.latestAssistantSummaryText, "");
  await controller.handleFrontendEvent({
    type: "assistant_summary",
    text: "Late stale summary",
  });
  assert.equal(contexts.length, 2);
  assert.equal(controller.latestAssistantSummaryText, "");
});

test("chat controller keeps editable summary and compaction refreshes suppressed when progress is hidden", async () => {
  const controller = await createController("telegram/1:2");
  const contexts = [];
  const deliveries = [];
  controller.app.bots[0].getWorkingIndicators = () => [
    {
      type: "polling",
      presentation: "editable-message",
      async tick(context) {
        contexts.push({ ...context });
        return true;
      },
    },
  ];
  controller.app.bots[0].sendMessage = async (_chatId, nodes) => {
    deliveries.push(nodes);
    return [`m-out-${deliveries.length}`];
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-hidden-progress",
    replyToMessageId: "m-hidden-progress",
    workingNoticeSent: false,
  };
  controller.awaitingTurnSettle = true;
  controller.driver.frontendState = { turnActive: false, isStreaming: false };
  controller.driver.hasVisibleChatWorkingTurn = () => false;

  await controller.handleFrontendEvent({
    type: "assistant_summary",
    text: "Hidden summary",
  });
  assert.deepEqual(contexts, []);

  controller.quietModeOverride = true;
  controller.driver.frontendState = { turnActive: true, isStreaming: true };
  await controller.handleFrontendEvent({
    type: "compaction_start_notice",
    text: "Compacting...",
  });

  assert.deepEqual(contexts, []);
  assert.deepEqual(deliveries, []);
});

test("chat controller polls typing and rotating reactions while a turn is active", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        workingIndicators: [testPollingIndicator(actions, reactions)],
        async createReaction(chatId, messageId, emoji) {
          reactions.push(["create", chatId, messageId, emoji]);
        },
        async deleteReaction(chatId, messageId, emoji, userId) {
          reactions.push(["delete", chatId, messageId, emoji, userId]);
        },
        internal: {
          async sendChatAction(payload) {
            actions.push(payload);
          },
        },
      },
    ],
  };

  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m1",
    workingNoticeSent: false,
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});
  controller.driver.frontendState.turnActive = true;
  controller.driver.frontendState.workingVisible = true;

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [["create", "2", "m1", "🤔"]]);

  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [["create", "2", "m1", "🤔"]]);

  controller.lastWorkingIndicatorAt -= 4_000;
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
  ]);
  assert.deepEqual(reactions, [["create", "2", "m1", "🤔"]]);

  controller.lastWorkingReactionAt -= 30_000;
  controller.lastWorkingIndicatorAt -= 4_000;
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
  ]);
  assert.deepEqual(reactions, [
    ["create", "2", "m1", "🤔"],
    ["create", "2", "m1", "🔥"],
  ]);
});

test("chat controller keeps typing heartbeat frequent while throttling editable Working animation to reaction interval", async () => {
  const controller = await createController("discord/1:2");
  const calls: Array<[string, number]> = [];
  controller.app.bots[0].platform = "discord";
  controller.app.bots[0].getWorkingIndicators = () => [
    {
      type: "polling",
      presentation: "typing",
      async tick({ tick }) {
        calls.push(["typing", Number(tick)]);
        return true;
      },
    },
    {
      type: "polling",
      presentation: "editable-message",
      async tick({ tick }) {
        calls.push(["edit", Number(tick)]);
        return true;
      },
    },
  ];
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-edit-interval",
    workingNoticeSent: true,
  };
  controller.driver.hasVisibleChatWorkingTurn = () => true;

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(calls, [
    ["typing", 0],
    ["edit", 0],
  ]);

  controller.lastTypingIndicatorAt -= 9_000;
  controller.lastWorkingIndicatorAt -= 9_000;
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(calls, [
    ["typing", 0],
    ["edit", 0],
    ["typing", 1],
  ]);

  controller.lastTypingIndicatorAt -= 9_000;
  controller.lastWorkingIndicatorAt -= 21_000;
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(calls, [
    ["typing", 0],
    ["edit", 0],
    ["typing", 1],
    ["typing", 1],
    ["edit", 1],
  ]);
});

test("chat controller clears typing and working reactions after canonical completion", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        workingIndicators: [testPollingIndicator(actions, reactions)],
        async sendMessage() {
          return ["m-final"];
        },
        async createReaction(chatId, messageId, emoji) {
          reactions.push(["create", chatId, messageId, emoji]);
        },
        async deleteReaction(chatId, messageId, emoji, userId) {
          reactions.push(["delete", chatId, messageId, emoji, userId]);
        },
        internal: {
          async sendChatAction(payload) {
            actions.push(payload);
          },
        },
      },
    ],
  };
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/complete-clears-working.jsonl",
      getSessionId: () => "session-complete-clears-working",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/complete-clears-working.jsonl",
      sessionId: "session-complete-clears-working",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({
        type: "extension_ui_request",
        method: "setWorkingVisible",
        visible: true,
      });
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "extension_ui_request",
        method: "setWorkingVisible",
        visible: false,
      });
      await controller.handleSessionEvent({ type: "agent_end" });
      emitRpcTurnComplete(controller, options, "done");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-complete",
    replyToMessageId: "m-complete",
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [
    ["create", "2", "m-complete", "🤔"],
    ["delete", "2", "m-complete", "🤔", "1"],
  ]);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
  assert.equal(await controller.pollTyping(), false);
});

test("chat controller stops typing at agent end while final delivery remains in flight", async () => {
  const previousTimeout = process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS;
  process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS = "20";
  try {
    const controller = await createController("telegram/1:2");
    const actions = [];
    const reactions = [];
    let resolveDelivery;
    let turnSettled = false;
    controller.app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          workingIndicators: [testPollingIndicator(actions, reactions)],
          sendMessage() {
            return new Promise((resolve) => {
              resolveDelivery = resolve;
            });
          },
          internal: {
            async sendChatAction(payload) {
              actions.push(payload);
            },
          },
        },
      ],
    };
    controller.session = {
      isStreaming: false,
      messages: [],
      sessionManager: {
        getSessionFile: () => "/tmp/dispatched-final-delivery.jsonl",
        getSessionId: () => "session-dispatched-final-delivery",
        getSessionName: () => controller.chatKey,
      },
      ensureSessionReady: async () => ({
        sessionFile: "/tmp/dispatched-final-delivery.jsonl",
        sessionId: "session-dispatched-final-delivery",
      }),
      prompt: async (_text, options = {}) => {
        await controller.handleSessionEvent({
          type: "extension_ui_request",
          method: "setWorkingVisible",
          visible: true,
        });
        await controller.handleSessionEvent({ type: "agent_start" });
        await controller.handleSessionEvent({
          type: "extension_ui_request",
          method: "setWorkingVisible",
          visible: false,
        });
        await controller.handleSessionEvent({ type: "agent_end" });
        emitRpcTurnComplete(controller, options, "done after upload");
      },
      switchSession: async () => {},
    };

    const turn = controller
      .runTurn({
        text: "hello",
        attachments: [],
        incomingMessageId: "m-dispatched-final",
        replyToMessageId: "m-dispatched-final",
      })
      .finally(() => {
        turnSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(turnSettled, false);
    assert.equal(
      controller.currentTurn?.incomingMessageId,
      "m-dispatched-final",
    );
    assert.equal(await controller.pollTyping(), false);
    assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
    assert.deepEqual(reactions, [
      ["create", "2", "m-dispatched-final", "🤔"],
      ["delete", "2", "m-dispatched-final", "🤔", "1"],
    ]);

    resolveDelivery(["m-final"]);
    const result = await turn;

    assert.equal(result.finalText, "done after upload");
    assert.equal(controller.currentTurn, null);
    assert.equal(controller.awaitingTurnSettle, false);
    assert.deepEqual(reactions, [
      ["create", "2", "m-dispatched-final", "🤔"],
      ["delete", "2", "m-dispatched-final", "🤔", "1"],
    ]);
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS;
    } else {
      process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS = previousTimeout;
    }
  }
});

test("chat controller uses adapter reaction capability for lark working indicators", async () => {
  const controller = await createController("lark/bot-1:chat-1");
  const reactions = [];
  let noticeSent = false;
  controller.app = {
    bots: [
      {
        platform: "lark",
        selfId: "bot-1",
        workingIndicators: [testReactionPollingIndicator(reactions, "bot-1")],
        async createReaction(chatId, messageId, emoji) {
          reactions.push(["create", chatId, messageId, emoji]);
        },
      },
    ],
  };
  controller.sendWorkingNotice = async function () {
    noticeSent = true;
    return true;
  };

  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-lark",
    workingNoticeSent: false,
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});
  controller.driver.frontendState.turnActive = true;
  controller.driver.frontendState.workingVisible = true;

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(reactions, [["create", "chat-1", "m-lark", "🤔"]]);
  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(reactions, [["create", "chat-1", "m-lark", "🤔"]]);
  controller.lastWorkingIndicatorAt -= 30_000;
  controller.lastWorkingReactionAt -= 30_000;
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(reactions, [
    ["create", "chat-1", "m-lark", "🤔"],
    ["create", "chat-1", "m-lark", "🔥"],
  ]);
  assert.equal(noticeSent, false);
});

test("chat controller uses discord typing and reaction capabilities together", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  const actions = [];
  const reactions = [];
  controller.app = {
    bots: [
      {
        platform: "discord",
        selfId: "bot-1",
        workingIndicators: [
          {
            type: "polling",
            async tick({ chatId, messageId }) {
              actions.push(["typing", chatId]);
              reactions.push(["create", chatId, messageId, "🤔"]);
              return true;
            },
          },
        ],
        internal: {
          async sendTyping(chatId) {
            actions.push(["typing", chatId]);
          },
          async createReaction(chatId, messageId, emoji) {
            reactions.push(["create", chatId, messageId, emoji]);
          },
        },
      },
    ],
  };

  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-discord",
    workingNoticeSent: false,
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});
  controller.driver.frontendState.turnActive = true;
  controller.driver.frontendState.workingVisible = true;

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [["typing", "channel-1"]]);
  assert.deepEqual(reactions, [["create", "channel-1", "m-discord", "🤔"]]);
  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(actions, [["typing", "channel-1"]]);
  controller.lastWorkingIndicatorAt -= 9_000;
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [
    ["typing", "channel-1"],
    ["typing", "channel-1"],
  ]);
});

test("chat controller logs failed discord typing without changing its cadence", async () => {
  const warnings = [];
  const controller = await createController("discord/bot-1:channel-1", {
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
    },
  });
  let typingAttempts = 0;
  let editableTicks = 0;
  controller.app = {
    bots: [
      {
        platform: "discord",
        selfId: "bot-1",
        workingIndicators: [
          {
            type: "polling",
            presentation: "editable-message",
            async tick() {
              editableTicks += 1;
              return true;
            },
          },
          {
            type: "polling",
            presentation: "typing",
            async tick() {
              typingAttempts += 1;
              if (typingAttempts === 1) {
                throw new Error("typing endpoint unavailable");
              }
              return true;
            },
          },
        ],
      },
    ],
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-discord-heartbeat",
    workingNoticeSent: false,
  };
  controller.driver.frontendState.turnActive = true;
  controller.driver.frontendState.workingVisible = true;

  const originalNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  try {
    assert.equal(await controller.pollTyping(), true);
    assert.equal(typingAttempts, 1);
    assert.equal(editableTicks, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /typing endpoint unavailable/);

    now += 8_999;
    assert.equal(await controller.pollTyping(), false);
    assert.equal(typingAttempts, 1);
    assert.equal(editableTicks, 1);

    now += 1;
    assert.equal(await controller.pollTyping(), true);
    assert.equal(typingAttempts, 2);
    assert.equal(editableTicks, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("chat controller starts typing immediately after creating editable progress", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  let typingTicks = 0;
  let editableTicks = 0;
  controller.app = {
    bots: [
      {
        platform: "discord",
        selfId: "bot-1",
        workingIndicators: [
          {
            type: "polling",
            presentation: "editable-message",
            async tick() {
              editableTicks += 1;
              return true;
            },
          },
          {
            type: "polling",
            presentation: "typing",
            async tick() {
              typingTicks += 1;
              return true;
            },
          },
        ],
      },
    ],
  };

  await controller.beginVisibleProcessingTurn({
    incomingMessageId: "m-discord-start",
  });
  assert.equal(editableTicks, 1);
  assert.equal(typingTicks, 0);

  controller.driver.frontendState.turnActive = true;
  controller.driver.frontendState.workingVisible = true;
  assert.equal(await controller.pollTyping(), true);
  assert.equal(typingTicks, 1);
  assert.equal(editableTicks, 1);
});

test("chat controller prioritizes reaction over marker while keeping typing independent", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  const calls: string[] = [];
  controller.app = {
    bots: [
      {
        platform: "discord",
        selfId: "bot-1",
        workingIndicators: [
          {
            type: "marker",
            presentation: "message",
            async start() {
              calls.push("marker:start");
              return true;
            },
          },
          {
            type: "polling",
            presentation: "reaction",
            async tick() {
              calls.push("reaction:tick");
              return true;
            },
            async end() {
              calls.push("reaction:end");
              return true;
            },
          },
          {
            type: "polling",
            presentation: "typing",
            async tick() {
              calls.push("typing:tick");
              return true;
            },
          },
        ],
      },
    ],
  };

  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-discord",
    workingNoticeSent: false,
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});
  controller.driver.frontendState.turnActive = true;
  controller.driver.frontendState.workingVisible = true;

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(calls, ["typing:tick", "reaction:tick"]);
  assert.equal(await controller.clearWorkingReaction(), true);
  assert.deepEqual(calls, ["typing:tick", "reaction:tick", "reaction:end"]);
});

test("chat controller combines backend progress identity with the steered turn fence", async () => {
  const controller = await createController();
  controller.driver.frontendState.workingVisible = true;
  const fence = {
    agentDir: controller.agentDir,
    turnId: "steered-turn",
    chatKey: controller.chatKey,
    messageId: "steered-message",
    ownerEpoch: "steered-owner",
    attempt: 1,
  };
  controller.rememberPendingSubmittedDeliveryTarget({
    incomingMessageId: "steered-message",
    replyToMessageId: "steered-message",
    text: "steer me",
    submittedText: "steer me",
    requestTag: "backend-active-tag",
    outboxTurnFence: fence,
  });
  let activated;
  controller.beginVisibleProcessingTurn = async (input) => {
    activated = input;
    controller.currentTurn = { ...input, startedAt: Date.now() };
    return true;
  };

  await controller.handleFrontendEvent({
    type: "user_message_start",
    text: "steer me",
    requestTag: "backend-active-tag",
  });

  assert.equal(activated.requestTag, "backend-active-tag");
  assert.equal(activated.outboxTurnFence, fence);
  assert.equal(controller.currentTurn.incomingMessageId, "steered-message");
});

test("chat controller disambiguates identical steers by producer request tag", async () => {
  const controller = await createController();
  controller.driver.frontendState.workingVisible = true;
  const firstFence = {
    agentDir: controller.agentDir,
    turnId: "first-steered-turn",
    chatKey: controller.chatKey,
    messageId: "first-steered-message",
    ownerEpoch: "first-steered-owner",
    attempt: 1,
  };
  const secondFence = {
    agentDir: controller.agentDir,
    turnId: "second-steered-turn",
    chatKey: controller.chatKey,
    messageId: "second-steered-message",
    ownerEpoch: "second-steered-owner",
    attempt: 1,
  };
  controller.rememberPendingSubmittedDeliveryTarget({
    incomingMessageId: "first-steered-message",
    text: "same steer",
    submittedText: "same steer",
    requestTag: "first-producer-tag",
    outboxTurnFence: firstFence,
  });
  controller.rememberPendingSubmittedDeliveryTarget({
    incomingMessageId: "second-steered-message",
    text: "same steer",
    submittedText: "same steer",
    requestTag: "second-producer-tag",
    outboxTurnFence: secondFence,
  });
  let activated;
  controller.beginVisibleProcessingTurn = async (input) => {
    activated = input;
    controller.currentTurn = { ...input, startedAt: Date.now() };
    return true;
  };

  await controller.handleFrontendEvent({
    type: "user_message_start",
    text: "same steer",
  });
  assert.equal(activated, undefined);
  assert.equal(
    controller.hasPendingSubmittedDeliveryTarget("first-steered-message"),
    true,
  );
  assert.equal(
    controller.hasPendingSubmittedDeliveryTarget("second-steered-message"),
    true,
  );

  await controller.handleFrontendEvent({
    type: "user_message_start",
    text: "same steer",
    requestTag: "second-producer-tag",
  });

  assert.equal(activated.requestTag, "second-producer-tag");
  assert.equal(activated.outboxTurnFence, secondFence);
  assert.equal(
    controller.hasPendingSubmittedDeliveryTarget("first-steered-message"),
    true,
  );
  assert.equal(
    controller.hasPendingSubmittedDeliveryTarget("second-steered-message"),
    false,
  );
});

test("chat controller rejects stale tagged assistant progress after turn replacement", async () => {
  const controller = await createController();
  const delivered = [];
  const accepted = [];
  controller.currentTurn = {
    incomingMessageId: "replacement",
    replyToMessageId: "replacement",
    requestTag: "replacement-tag",
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: "replacement-turn",
      chatKey: controller.chatKey,
      messageId: "replacement",
      ownerEpoch: "replacement-owner",
      attempt: 2,
    },
    startedAt: Date.now(),
  };
  assert.equal(
    controller.ownsOutboxTurnFence({
      agentDir: controller.agentDir,
      turnId: "replacement-turn",
      chatKey: controller.chatKey,
      messageId: "replacement",
      ownerEpoch: "expired-owner",
      attempt: 1,
    }),
    false,
  );
  assert.equal(
    controller.ownsOutboxTurnFence(controller.currentTurn.outboxTurnFence),
    true,
  );
  controller.deliverAssistantInterim = async (text) => {
    delivered.push(text);
  };
  controller.markAcceptedMessage = (messageId) => {
    accepted.push(messageId);
  };

  await controller.handleFrontendEvent({
    type: "assistant_interim",
    text: "stale interim",
    requestTag: "expired-tag",
  });
  await controller.handleFrontendEvent({
    type: "assistant_interim",
    text: "Pi-native untagged interim",
  });
  await controller.handleFrontendEvent({
    type: "assistant_interim",
    text: "current interim",
    requestTag: "replacement-tag",
  });
  await controller.handleFrontendEvent({
    type: "turn_accepted",
    requestTag: "expired-tag",
  });
  await controller.handleFrontendEvent({
    type: "frontend_status",
    phase: "working",
  });
  assert.deepEqual(accepted, []);
  await controller.handleFrontendEvent({
    type: "turn_accepted",
    requestTag: "replacement-tag",
  });
  assert.deepEqual(delivered, [
    "Pi-native untagged interim",
    "current interim",
  ]);
  assert.deepEqual(accepted, ["replacement"]);
});

test("chat controller does not deliver text-only assistant messages as interim", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `… ${text}`,
      replyToMessageId: this.currentReplyToMessageId(),
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery),
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-interim",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "interim-chat.jsonl",
  );
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-interim",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-interim",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will check this" }],
        },
      });
      emitRpcTurnComplete(controller, options, "Final answer");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-interim",
    replyToMessageId: "m-interim",
  });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(deliveries, [
    { text: "Final answer", replyToMessageId: "m-interim" },
  ]);
});

test("chat controller restores inbound reply identity before connect replays an interim", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `… ${text}`,
      replyToMessageId: this.currentReplyToMessageId() || null,
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery) || null,
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "restart-interim-chat.jsonl",
  );
  saveChatMessage(controller.agentDir, {
    chatKey: controller.chatKey,
    platform: "discord",
    botId: "bot-1",
    chatId: "channel-1",
    chatType: "group",
    messageId: "m-restarted-turn",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "resume after restart",
  });
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-restart-interim",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-restart-interim",
    }),
    prompt: async (_text, options = {}) => {
      await emitRpcTurnComplete(controller, options, "Final answer");
    },
    switchSession: async () => {},
  };
  controller.connect = async () => {
    await controller.handleFrontendEvent({
      type: "assistant_interim",
      text: "Recovered progress",
    });
  };

  const result = await controller.runTurn({
    text: "resume after restart",
    attachments: [],
    incomingMessageId: "m-restarted-turn",
    replyToMessageId: "m-restarted-turn",
  });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(deliveries, [
    { text: "… Recovered progress", replyToMessageId: "m-restarted-turn" },
    { text: "Final answer", replyToMessageId: "m-restarted-turn" },
  ]);
});

test("chat controller restores durable ownership over an earlier display-only Working turn", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `… ${text}`,
      replyToMessageId: this.currentReplyToMessageId() || null,
    });
    return true;
  };
  controller.driver.hasActiveTurn = () => true;
  await controller.beginExternalWorking();
  assert.equal(controller.currentTurn?.outboxTurnFence, undefined);
  controller.connect = async () => {
    await controller.handleFrontendEvent({
      type: "assistant_interim",
      text: "Recovered after early Working",
    });
    return true;
  };
  controller.driver.runTurn = async () => ({
    finalText: "Steered into the recovered turn",
  });

  const result = await controller.runTurn({
    text: "resume durable turn with early Working",
    attachments: [],
    incomingMessageId: "m-early-working",
    replyToMessageId: "m-early-working",
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: "turn-early-working",
      chatKey: controller.chatKey,
      messageId: "m-early-working",
      ownerEpoch: "owner-early-working",
      attempt: 2,
    },
  });

  assert.equal(result.superseded, true);
  assert.deepEqual(deliveries, [
    {
      text: "… Recovered after early Working",
      replyToMessageId: "m-early-working",
    },
  ]);
  assert.equal(
    controller.currentTurn?.outboxTurnFence?.turnId,
    "turn-early-working",
  );
  await controller.clearProcessingState();
});

test("chat controller keeps recovered durable turn ownership when backend Working ends during connect", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `… ${text}`,
      replyToMessageId: this.currentReplyToMessageId() || null,
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery) || null,
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };
  controller.connect = async () => {
    await controller.beginExternalWorking();
    await controller.endExternalWorking();
    await controller.handleFrontendEvent({
      type: "assistant_interim",
      text: "Recovered progress after Working ended",
    });
    return true;
  };
  controller.driver.runTurn = async () => ({
    finalText: "Recovered final",
  });

  const result = await controller.runTurn({
    text: "resume durable turn after daemon restart",
    attachments: [],
    incomingMessageId: "m-durable-restart",
    replyToMessageId: "m-durable-restart",
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: "turn-durable-restart",
      chatKey: controller.chatKey,
      messageId: "m-durable-restart",
      ownerEpoch: "owner-durable-restart",
      attempt: 2,
    },
  });

  assert.equal(result.finalText, "Recovered final");
  assert.deepEqual(deliveries, [
    {
      text: "… Recovered progress after Working ended",
      replyToMessageId: "m-durable-restart",
    },
    { text: "Recovered final", replyToMessageId: "m-durable-restart" },
  ]);
  assert.equal(controller.currentTurn, null);
});

test("chat controller waits for backend Working after a cold connection", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  const calls: string[] = [];
  let releaseConnect!: () => void;
  const connectMayFinish = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  let markConnectStarted!: () => void;
  const connectStarted = new Promise<void>((resolve) => {
    markConnectStarted = resolve;
  });
  controller.app = {
    bots: [
      {
        platform: "discord",
        selfId: "bot-1",
        workingIndicators: [
          {
            type: "polling",
            presentation: "editable-message",
            async tick(context) {
              calls.push(`working:${context?.replyToMessageId}`);
              return true;
            },
          },
        ],
      },
    ],
  };
  controller.connect = async () => {
    calls.push("connect");
    markConnectStarted();
    await connectMayFinish;
    return true;
  };
  controller.driver.runTurn = async () => {
    await controller.handleSessionEvent({
      type: "extension_ui_request",
      method: "setWorkingVisible",
      visible: true,
    });
    calls.push("prompt");
    await controller.handleSessionEvent({
      type: "extension_ui_request",
      method: "setWorkingVisible",
      visible: false,
    });
    return { finalText: "ok" };
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    calls.push("final");
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  const turn = controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-cold-connect",
    replyToMessageId: "m-cold-connect",
  });
  await connectStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["connect"]);

  releaseConnect();
  const result = await turn;

  assert.equal(result.finalText, "ok");
  assert.deepEqual(calls, [
    "connect",
    "working:m-cold-connect",
    "prompt",
    "final",
  ]);
});

test("chat controller does not synthesize Working when a cold connection fails", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  const calls: string[] = [];
  controller.app = {
    bots: [
      {
        platform: "discord",
        selfId: "bot-1",
        workingIndicators: [
          {
            type: "polling",
            presentation: "editable-message",
            async tick() {
              calls.push("working");
              return true;
            },
          },
        ],
      },
    ],
  };
  controller.connect = async () => {
    calls.push("connect");
    throw new Error("connect failed");
  };

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-connect-failed-no-working",
      replyToMessageId: "m-connect-failed-no-working",
    }),
    /connect failed/,
  );

  assert.deepEqual(calls, ["connect"]);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
});

test("chat controller keeps Working absent while a cold connection later fails", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  const calls: string[] = [];
  let releaseConnect!: () => void;
  const connectMayFail = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  controller.app = {
    bots: [
      {
        platform: "discord",
        selfId: "bot-1",
        workingIndicators: [
          {
            type: "polling",
            presentation: "editable-message",
            async tick() {
              calls.push("working");
              return true;
            },
          },
        ],
      },
    ],
  };
  controller.connect = async () => {
    calls.push("connect");
    await connectMayFail;
    throw new Error("connect failed later");
  };

  const turn = controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-connect-failed-later",
    replyToMessageId: "m-connect-failed-later",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["connect"]);
  releaseConnect();
  await assert.rejects(turn, /connect failed later/);

  assert.deepEqual(calls, ["connect"]);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
});

test("chat controller clears a primed reply identity when connect fails", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  let visibleStarts = 0;
  controller.beginVisibleProcessingTurn = async () => {
    visibleStarts += 1;
  };
  controller.connect = async () => {
    throw new Error("connect failed");
  };

  await assert.rejects(
    () =>
      controller.runTurn({
        text: "resume after restart",
        attachments: [],
        incomingMessageId: "m-connect-failed",
        replyToMessageId: "m-connect-failed",
      }),
    /connect failed/,
  );

  assert.equal(visibleStarts, 0);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
});

test("chat controller delivers leading tool-call text as the only interim source", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `… ${text}`,
      replyToMessageId: this.currentReplyToMessageId(),
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery),
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-tool-interim",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "tool-interim-chat.jsonl",
  );
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-tool-interim",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-tool-interim",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will check this" },
            { type: "toolCall", name: "read", id: "call-1" },
            { type: "text", text: "not interim" },
          ],
        },
      });
      assert.deepEqual(deliveries, [
        { text: "… I will check this", replyToMessageId: "m-tool-interim" },
      ]);
      await controller.handleSessionEvent({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
      });
      emitRpcTurnComplete(controller, options, "Final answer");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-tool-interim",
    replyToMessageId: "m-tool-interim",
  });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(deliveries, [
    { text: "… I will check this", replyToMessageId: "m-tool-interim" },
    { text: "Final answer", replyToMessageId: "m-tool-interim" },
  ]);
});

test("chat controller treats delivered interim assistant text as an inbound reply boundary", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  let sendCount = 0;
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          sendCount += 1;
          return [`assistant-${sendCount}`];
        },
        async createReaction() {},
        async deleteReaction() {},
        internal: {
          async sendChatAction() {},
        },
      },
    ],
  };

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "interim-boundary-chat.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "", "utf8");
  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-interim-boundary",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-interim-boundary",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-interim-boundary",
    }),
    prompt: async () => {
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will check this" },
            { type: "toolCall", name: "read", id: "call-1" },
          ],
        },
      });
      await controller.handleSessionEvent({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
      });
      throw new Error("chat_controller_disposed");
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-interim-boundary",
      replyToMessageId: "m-interim-boundary",
    }),
    /chat_controller_disposed/,
  );
  await new Promise((resolve) => setImmediate(resolve));

  const inbound = getChatMessage(
    controller.agentDir,
    chatKey,
    "m-interim-boundary",
  );
  const assistant = getChatMessage(controller.agentDir, chatKey, "assistant-1");
  assert.ok(inbound?.acceptedAt);
  assert.equal(inbound?.processedAt, undefined);
  assert.equal(inbound?.sessionFile, "interim-boundary-chat.jsonl");
  assert.equal(assistant?.role, "assistant");
  assert.equal(assistant?.replyToMessageId, "m-interim-boundary");
  assert.equal(assistant?.text, "... I will check this");
  assert.equal(assistant?.sessionFile, "interim-boundary-chat.jsonl");
});

test("chat controller does not treat assistant message updates as interim when a tool boundary follows", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `… ${text}`,
      replyToMessageId: this.currentReplyToMessageId(),
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery),
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-update",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "interim-update-chat.jsonl",
  );
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-interim-update",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-interim-update",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will check this" }],
        },
      });
      await controller.handleSessionEvent({
        type: "tool_execution_start",
        toolName: "read",
      });
      emitRpcTurnComplete(controller, options, "Final answer");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-update",
    replyToMessageId: "m-update",
  });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(deliveries, [
    { text: "Final answer", replyToMessageId: "m-update" },
  ]);
});

test("chat controller does not leak a buffered preview as interim before the final reply", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `… ${text}`,
      replyToMessageId: this.currentReplyToMessageId(),
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery),
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-preview",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "interim-preview-chat.jsonl",
  );
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-interim-preview",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-interim-preview",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will check this" }],
        },
      });
      emitRpcTurnComplete(controller, options, "Final answer");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-preview",
    replyToMessageId: "m-preview",
  });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(deliveries, [
    { text: "Final answer", replyToMessageId: "m-preview" },
  ]);
});

test("chat controller does not emit growing final-answer prefixes as interim replies", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `… ${text}`,
      replyToMessageId: this.currentReplyToMessageId(),
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery),
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-prefixes",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "interim-prefixes-chat.jsonl",
  );
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-interim-prefixes",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-interim-prefixes",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      for (const text of ["I", "I will", "I will check", "I will check this"]) {
        await controller.handleSessionEvent({
          type: "message_update",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
          },
        });
      }
      emitRpcTurnComplete(
        controller,
        options,
        "I will check this; here are the results",
      );
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-prefixes",
    replyToMessageId: "m-prefixes",
  });

  assert.equal(result.finalText, "I will check this; here are the results");
  assert.deepEqual(deliveries, [
    {
      text: "I will check this; here are the results",
      replyToMessageId: "m-prefixes",
    },
  ]);
});

test("chat controller uses no implicit Working notice for onebot private chats", async () => {
  const controller = await createController("onebot/1:private:2");
  const deliveries = [];
  controller.sendWorkingNotice = async function () {
    if (this.currentTurn?.workingNoticeSent) return false;
    deliveries.push({
      replyToMessageId: this.currentTurn?.incomingMessageId,
      text: "Working...",
    });
    if (this.currentTurn) this.currentTurn.workingNoticeSent = true;
    return true;
  };

  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m1",
    workingNoticeSent: false,
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});

  assert.equal(await controller.pollTyping(), false);
  assert.equal(await controller.pollTyping(), false);
  assert.equal(controller.currentTurn.workingNoticeSent, false);
  assert.deepEqual(deliveries, []);
});

test("chat controller treats a stale working frontend phase as a new onebot private prompt", async () => {
  const controller = await createController("onebot/1:private:2");
  const deliveries = [];
  const promptCalls = [];
  controller.app = {
    bots: [
      {
        platform: "onebot",
        selfId: "1",
        async sendMessage(chatId, content) {
          deliveries.push({ chatId, content });
          return [`out-${deliveries.length}`];
        },
      },
    ],
  };
  controller.driver.frontendPhase = "working";

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/stale-working-chat.jsonl",
      getSessionId: () => "session-stale-working",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/stale-working-chat.jsonl",
      sessionId: "session-stale-working",
    }),
    prompt: async (_text, options = {}) => {
      promptCalls.push({ streamingBehavior: options.streamingBehavior });
      await new Promise((resolve) => setImmediate(resolve));
      emitRpcTurnComplete(controller, options, "ok");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn(
    {
      text: "new prompt",
      attachments: [],
      incomingMessageId: "m-new-onebot",
      replyToMessageId: "m-new-onebot",
    },
    "steer",
  );

  assert.equal(result.finalText, "ok");
  assert.deepEqual(promptCalls, [{ streamingBehavior: undefined }]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].chatId, "private:2");
  assert.deepEqual(deliveries[0].content, [
    { type: "quote", attrs: { id: "m-new-onebot" } },
    { type: "markdown", attrs: { content: "ok" } },
  ]);
});

test("chat controller sends no onebot Working notice when polls overlap", async () => {
  const controller = await createController("onebot/1:private:2");
  const deliveries = [];
  let releaseDelivery;
  const deliveryGate = new Promise((resolve) => {
    releaseDelivery = resolve;
  });
  controller.app = {
    bots: [
      {
        platform: "onebot",
        selfId: "1",
        async sendMessage(chatId, content) {
          deliveries.push({ chatId, content });
          await deliveryGate;
          return [`out-${deliveries.length}`];
        },
      },
    ],
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-overlap",
    workingNoticeSent: false,
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});

  const firstPoll = controller.pollTyping();
  const secondPoll = controller.pollTyping();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(deliveries.length, 0);
  releaseDelivery();
  assert.deepEqual(await Promise.all([firstPoll, secondPoll]), [false, false]);
  assert.equal(controller.currentTurn.workingNoticeSent, false);
});

test("chat controller ignores dynamic onebot private working actions without explicit marker", async () => {
  const controller = await createController("onebot/1:private:2");
  const deliveries = [];
  const internalActions = [];
  controller.app = {
    bots: [
      {
        platform: "onebot",
        selfId: "1",
        async sendMessage(chatId, content) {
          deliveries.push({ chatId, content });
          return [`out-${deliveries.length}`];
        },
        internal: new Proxy(
          {},
          {
            get(_target, property) {
              if (typeof property !== "string") return undefined;
              return async (...args) => {
                internalActions.push([property, ...args]);
              };
            },
          },
        ),
      },
    ],
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-private",
    workingNoticeSent: false,
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});

  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(internalActions, []);
  assert.deepEqual(deliveries, []);
});

test("chat controller does not type from local live turn state without worker activity", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        workingIndicators: [testPollingIndicator(actions, [])],
        internal: {
          async sendChatAction(payload) {
            actions.push(payload);
          },
        },
      },
    ],
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-local",
    workingNoticeSent: false,
  };
  controller.awaitingTurnSettle = true;
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});

  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(actions, []);
});

test("chat controller does not keep typing from stale currentTurn metadata alone", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        workingIndicators: [testPollingIndicator(actions, reactions)],
        async createReaction(chatId, messageId, emoji) {
          reactions.push(["create", chatId, messageId, emoji]);
        },
        async deleteReaction(chatId, messageId, emoji, userId) {
          reactions.push(["delete", chatId, messageId, emoji, userId]);
        },
        internal: {
          async sendChatAction(payload) {
            actions.push(payload);
          },
        },
      },
    ],
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-stale",
    workingNoticeSent: false,
  };

  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(actions, []);
  assert.deepEqual(reactions, []);
});

test("chat controller does not keep ordinary typing from standalone remote-working states", async () => {
  for (const state of [{ isCompacting: true }, { sessionRecovering: true }]) {
    const controller = await createController("telegram/1:2");
    const actions = [];
    controller.app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          workingIndicators: [testPollingIndicator(actions, [])],
          internal: {
            async sendChatAction(payload) {
              actions.push(payload);
            },
          },
        },
      ],
    };
    controller.currentTurn = {
      startedAt: Date.now(),
      incomingMessageId: "m-remote-state",
      workingNoticeSent: false,
    };
    Object.assign(controller.driver.frontendState, state);

    assert.equal(await controller.pollTyping(), false);
    assert.deepEqual(actions, []);
  }
});

test("chat typing and reactions follow only backend working visibility", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        workingIndicators: [testPollingIndicator(actions, reactions)],
        async createReaction(chatId, messageId, emoji) {
          reactions.push(["create", chatId, messageId, emoji]);
        },
        async deleteReaction(chatId, messageId, emoji, userId) {
          reactions.push(["delete", chatId, messageId, emoji, userId]);
        },
        internal: {
          async sendChatAction(payload) {
            actions.push(payload);
          },
        },
      },
    ],
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-backend-working",
    workingNoticeSent: false,
  };
  controller.awaitingTurnSettle = true;
  controller.driver.frontendState.turnActive = true;
  controller.driver.frontendState.isStreaming = true;

  assert.equal(await controller.pollTyping(), false);

  await controller.handleSessionEvent({
    type: "extension_ui_request",
    method: "setWorkingVisible",
    visible: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.externalWorkingVisible, true);

  await controller.handleSessionEvent({
    type: "extension_ui_request",
    method: "setWorkingVisible",
    visible: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [
    ["create", "2", "m-backend-working", "🤔"],
    ["delete", "2", "m-backend-working", "🤔", "1"],
  ]);
});

test("chat controller clears the working reaction before dropping processing state", async () => {
  const controller = await createController("telegram/1:2");
  const reactions = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        workingIndicators: [testReactionPollingIndicator(reactions)],
        async deleteReaction(chatId, messageId, emoji, userId) {
          reactions.push(["delete", chatId, messageId, emoji, userId]);
        },
        internal: {
          async sendChatAction() {},
        },
      },
    ],
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-finished",
    workingNoticeSent: false,
  };
  controller.activeWorkingIndicators = [
    {
      type: "polling",
      async end({ chatId, messageId }) {
        reactions.push(["delete", chatId, messageId, "🤔", "1"]);
        return true;
      },
    },
  ];
  controller.workingReactionEmoji = "🤔";
  controller.workingReactionTick = 1;
  controller.lastWorkingReactionAt = Date.now();
  controller.awaitingTurnSettle = true;
  controller.stagedDelivery = {
    chatKey: controller.chatKey,
    parts: [{ type: "text", text: "pending" }],
  };

  await controller.clearProcessingState();

  assert.deepEqual(reactions, [["delete", "2", "m-finished", "🤔", "1"]]);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.workingReactionEmoji, "");
  assert.equal(controller.workingReactionTick, 0);
  assert.equal(controller.lastWorkingReactionAt, 0);
  assert.equal(controller.awaitingTurnSettle, false);
  assert.equal(controller.stagedDelivery, null);
});

test("chat controller treats rpc completion as the canonical final reply for prompt turns", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery),
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-turn",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "prompt-chat.jsonl",
  );
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-prompt",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-prompt",
    }),
    prompt: async (_text, options = {}) => {
      controller.handleSessionEvent({ type: "agent_start" });
      const during = getChatMessage(controller.agentDir, chatKey, "m-turn");
      assert.ok(during?.acceptedAt);
      assert.equal(during?.processedAt, undefined);
      let persistedDuringTurn = {};
      try {
        persistedDuringTurn = JSON.parse(
          await fs.readFile(controller.statePath, "utf8"),
        );
      } catch {}
      assert.equal(persistedDuringTurn.sessionFile, "prompt-chat.jsonl");
      controller.session.messages = [
        {
          role: "assistant",
          content: [{ type: "text", text: "history text" }],
        },
      ];
      emitRpcTurnComplete(controller, options, "canonical final", {
        messages: [{ type: "text", text: "result final" }],
      });
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-turn",
    replyToMessageId: "m-turn",
  });

  assert.equal(result.finalText, "canonical final");
  assert.deepEqual(deliveries, [
    { text: "canonical final", replyToMessageId: "m-turn" },
  ]);
  const stored = getChatMessage(controller.agentDir, chatKey, "m-turn");
  assert.ok(stored?.acceptedAt);
  assert.ok(stored?.processedAt);
  assert.equal(stored?.sessionFile, "prompt-chat.jsonl");
  assert.equal(controller.state.sessionFile, "prompt-chat.jsonl");
});

test("chat controller sends a session-file prompt through conversation binding", async () => {
  const controller = await createController("telegram/1:2");
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "scheduled.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "session", "utf8");
  const switches = [];
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-scheduled",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-scheduled",
    }),
    prompt: async (_text, options = {}) => {
      emitRpcTurnComplete(controller, options, "scheduled final", {
        messages: [{ type: "text", text: "scheduled final" }],
      });
    },
    switchSession: async (nextSessionFile) => {
      switches.push(nextSessionFile);
    },
  };

  const result = await controller.runTurn({
    text: "scheduled instruction",
    attachments: [],
    sessionFile,
    promptMeta: {
      source: "scheduled-task",
      taskId: "cron_current_session",
    },
  });

  assert.equal(result.finalText, "scheduled final");
  assert.deepEqual(switches, [sessionFile]);
  const delivered = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "m1",
  );
  assert.equal(delivered?.text, "scheduled final");
  assert.equal(delivered?.sessionFile, "managed/chat/scheduled.jsonl");
  assert.equal(controller.state.sessionFile, "managed/chat/scheduled.jsonl");
});

test("chat controller can run a session-file prompt without final delivery", async () => {
  const controller = await createController("telegram/1:2");
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "silent-scheduled.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "session", "utf8");
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-silent-scheduled",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-silent-scheduled",
    }),
    prompt: async (_text, options = {}) => {
      emitRpcTurnComplete(controller, options, "silent final", {
        messages: [{ type: "text", text: "silent final" }],
      });
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "scheduled instruction",
    attachments: [],
    sessionFile,
    deliverFinal: false,
    promptMeta: {
      source: "scheduled-task",
      taskId: "cron_silent_current_session",
    },
  });

  assert.equal(result.finalText, "silent final");
  const delivered = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "m1",
  );
  assert.equal(delivered, null);
  assert.equal(
    controller.state.sessionFile,
    "managed/chat/silent-scheduled.jsonl",
  );
});

test("chat controller delivers prompt turn errors through conversation binding", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "failed-turn-chat.jsonl",
  );

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-failed-turn",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-failed-turn",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "rpc_turn_event",
          event: "start",
          requestTag: options.requestTag,
          sessionFile,
          sessionId: "session-failed-turn",
        },
      });
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "rpc_turn_event",
          event: "error",
          requestTag: options.requestTag,
          error: "provider unavailable",
          sessionFile,
          sessionId: "session-failed-turn",
        },
      });
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-failed-turn",
      replyToMessageId: "m-failed-turn",
    }),
    /provider unavailable/,
  );

  const assistantError = getChatMessage(controller.agentDir, chatKey, "m1");
  assert.equal(assistantError?.text, "rin error: provider unavailable");
  assert.equal(assistantError?.replyToMessageId, "m-failed-turn");
  assert.equal(assistantError?.sessionFile, "failed-turn-chat.jsonl");
  assert.equal(controller.state.sessionFile, "failed-turn-chat.jsonl");
});

test("chat controller drains the actual row returned by same-key adoption", async () => {
  const controller = await createController("telegram/1:2");
  const payload = {
    createdAt: new Date().toISOString(),
    chatKey: controller.chatKey,
    parts: [{ type: "text", text: "adopted controller answer" }],
  };
  const existingId = enqueueChatOutboxPayload(controller.agentDir, payload, {
    id: "existing-controller-outbox",
    idempotencyKey: "controller-shared-key",
    deliveryKind: "final",
  });

  const outcome = await controller.enqueueAndDrainDelivery(payload, {
    id: "requested-controller-outbox",
    idempotencyKey: "controller-shared-key",
    deliveryKind: "final",
    requireDelivery: true,
    waitUntilDeliverySettled: true,
  });

  assert.deepEqual(outcome.messageIds, ["m1"]);
  assert.equal(
    readChatOutboxItemById(controller.agentDir, existingId).item.status,
    "delivered",
  );
  assert.equal(
    readChatOutboxItemById(controller.agentDir, "requested-controller-outbox"),
    null,
  );
});

test("chat controller validates missing media before terminal outbox commit", async () => {
  const controller = await createController("telegram/1:2");
  const inbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "missing-media-inbound",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "missing-media-inbound",
      content: "send missing media",
      stripped: { content: "send missing media" },
    },
    elements: [{ type: "text", attrs: { content: "send missing media" } }],
  }).item;
  const claim = claimChatInboxItem(controller.agentDir, inbound.itemId);
  const fence = {
    agentDir: controller.agentDir,
    turnId: claim.itemId,
    chatKey: claim.chatKey,
    messageId: claim.messageId,
    ownerEpoch: claim.ownerEpoch,
    attempt: claim.attemptCount,
  };

  await assert.rejects(
    () =>
      controller.deliverAssistantReply({
        parts: [{ type: "image", path: "/definitely/missing/image.png" }],
        incomingMessageId: claim.messageId,
        replyToMessageId: claim.messageId,
        outboxTurnFence: fence,
      }),
    /chat_outbox_media_missing:image/,
  );
  assert.equal(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT state FROM turns WHERE turn_id = ?`)
      .get(claim.itemId).state,
    "running",
  );
  assert.equal(listChatOutboxItems(controller.agentDir).length, 0);

  await controller.deliverAssistantReply({
    text: "Could not attach that file.",
    incomingMessageId: claim.messageId,
    replyToMessageId: claim.messageId,
    outboxTurnFence: fence,
    deliveryKind: "error",
  });
  assert.equal(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT state FROM turns WHERE turn_id = ?`)
      .get(claim.itemId).state,
    "terminal",
  );
});

test("chat controller keeps confirmed pre-dispatch failure recoverable", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-send-fail",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });
  controller.app.bots[0].sendMessage = () =>
    rejectedBeforeDispatch("send failed");
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/send-fail-chat.jsonl",
      getSessionId: () => "session-send-fail",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/send-fail-chat.jsonl",
      sessionId: "session-send-fail",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      emitRpcTurnComplete(controller, options, "final that cannot be sent");
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    () =>
      controller.runTurn({
        text: "hello",
        attachments: [],
        incomingMessageId: "m-send-fail",
        replyToMessageId: "m-send-fail",
      }),
    /send failed/,
  );

  const stored = getChatMessage(controller.agentDir, chatKey, "m-send-fail");
  const [queued] = listChatOutboxItems(controller.agentDir).map(
    ({ item }) => item,
  );
  assert.ok(stored?.acceptedAt);
  assert.equal(stored?.processedAt, undefined);
  assert.equal(queued.status, "queued");
});

test("chat controller durably commits a final when the adapter disappears", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-bot-disappeared",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/bot-disappeared.jsonl",
      getSessionId: () => "session-bot-disappeared",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/bot-disappeared.jsonl",
      sessionId: "session-bot-disappeared",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      controller.app.bots = [];
      emitRpcTurnComplete(controller, options, "durable missing-bot final");
    },
    switchSession: async () => {},
  };

  await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-bot-disappeared",
    replyToMessageId: "m-bot-disappeared",
  });

  const stored = getChatMessage(
    controller.agentDir,
    chatKey,
    "m-bot-disappeared",
  );
  assert.equal(stored?.processedAt, undefined);
  const queued = listChatOutboxItems(controller.agentDir).find(
    ({ item }) => item.deliveryKind === "final",
  )?.item;
  assert.ok(queued);
  assert.equal(queued.status, "queued");
  assert.equal(queued.attempts, 0);
  assert.equal(queued.lastError, undefined);
  assert.equal(
    queued.postDelivery.markProcessed.messageId,
    "m-bot-disappeared",
  );
});

test("chat controller keeps the turn active while final reply delivery is still in flight", async () => {
  const previousTimeout = process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS;
  process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS = "20";
  try {
    const controller = await createController("telegram/1:2");
    const chatKey = "telegram/1:2";
    saveChatMessage(controller.agentDir, {
      chatKey,
      platform: "telegram",
      botId: "1",
      chatId: "2",
      chatType: "private",
      messageId: "m-timeout-send",
      role: "user",
      receivedAt: new Date().toISOString(),
      text: "hello",
    });
    let resolveDelivery;
    controller.app.bots[0].sendMessage = () =>
      new Promise((resolve) => {
        resolveDelivery = resolve;
      });
    controller.session = {
      isStreaming: false,
      messages: [],
      sessionManager: {
        getSessionFile: () => "/tmp/send-timeout-chat.jsonl",
        getSessionId: () => "session-send-timeout",
        getSessionName: () => chatKey,
      },
      ensureSessionReady: async () => ({
        sessionFile: "/tmp/send-timeout-chat.jsonl",
        sessionId: "session-send-timeout",
      }),
      prompt: async (_text, options = {}) => {
        await controller.handleSessionEvent({ type: "agent_start" });
        emitRpcTurnComplete(controller, options, "final pending delivery");
      },
      switchSession: async () => {},
    };

    let turnSettled = false;
    const turn = controller
      .runTurn({
        text: "hello",
        attachments: [],
        incomingMessageId: "m-timeout-send",
        replyToMessageId: "m-timeout-send",
      })
      .finally(() => {
        turnSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(turnSettled, false);
    assert.equal(controller.currentTurn?.incomingMessageId, "m-timeout-send");
    let stored = getChatMessage(controller.agentDir, chatKey, "m-timeout-send");
    assert.ok(stored?.acceptedAt);
    assert.equal(stored?.processedAt, undefined);

    resolveDelivery(["m-final-timeout"]);
    const result = await turn;

    assert.equal(result.finalText, "final pending delivery");
    assert.equal(controller.currentTurn, null);
    assert.equal(controller.awaitingTurnSettle, false);
    stored = getChatMessage(controller.agentDir, chatKey, "m-timeout-send");
    assert.ok(stored?.processedAt);
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS;
    } else {
      process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS = previousTimeout;
    }
  }
});

test("chat controller settles an empty rpc completion without reusing observed assistant text", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery),
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/rpc-result-chat.jsonl",
      getSessionId: () => "session-rpc-result",
      getSessionName: () => "telegram/1:2",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/rpc-result-chat.jsonl",
      sessionId: "session-rpc-result",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "observed completed text" }],
        },
      });
      emitRpcTurnComplete(controller, options, "", { messages: [] });
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-turn-observed-final",
    replyToMessageId: "m-turn-observed-final",
  });
  assert.equal(result.finalText, "");
  assert.deepEqual(deliveries, []);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
  assert.equal(await controller.pollTyping(), false);
});

test("chat controller settles an empty rpc completion without scanning session messages", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery),
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  const sessionMessages: any[] = [];
  controller.session = {
    isStreaming: false,
    messages: sessionMessages,
    sessionManager: {
      getSessionFile: () => "/tmp/rpc-result-chat.jsonl",
      getSessionId: () => "session-rpc-result",
      getSessionName: () => "telegram/1:2",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/rpc-result-chat.jsonl",
      sessionId: "session-rpc-result",
    }),
    prompt: async (_text, options = {}) => {
      sessionMessages.push(
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "canonical session text" }],
        },
      );
      controller.handleSessionEvent({ type: "agent_start" });
      emitRpcTurnComplete(controller, options, "", { messages: [] });
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-turn-empty-final",
    replyToMessageId: "m-turn-empty-final",
  });
  assert.equal(result.finalText, "");
  assert.deepEqual(deliveries, []);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
  assert.equal(await controller.pollTyping(), false);
});

test("chat controller switches to a linked reply session before sending the prompt", async () => {
  const controller = await createController("telegram/1:2");
  const operations = [];
  const linkedSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "reply-linked.jsonl",
  );

  await fs.mkdir(path.dirname(linkedSessionFile), { recursive: true });
  await fs.writeFile(linkedSessionFile, "{}\n", "utf8");

  controller.commitPendingDelivery = async function (clearProcessing = false) {
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  let currentSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "current-chat.jsonl",
  );

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => currentSessionFile,
      getSessionId: () => "session-linked",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => {
      operations.push("ensureSessionReady");
      return { sessionFile: linkedSessionFile, sessionId: "session-linked" };
    },
    switchSession: async (sessionFile) => {
      operations.push(`switchSession:${sessionFile}`);
      currentSessionFile = sessionFile;
    },
    prompt: async (_text, options = {}) => {
      operations.push("prompt");
      emitRpcTurnComplete(controller, options, "continued there");
    },
  };

  await controller.runTurn({
    text: "continue",
    attachments: [],
    sessionFile: linkedSessionFile,
  });

  assert.deepEqual(operations, [
    `switchSession:${linkedSessionFile}`,
    "ensureSessionReady",
    "prompt",
  ]);
  assert.equal(controller.state.sessionFile, "reply-linked.jsonl");
});

test("chat controller submits ordinary input unchanged to an already active backend", async () => {
  const controller = await createController("telegram/1:2");
  const promptCalls = [];

  controller.driver.frontendState = { isStreaming: true };
  controller.session = {
    isStreaming: true,
    sessionManager: {
      getSessionFile: () => "/tmp/live-chat.jsonl",
      getSessionId: () => "session-live",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/live-chat.jsonl",
      sessionId: "session-live",
    }),
    prompt: async (text, options = {}) => {
      promptCalls.push({ text, streamingBehavior: options.streamingBehavior });
      emitRpcTurnComplete(controller, options, "active backend final");
      return { acceptedAs: "steer" };
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "follow up",
    attachments: [],
    incomingMessageId: "m-steer",
  });

  assert.deepEqual(promptCalls, [
    { text: "follow up", streamingBehavior: undefined },
  ]);
  assert.equal(result.finalText, "active backend final");
});

test("chat controller lets ordinary input reach Pi while the current turn is still active", async () => {
  const controller = await createController("telegram/1:2");
  const promptCalls = [];
  const deliveries = [];
  let releaseFirstPrompt = () => {};
  let firstRequestTag = "";
  let resolveFirstPromptStarted = () => {};
  const firstPromptStarted = new Promise((resolve) => {
    resolveFirstPromptStarted = resolve;
  });

  controller.commitPendingDelivery = async function (
    clearProcessing = false,
    postDelivery = undefined,
  ) {
    deliveries.push({
      text: deliveryText(this.stagedDelivery),
      replyToMessageId: deliveryQuoteId(this.stagedDelivery) || null,
      markProcessedMessageId: postDelivery?.markProcessed?.messageId || null,
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/live-chat.jsonl",
      getSessionId: () => "session-live",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/live-chat.jsonl",
      sessionId: "session-live",
    }),
    prompt: async (text, options = {}) => {
      promptCalls.push({ text, streamingBehavior: options.streamingBehavior });
      if (controller.session.isStreaming) return { acceptedAs: "steer" };
      firstRequestTag = String(options.requestTag || "");
      controller.session.isStreaming = true;
      resolveFirstPromptStarted();
      await new Promise((resolve) => {
        releaseFirstPrompt = resolve;
      });
      controller.session.isStreaming = false;
      emitRpcTurnComplete(controller, { requestTag: firstRequestTag }, "done");
    },
    switchSession: async () => {},
  };

  const firstTurn = controller.runTurn({
    text: "first",
    attachments: [],
    incomingMessageId: "m-first",
    replyToMessageId: "m-first",
  });
  await firstPromptStarted;

  const submittedTurn = controller.runTurn({
    text: "steer now",
    attachments: [],
    incomingMessageId: "m-steer-now",
    replyToMessageId: "m-steer-now",
  });
  await waitUntil(
    () => promptCalls.length === 2,
    "ordinary input waited behind the active terminal",
  );

  assert.equal(controller.currentTurn?.incomingMessageId, "m-first");
  assert.deepEqual(promptCalls, [
    { text: "first", streamingBehavior: undefined },
    { text: "steer now", streamingBehavior: undefined },
  ]);

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "steer now" }],
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.currentTurn?.incomingMessageId, "m-steer-now");

  releaseFirstPrompt();
  const [firstResult, submittedResult] = await Promise.all([
    firstTurn,
    submittedTurn,
  ]);
  assert.equal(firstResult.finalText, "done");
  assert.equal(submittedResult.finalText, "done");
  assert.equal(submittedResult.superseded, true);
  assert.deepEqual(deliveries, [
    {
      text: "done",
      replyToMessageId: "m-steer-now",
      markProcessedMessageId: "m-steer-now",
    },
  ]);
});

for (const workingVisible of [false, true]) {
  test(`chat controller switches the display target before awaiting ${
    workingVisible ? "visible" : "stale"
  } submitted-input Working cleanup`, async () => {
    const controller = await createController("telegram/1:2");
    const deliveries = [];
    controller.app.bots[0].sendMessage = async (_chatId, content) => {
      deliveries.push(content);
      return [`out-${deliveries.length}`];
    };

    const claimFor = (messageId, text) => {
      const item = enqueueChatInboxItem(controller.agentDir, {
        chatKey: controller.chatKey,
        messageId,
        session: {
          platform: "telegram",
          selfId: "1",
          channelId: "2",
          messageId,
          content: text,
          stripped: { content: text },
        },
        elements: [{ type: "text", attrs: { content: text } }],
      }).item;
      return claimChatInboxItem(controller.agentDir, item.itemId);
    };
    const firstClaim = claimFor("m-first-race", "first");
    const steeredClaim = claimFor("m-steer-race", "steer now");
    const fenceFor = (claim) => ({
      agentDir: controller.agentDir,
      turnId: claim.itemId,
      chatKey: claim.chatKey,
      messageId: claim.messageId,
      ownerEpoch: claim.ownerEpoch,
      attempt: claim.attemptCount,
    });

    let releaseFirstPrompt = () => {};
    let resolveFirstPromptStarted = () => {};
    const firstPromptStarted = new Promise((resolve) => {
      resolveFirstPromptStarted = resolve;
    });
    controller.session = {
      isStreaming: false,
      messages: [],
      sessionManager: {
        getSessionFile: () => "/tmp/steer-race-chat.jsonl",
        getSessionId: () => "session-steer-race",
        getSessionName: () => controller.chatKey,
      },
      ensureSessionReady: async () => ({
        sessionFile: "/tmp/steer-race-chat.jsonl",
        sessionId: "session-steer-race",
      }),
      prompt: async (_text, options = {}) => {
        if (controller.session.isStreaming) return { acceptedAs: "steer" };
        controller.session.isStreaming = true;
        resolveFirstPromptStarted();
        await new Promise((resolve) => {
          releaseFirstPrompt = resolve;
        });
        controller.session.isStreaming = false;
        emitRpcTurnComplete(controller, options, "done once");
      },
      switchSession: async () => {},
    };

    const firstTurn = controller.runTurn({
      text: "first",
      attachments: [],
      incomingMessageId: firstClaim.messageId,
      replyToMessageId: firstClaim.messageId,
      outboxTurnFence: fenceFor(firstClaim),
    });
    await firstPromptStarted;

    const submittedTurn = controller.runTurn({
      text: "steer now",
      attachments: [],
      incomingMessageId: steeredClaim.messageId,
      replyToMessageId: steeredClaim.messageId,
      outboxTurnFence: fenceFor(steeredClaim),
    });
    await waitUntil(
      () =>
        controller.hasPendingSubmittedDeliveryTarget(steeredClaim.messageId),
      "ordinary input did not enter the pending display projection",
    );

    let cleanupCalls = 0;
    let resolveCleanupStarted = () => {};
    const cleanupStarted = new Promise((resolve) => {
      resolveCleanupStarted = resolve;
    });
    let releaseOldCleanup = () => {};
    const oldCleanupMayFinish = new Promise((resolve) => {
      releaseOldCleanup = resolve;
    });
    controller.clearWorkingReaction = async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) {
        resolveCleanupStarted();
        await oldCleanupMayFinish;
      }
      return true;
    };
    controller.driver.frontendState.workingVisible = workingVisible;
    const activation = controller.handleClientEvent({
      type: "ui",
      payload: {
        type: "message_start",
        message: {
          role: "user",
          content: [{ type: "text", text: "steer now" }],
        },
      },
    });
    await cleanupStarted;

    releaseFirstPrompt();
    const [firstResult, submittedResult] = await Promise.all([
      firstTurn,
      submittedTurn,
    ]);
    assert.equal(firstResult.finalText, "done once");
    assert.equal(submittedResult.finalText, "done once");
    assert.equal(submittedResult.superseded, true);
    releaseOldCleanup();
    await activation;

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0][0]?.attrs?.id, steeredClaim.messageId);
    assert.deepEqual(
      openChatDatabase(controller.agentDir)
        .prepare(
          `SELECT messages.message_id, turns.state, turns.terminal_kind,
                messages.disposition
         FROM turns JOIN messages ON messages.id = turns.inbound_message_id
         ORDER BY messages.sequence`,
        )
        .all(),
      [
        {
          message_id: firstClaim.messageId,
          state: "superseded",
          terminal_kind: "coalesced_steer",
          disposition: "superseded",
        },
        {
          message_id: steeredClaim.messageId,
          state: "terminal",
          terminal_kind: "outbox_final",
          disposition: "actionable",
        },
      ],
    );
  });
}

test("chat controller fences superseded restored inbox turns without marking processed", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };
  controller.driver.runTurn = async () => ({
    superseded: true,
    sessionFile: "/tmp/restored-chat.jsonl",
    sessionId: "session-restored",
  });
  const inbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "m-old",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "m-old",
      content: "older restored input",
      stripped: { content: "older restored input" },
    },
    elements: [{ type: "text", attrs: { content: "older restored input" } }],
  }).item;
  const claim = claimChatInboxItem(controller.agentDir, inbound.itemId);
  const fence = {
    agentDir: controller.agentDir,
    turnId: claim.itemId,
    chatKey: claim.chatKey,
    messageId: claim.messageId,
    ownerEpoch: claim.ownerEpoch,
    attempt: claim.attemptCount,
  };

  const result = await controller.runTurn({
    text: "older restored input",
    attachments: [],
    incomingMessageId: "m-old",
    replyToMessageId: "m-old",
    outboxTurnFence: fence,
  });

  assert.deepEqual(deliveries, []);
  assert.equal(result.superseded, true);
  const stored = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "m-old",
  );
  assert.equal(Boolean(stored?.processedAt), false);
  assert.deepEqual(
    openChatDatabase(controller.agentDir)
      .prepare(
        `SELECT turns.state, messages.disposition
         FROM turns JOIN messages ON messages.id = turns.inbound_message_id
         WHERE turns.turn_id = ?`,
      )
      .get(claim.itemId),
    { state: "superseded", disposition: "superseded" },
  );
});

test("chat controller leaves input after assistant content to Pi's active-turn decision", async () => {
  const controller = await createController("onebot/1:private:2");
  const promptCalls = [];
  const deliveries = [];
  let firstPromptOptions;
  let releaseFirstPrompt = () => {};
  let resolveFirstReplyCommitted = () => {};
  const firstReplyCommitted = new Promise((resolve) => {
    resolveFirstReplyCommitted = resolve;
  });

  controller.app = {
    bots: [
      {
        platform: "onebot",
        selfId: "1",
        async sendMessage(chatId, content) {
          deliveries.push({ chatId, content });
          return [`out-${deliveries.length}`];
        },
      },
    ],
  };

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/steer-final-chat.jsonl",
      getSessionId: () => "session-steer-final",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/steer-final-chat.jsonl",
      sessionId: "session-steer-final",
    }),
    prompt: async (text, options = {}) => {
      promptCalls.push({ text, streamingBehavior: options.streamingBehavior });
      if (promptCalls.length === 1) {
        firstPromptOptions = options;
        controller.session.isStreaming = true;
        await controller.handleSessionEvent({ type: "agent_start" });
        await controller.handleSessionEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "first answer" }],
          },
        });
        resolveFirstReplyCommitted();
        await new Promise((resolve) => {
          releaseFirstPrompt = resolve;
        });
        controller.session.isStreaming = false;
        emitRpcTurnComplete(controller, firstPromptOptions, "combined answer");
        return;
      }

      assert.equal(options.streamingBehavior, undefined);
      await controller.handleSessionEvent({
        type: "message_start",
        requestTag: options.requestTag,
        message: {
          role: "user",
          content: [{ type: "text", text: "follow up" }],
        },
      });
      return { acceptedAs: "steer" };
    },
    switchSession: async () => {},
  };

  const firstTurn = controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-first",
    replyToMessageId: "m-first",
  });
  await firstReplyCommitted;

  const secondTurn = controller.runTurn({
    text: "follow up",
    attachments: [],
    incomingMessageId: "m-second",
    replyToMessageId: "m-second",
  });
  await waitUntil(
    () => promptCalls.length === 2,
    "ordinary input did not reach Pi after assistant content",
  );
  assert.deepEqual(promptCalls, [
    { text: "hello", streamingBehavior: undefined },
    { text: "follow up", streamingBehavior: undefined },
  ]);

  releaseFirstPrompt();
  const [firstResult, secondResult] = await Promise.all([
    firstTurn,
    secondTurn,
  ]);

  assert.equal(firstResult.finalText, "combined answer");
  assert.equal(secondResult.finalText, "combined answer");
  assert.deepEqual(promptCalls, [
    { text: "hello", streamingBehavior: undefined },
    { text: "follow up", streamingBehavior: undefined },
  ]);
  assert.deepEqual(
    deliveries.map((delivery) => delivery.content?.[1]?.attrs?.content),
    ["combined answer"],
  );
});

test("chat controller fails fast when prompt submission is queued offline instead of hanging forever", async () => {
  const controller = await createController("telegram/1:2");
  controller.session = {
    isStreaming: false,
    messages: [],
    queuedOfflineOps: [],
    syncPendingCount() {},
    emitFrontendStatus() {},
    sessionManager: {
      getSessionFile: () => "/tmp/offline-chat.jsonl",
      getSessionId: () => "session-offline",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/offline-chat.jsonl",
      sessionId: "session-offline",
    }),
    prompt: async (_text, options = {}) => {
      controller.session.queuedOfflineOps.push({
        requestTag: options.requestTag,
      });
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-offline",
    }),
    /rin_disconnected:rpc_turn_queued_offline/,
  );
});

test("chat controller reports prompt timeout without transient retry classification", async () => {
  const controller = await createController("telegram/1:2");
  await fs.mkdir(path.join(controller.agentDir, "sessions"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(controller.agentDir, "sessions", "stale-chat.jsonl"),
    '{"type":"session","version":3}\n',
    "utf8",
  );
  controller.state.sessionFile = "stale-chat.jsonl";
  let disposed = 0;
  controller.driver.dispose = function () {
    disposed += 1;
    this.session = null;
  };
  controller.session = {
    isStreaming: false,
    messages: [],
    queuedOfflineOps: [],
    syncPendingCount() {},
    emitFrontendStatus() {},
    sessionManager: {
      getSessionFile: () =>
        path.join(controller.agentDir, "sessions", "stale-chat.jsonl"),
      getSessionId: () => "session-stale",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: path.join(
        controller.agentDir,
        "sessions",
        "stale-chat.jsonl",
      ),
      sessionId: "session-stale",
    }),
    prompt: async () => {
      throw new Error("rin_timeout:prompt");
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-timeout",
    }),
    /rin_timeout:prompt/,
  );

  assert.equal(controller.state.sessionFile, "stale-chat.jsonl");
  const persistedState = JSON.parse(
    await fs.readFile(controller.statePath, "utf8"),
  );
  assert.equal(persistedState.sessionFile, "stale-chat.jsonl");
  assert.equal(disposed, 0);
});

test("chat controller clears a stale bound session so ordinary chat can start fresh", async () => {
  const controller = await createController("telegram/1:2");
  delete controller.connect;
  controller.state.sessionFile = "missing-chat.jsonl";
  controller.saveState();
  const attempts = [];
  controller.driver.connect = async ({ restoreSessionFile = "" } = {}) => {
    attempts.push(restoreSessionFile);
  };

  await controller.connect({ restoreSession: true });

  assert.equal(controller.state.sessionFile, undefined);
  const persistedState = JSON.parse(
    await fs.readFile(controller.statePath, "utf8"),
  );
  assert.equal(persistedState.sessionFile, undefined);
  assert.deepEqual(attempts, [""]);
});

test("chat controller cannot clear a replacement owner's session binding", async () => {
  const controller = await createController("telegram/1:2");
  const inbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "stale-session-owner",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "stale-session-owner",
      content: "question",
      stripped: { content: "question" },
    },
    elements: [{ type: "text", attrs: { content: "question" } }],
  }).item;
  const stale = claimChatInboxItem(controller.agentDir, inbound.itemId);
  assert.equal(
    requeueClaimedChatInboxItem(controller.agentDir, stale, { delayMs: 0 })
      ?.state,
    "pending",
  );
  const replacement = claimChatInboxItem(controller.agentDir, inbound.itemId, {
    leaseMs: 60_000,
  });
  assert.notEqual(replacement.ownerEpoch, stale.ownerEpoch);
  const replacementSession = path.join(
    controller.agentDir,
    "sessions",
    "replacement-owner.jsonl",
  );
  await fs.mkdir(path.dirname(replacementSession), { recursive: true });
  await fs.writeFile(replacementSession, "{}\n");
  openChatDatabase(controller.agentDir)
    .prepare(`UPDATE chat_state SET session_file = ? WHERE chat_key = ?`)
    .run(replacementSession, controller.chatKey);
  controller.state.sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "missing-stale-owner.jsonl",
  );
  controller.currentTurn = {
    incomingMessageId: stale.messageId,
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: stale.itemId,
      chatKey: stale.chatKey,
      messageId: stale.messageId,
      ownerEpoch: stale.ownerEpoch,
      attempt: stale.attemptCount,
    },
    startedAt: Date.now(),
  };

  assert.equal(controller.getRecoverableSessionFile(), replacementSession);
  assert.equal(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT session_file FROM chat_state WHERE chat_key = ?`)
      .get(controller.chatKey).session_file,
    replacementSession,
  );
});

test("chat controller reports an explicit missing resume target", async () => {
  const controller = await createController("telegram/1:2");
  controller.state.sessionFile = "existing-binding.jsonl";
  controller.saveState();

  await assert.rejects(
    () =>
      controller.resumeSessionFile(
        path.join(controller.agentDir, "sessions", "missing-explicit.jsonl"),
      ),
    /Session record is missing or expired/,
  );

  assert.equal(controller.state.sessionFile, "existing-binding.jsonl");
  const persistedState = JSON.parse(
    await fs.readFile(controller.statePath, "utf8"),
  );
  assert.equal(persistedState.sessionFile, "existing-binding.jsonl");
});

test("chat controller terminate does not clear an existing durable chat binding", async () => {
  const controller = await createController("telegram/1:2");
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "terminating-chat.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "{}\n", "utf8");
  controller.state.sessionFile = "terminating-chat.jsonl";
  controller.saveState();
  let disposed = 0;
  controller.driver.dispose = () => {
    disposed += 1;
  };

  await controller.terminateSession();

  assert.equal(disposed, 1);
  assert.equal(controller.state.sessionFile, "terminating-chat.jsonl");
  const persistedState = JSON.parse(
    await fs.readFile(controller.statePath, "utf8"),
  );
  assert.equal(persistedState.sessionFile, "terminating-chat.jsonl");
});

test("chat controller submits the prompt without waiting for editable Working and keeps polling", async () => {
  const controller = await createController("discord/1:C1");
  controller.app.bots[0].platform = "discord";
  controller.app.bots[0].selfId = "1";
  const calls = [];
  const ticks: number[] = [];
  let releaseWorking!: () => void;
  const workingSent = new Promise<void>((resolve) => {
    releaseWorking = resolve;
  });
  let markWorkingStarted!: () => void;
  const workingStarted = new Promise<void>((resolve) => {
    markWorkingStarted = resolve;
  });
  let releasePrompt!: () => void;
  const promptMayFinish = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  controller.app.bots[0].workingIndicators = [
    {
      type: "polling",
      presentation: "editable-message",
      async tick(context) {
        ticks.push(Number(context?.tick));
        calls.push(`working:${context?.tick}`);
        if (ticks.length === 1) {
          markWorkingStarted();
          await workingSent;
        }
        return true;
      },
      async end() {
        calls.push("working:end");
        return true;
      },
    },
  ];
  controller.driver.runTurn = async () => {
    await controller.handleSessionEvent({
      type: "extension_ui_request",
      method: "setWorkingVisible",
      visible: true,
    });
    calls.push("prompt");
    await promptMayFinish;
    await controller.handleSessionEvent({
      type: "extension_ui_request",
      method: "setWorkingVisible",
      visible: false,
    });
    return { finalText: "ok" };
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    calls.push("final");
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  const turn = controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-editable-start",
  });
  await workingStarted;
  while (!calls.includes("prompt")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(calls, ["working:0", "prompt"]);
  releaseWorking();
  while (controller.workingIndicatorTick < 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.lastWorkingIndicatorAt = 0;
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(ticks, [0, 1]);
  releasePrompt();

  const result = await turn;
  assert.equal(result.finalText, "ok");
  assert.deepEqual(calls.slice(0, 3), ["working:0", "prompt", "working:1"]);
  assert.equal(calls.includes("final"), true);
});

test("chat controller does not let presentation polling block prompt submission", async () => {
  const controller = await createController("onebot/1:2");
  const calls = [];
  controller.pollTyping = async function () {
    calls.push("pollTyping");
    await new Promise(() => {});
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/nonblocking-chat.jsonl",
      getSessionId: () => "session-nonblocking",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/nonblocking-chat.jsonl",
      sessionId: "session-nonblocking",
    }),
    prompt: async (_text, options = {}) => {
      calls.push("prompt");
      emitRpcTurnComplete(controller, options, "ok");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-nonblocking",
  });

  assert.equal(result.finalText, "ok");
  assert.deepEqual(calls, ["prompt"]);
});

test("chat controller does not persist transient processing state to chat state.json", async () => {
  const controller = await createController("telegram/1:2");
  const statePath = controller.statePath;
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m1",
    replyToMessageId: "m1",
    workingNoticeSent: false,
  };
  controller.stagedDelivery = {
    chatKey: controller.chatKey,
    parts: [{ type: "text", text: "hello" }],
    replyToMessageId: "m1",
    sessionFile: "/tmp/demo.jsonl",
  };
  controller.state.sessionFile = "/tmp/demo.jsonl";

  controller.saveState();

  const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(persisted, {
    chatKey: controller.chatKey,
    sessionFile: "/tmp/demo.jsonl",
  });
  assert.equal(controller.currentTurn?.incomingMessageId, "m1");
  assert.equal(deliveryText(controller.stagedDelivery), "hello");
});

test("chat controller does not resend an already delivered final after restart recovery", async () => {
  const controller = await createController("telegram/1:2");
  let sendCount = 0;
  controller.app.bots[0].sendMessage = async () => {
    sendCount += 1;
    return [`sent-${sendCount}`];
  };

  saveChatMessage(controller.agentDir, {
    chatKey: controller.chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    messageId: "incoming-1",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "prompt",
  });

  const input = {
    text: "final answer",
    incomingMessageId: "incoming-1",
    replyToMessageId: "incoming-1",
    sessionFile: "managed/chat/session.jsonl",
    clearProcessing: true,
  };

  await controller.deliverAssistantReply(input);
  const recoveredController = createRecoveredController(controller);
  recoveredController.app.bots[0].sendMessage = async () => {
    sendCount += 1;
    return [`sent-${sendCount}`];
  };
  await recoveredController.deliverAssistantReply(input);

  const items = listChatOutboxItems(controller.agentDir).map(
    ({ item }) => item,
  );
  const delivered = await readOnlyChatOutboxHistoryItem(
    controller.agentDir,
    "delivered",
  );
  const message = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "incoming-1",
  );
  assert.equal(sendCount, 1);
  assert.equal(items.length, 0);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.deliveryResult[0], "sent-1");
  assert.equal(Boolean(message.processedAt), true);
});

test("chat controller retries a confirmed pre-dispatch final after restart", async () => {
  const controller = await createController("telegram/1:2");
  let sendCount = 0;
  controller.app.bots[0].sendMessage = () => {
    sendCount += 1;
    return rejectedBeforeDispatch("temporary_network_down");
  };
  saveChatMessage(controller.agentDir, {
    chatKey: controller.chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    messageId: "incoming-retry",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "prompt",
  });

  const input = {
    text: "final answer after retry",
    incomingMessageId: "incoming-retry",
    replyToMessageId: "incoming-retry",
    sessionFile: "managed/chat/session.jsonl",
    clearProcessing: true,
  };

  await assert.rejects(
    () => controller.deliverAssistantReply(input),
    /temporary_network_down/,
  );
  const [queued] = listChatOutboxItems(controller.agentDir).map(
    ({ item }) => item,
  );
  writeChatOutboxItem(controller.agentDir, {
    ...queued,
    nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
  });
  const recoveredController = createRecoveredController(controller);
  recoveredController.app.bots[0].sendMessage = async () => {
    sendCount += 1;
    return [`sent-${sendCount}`];
  };
  await recoveredController.deliverAssistantReply(input);

  const items = listChatOutboxItems(controller.agentDir).map(
    ({ item }) => item,
  );
  const delivered = await readOnlyChatOutboxHistoryItem(
    controller.agentDir,
    "delivered",
  );
  assert.equal(sendCount, 2);
  assert.equal(items.length, 0);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.deliveryUnconfirmed, undefined);
});

test("chat controller leaves confirmed pre-dispatch failure queued", async () => {
  const controller = await createController("telegram/1:2");
  let sendCount = 0;
  controller.app.bots[0].sendMessage = () => {
    sendCount += 1;
    return rejectedBeforeDispatch("temporary_network_down");
  };
  saveChatMessage(controller.agentDir, {
    chatKey: controller.chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    messageId: "incoming-sending",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "prompt",
  });

  const input = {
    text: "in-flight final answer",
    incomingMessageId: "incoming-sending",
    replyToMessageId: "incoming-sending",
    sessionFile: "managed/chat/session.jsonl",
    clearProcessing: true,
  };

  await assert.rejects(
    () => controller.deliverAssistantReply(input),
    /temporary_network_down/,
  );

  const items = listChatOutboxItems(controller.agentDir).map(
    ({ item }) => item,
  );
  const message = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "incoming-sending",
  );
  assert.equal(sendCount, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "queued");
  assert.equal(message.processedAt, undefined);
});

test("chat controller does not mark a confirmed permanent adapter rejection processed", async () => {
  const controller = await createController("telegram/1:2");
  let sendCount = 0;
  controller.app.bots[0].sendMessage = () => {
    sendCount += 1;
    return rejectedBeforeDispatch("forbidden: bot was kicked");
  };
  saveChatMessage(controller.agentDir, {
    chatKey: controller.chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    messageId: "incoming-failed",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "prompt",
  });

  const input = {
    text: "failed final answer",
    incomingMessageId: "incoming-failed",
    replyToMessageId: "incoming-failed",
    sessionFile: "managed/chat/session.jsonl",
    clearProcessing: true,
  };

  await assert.rejects(
    () => controller.deliverAssistantReply(input),
    /forbidden: bot was kicked/,
  );
  const recoveredController = createRecoveredController(controller);
  recoveredController.app.bots[0].sendMessage = async () => {
    sendCount += 1;
    return [`sent-${sendCount}`];
  };

  await assert.rejects(
    () => recoveredController.deliverAssistantReply(input),
    /forbidden: bot was kicked/,
  );

  const items = listChatOutboxItems(controller.agentDir).map(
    ({ item }) => item,
  );
  const failed = await readOnlyChatOutboxHistoryItem(
    controller.agentDir,
    "failed",
  );
  const message = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "incoming-failed",
  );
  assert.equal(sendCount, 1);
  assert.equal(items.length, 0);
  assert.equal(failed.status, "failed");
  assert.equal(message.processedAt, undefined);
});
