import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installChatControllerSessionClient } from "../support/chat-controller-session-client.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
const { openChatDatabase, readChatSessionBinding, readChatState } =
  await import(
    pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js"))
      .href
  );
const {
  claimChatInboxItem,
  completeClaimedChatInboxItem,
  enqueueChatInboxItem,
} = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const {
  beginDaemonTurn,
  daemonTurnTerminalEvent,
  interruptDaemonTurn,
  recordDaemonTurnTerminal,
} = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "turn-ledger.js"),
  ).href
);
function setLegacyInterruptedInboxFixture(agentDir, claim, error) {
  openChatDatabase(agentDir)
    .prepare(
      `UPDATE inbox_jobs
       SET state = 'failed', terminal_kind = 'interrupted',
           owner_epoch = NULL, lease_until = NULL, heartbeat_at = NULL,
           next_attempt_at = NULL, last_error = ?, updated_at = ?
       WHERE turn_id = ? AND state = 'running' AND owner_epoch = ? AND attempt = ?`,
    )
    .run(
      error,
      new Date().toISOString(),
      claim.itemId,
      claim.ownerEpoch,
      claim.attemptCount,
    );
}

const {
  enqueueChatOutboxPayload,
  listChatOutboxHistoryItems,
  listChatOutboxItems,
  readChatOutboxItemById,
  writeChatOutboxItem,
} = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "outbox.js")).href
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

function claimDurableTurnFence(controller, messageId = "m-todo-owner") {
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
  return {
    claim,
    fence: {
      agentDir: controller.agentDir,
      turnId: claim.itemId,
      chatKey: claim.chatKey,
      messageId: claim.messageId,
      ownerEpoch: claim.ownerEpoch,
      attempt: claim.attemptCount,
    },
  };
}

function setDurableCurrentTurn(controller, messageId = "m-todo-owner") {
  const durable = claimDurableTurnFence(controller, messageId);
  controller.currentTurn = {
    startedAt: Date.now(),
    outboxTurnFence: durable.fence,
  };
  return durable.claim;
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

test("chat controller resolves a joined owner from its durable request identity", async () => {
  const controller = await createController();
  const claim = claimDurableTurnFence(controller, "owner-message").claim;
  const requestTag = controller.requestTagForInboundMessage(claim.messageId, {
    turnId: claim.itemId,
  });

  assert.equal(
    controller.joinedOwnerTurnIdForRequestTag(requestTag),
    claim.itemId,
  );
});

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
      payload: { type: "agent_start", working: true },
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

test("detached delivery links its session without changing chat binding", async () => {
  const owner = await createController();
  const ownerSession = path.join(owner.agentDir, "sessions", "owner.jsonl");
  const taskSession = path.join(owner.agentDir, "sessions", "task.jsonl");
  await fs.mkdir(path.dirname(ownerSession), { recursive: true });
  await fs.writeFile(ownerSession, "session", "utf8");
  await fs.writeFile(taskSession, "session", "utf8");
  owner.updateStoredSessionFile(ownerSession);

  const detached = attachTestChatApp(
    new ChatController({}, owner.dataDir, owner.chatKey, {
      logger: { info() {}, warn() {} },
      h: owner.h,
      affectChatBinding: false,
      linkDeliveriesToSession: true,
    }),
  );
  let deliveryIndex = 0;
  detached.app.bots[0].sendMessage = async () => [`m${++deliveryIndex}`];
  await detached.deliverAssistantReply({ text: "early scheduled error" });
  assert.equal(
    lookupReplySession(owner.agentDir, owner.chatKey, "m1")?.sessionFile,
    undefined,
  );

  detached.updateStoredSessionFile(taskSession);
  await detached.deliverAssistantReply({
    text: "scheduled result",
    sessionFile: taskSession,
  });

  assert.match(
    openChatDatabase(owner.agentDir)
      .prepare(`SELECT session_file FROM chat_state WHERE chat_key = ?`)
      .get(owner.chatKey).session_file,
    /owner\.jsonl$/,
  );
  assert.equal(
    lookupReplySession(owner.agentDir, owner.chatKey, "m2").sessionFile,
    taskSession,
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
  const durable = claimDurableTurnFence(controller, "message-retry");
  for (const [ownerEpoch, attempt] of [
    [durable.fence.ownerEpoch, durable.fence.attempt],
    ["owner-2", durable.fence.attempt + 1],
  ]) {
    await controller.runTurn({
      text: "same logical inbox turn",
      attachments: [],
      incomingMessageId: "message-retry",
      outboxTurnFence: {
        ...durable.fence,
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
    async tick({ chatId, messageId, workingStarted }) {
      actions.push({ chat_id: chatId, action: "typing" });
      if (messageId && workingStarted !== false && !emoji) {
        emoji = "🤔";
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
    presentation: "reaction",
    async tick({ chatId, messageId, workingStarted }) {
      if (!messageId) return false;
      if (workingStarted === false || emoji) return true;
      emoji = "🤔";
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
  const terminalPayload = {
    type: "rpc_turn_event",
    event: "complete",
    working: false,
    requestTag: options?.requestTag,
    finalText,
    result: result || {
      messages: [{ type: "text", text: finalText }],
    },
    sessionId: controller.session?.sessionManager?.getSessionId?.(),
    sessionFile: controller.session?.sessionManager?.getSessionFile?.(),
  };
  let canonicalTerminal = {};
  if (options?.chatDeliveryContext) {
    beginDaemonTurn(controller.agentDir, {
      requestTag: options.requestTag,
      sessionFile: terminalPayload.sessionFile,
      sessionId: terminalPayload.sessionId,
      chatDeliveryContext: options.chatDeliveryContext,
    });
    canonicalTerminal = daemonTurnTerminalEvent(
      recordDaemonTurnTerminal(controller.agentDir, {
        requestTag: options.requestTag,
        terminalKind: "complete",
        terminalEvent: terminalPayload,
      }),
    );
  }
  controller.handleClientEvent({
    type: "ui",
    payload: {
      ...terminalPayload,
      ...canonicalTerminal,
    },
  });
}

test("chat controller fences terminal projections by request tag and authoritative WAL", async () => {
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

  await assert.rejects(
    controller.handleFrontendEvent({
      type: "turn_complete",
      requestTag: "request-current",
      latestAssistantText: "current final",
    }),
    /chat_terminal_record_missing/,
  );
  await assert.rejects(
    controller.handleFrontendEvent({
      type: "turn_error",
      requestTag: "request-current",
      message: "current error",
    }),
    /chat_terminal_record_missing/,
  );
  assert.deepEqual(completed, []);
  assert.deepEqual(failed, []);
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
      result: {
        summary: "Summary of conversation must not reach chat",
        tokensBefore: 108642,
      },
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

test("chat controller reuses its one logical prompt session instead of allocating another", async () => {
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

  assert.deepEqual(calls, ["ensureSessionReady", "prompt"]);
  assert.equal(result.finalText, "managed prompt final");
  assert.deepEqual(deliveries, ["managed prompt final"]);
  assert.equal(controller.state.sessionFile, undefined);
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

test("chat controller keeps an already-bound default session instead of replacing it", async () => {
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
  assert.equal(controller.state.sessionFile, "default-before-managed.jsonl");
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

test("chat controller renders extension command notifications from the frontend client", async () => {
  let connected = false;
  let listener = null;
  const frontendClient = {
    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
    subscribe(nextListener) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
    async getState() {
      return {};
    },
    async ensureSessionReady() {
      return {};
    },
    async request(command) {
      if (command.type === "list_unacknowledged_chat_terminals") {
        return { terminals: [] };
      }
      return {};
    },
    async runCommand() {
      listener?.({
        type: "extension_ui_request",
        payload: {
          type: "extension_ui_request",
          method: "notify",
          message: "Extension completed",
        },
      });
      return { handled: true };
    },
  };
  const controller = await createController("telegram/1:2", {
    frontendClientFactory: () => frontendClient,
  });
  controller.connect = ChatController.prototype.connect.bind(controller);

  const result = await controller.runCommand("/hello");

  assert.equal(result.text, "Extension completed");
});

test("chat controller delivers rich extension command results from the frontend client", async () => {
  let connected = false;
  let listener = null;
  const imagePath = "/tmp/codex-usage-card.png";
  const frontendClient = {
    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
    subscribe(nextListener) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
    async getState() {
      return {};
    },
    async ensureSessionReady() {
      return {};
    },
    async request(command) {
      if (command.type === "list_unacknowledged_chat_terminals") {
        return { terminals: [] };
      }
      return {};
    },
    async runCommand() {
      listener?.({
        type: "extension_ui_request",
        payload: {
          type: "extension_ui_request",
          method: "rinCommandResult",
          result: {
            fallbackText: "Codex usage",
            parts: [{ type: "image", path: imagePath, mimeType: "image/png" }],
          },
        },
      });
      return { handled: true };
    },
  };
  const controller = await createController("telegram/1:2", {
    frontendClientFactory: () => frontendClient,
  });
  controller.connect = ChatController.prototype.connect.bind(controller);
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery);
    this.stagedDelivery = null;
  };

  await controller.runCommand("/usage", "usage-message", "usage-message");

  assert.deepEqual(deliveries[0].parts, [
    { type: "quote", id: "usage-message" },
    { type: "image", path: imagePath, mimeType: "image/png" },
  ]);
});

test("chat controller rejects rich command results outside command execution", async () => {
  const controller = await createController();
  await assert.rejects(
    controller.handleFrontendEvent({
      type: "extension_ui_request",
      method: "rinCommandResult",
      result: {
        parts: [{ type: "image", path: "/tmp/codex-usage.png" }],
      },
    }),
    /Extension command result arrived outside command execution/,
  );
});

test("chat controller keeps message catalogs separate from Pi-native Working copy", async () => {
  const workingMessages = [];
  const controller = await createController("telegram/1:2", {
    onWorkingMessage(message) {
      workingMessages.push(message);
    },
  });
  await controller.handleFrontendEvent({
    type: "extension_ui_request",
    method: "setMessageCatalog",
    catalog: { "session.new.completed": "Localized new session" },
  });
  await controller.handleFrontendEvent({
    type: "extension_ui_request",
    method: "setWorkingMessage",
    message: " Frame A ",
  });
  assert.equal(controller.getCommandResponses().new, "Localized new session");
  assert.deepEqual(workingMessages, ["Frame A"]);
});

test("chat controller cancels unsupported extension dialogs", async () => {
  const controller = await createController();
  controller.session = {};
  const responses = [];
  controller.client.respondExtensionUi = async (response) => {
    responses.push(response);
  };

  await controller.handleFrontendEvent({
    type: "extension_ui_request",
    id: "ui-1",
    method: "confirm",
    message: "Continue?",
  });

  assert.deepEqual(responses, [
    { type: "extension_ui_response", id: "ui-1", cancelled: true },
  ]);
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

test("chat controller delegates active /abort to the canonical frontend command owner", async () => {
  const controller = await createController();
  const backendCommands = [];
  const deliveries = [];
  controller.hasActiveTurn = () => true;
  controller.connect = async () => true;
  controller.driver.runCommand = async (commandLine, options) => {
    backendCommands.push(commandLine);
    options?.onActiveTurnInterruptionCommitted?.();
    return {
      handled: true,
      text: "Aborted current operation.",
      sessionFile: controller.driver.currentSessionFile(),
    };
  };
  controller.driver.interruptActiveTurnLikeTui = () => {
    assert.fail("Chat must not own a TUI-like interruption path");
  };
  controller.commitPendingDelivery = async function () {
    deliveries.push(deliveryText(this.stagedDelivery));
    this.stagedDelivery = null;
  };

  await controller.runCommand("/abort", "m-abort", "m-abort");

  assert.deepEqual(backendCommands, ["/abort"]);
  assert.deepEqual(deliveries, ["Aborted current operation."]);
});

test("chat controller projects frontend supersession without owning abort lifecycle", async () => {
  const controller = await createController();
  const deliveries = [];
  let resolveOldTurn;
  let oldDriverTurnStarted = false;
  const oldDriverTurn = new Promise((resolve) => {
    resolveOldTurn = resolve;
  });
  controller.currentTurn = {
    incomingMessageId: "m-old",
    replyToMessageId: "m-old",
    requestTag: "request-old-complete",
  };
  controller.awaitingTurnSettle = true;
  controller.connect = async () => true;
  controller.prepareTurnPrompt = async () => ({
    text: "old prompt",
    images: [],
    frontendReady: true,
  });
  controller.driver.runTurn = async () => {
    oldDriverTurnStarted = true;
    return await oldDriverTurn;
  };
  controller.driver.runCommand = async (_commandLine, options) => {
    options?.onActiveTurnInterruptionCommitted?.();
    resolveOldTurn({
      outcome: "terminalOwner",
      superseded: true,
      finalText: "",
      requestTag: "request-old-complete",
      sessionFile: controller.driver.currentSessionFile(),
      terminalRecord: {
        terminalId: "terminal-old-aborted",
        state: "error",
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    return {
      handled: true,
      text: "Aborted current operation.",
      sessionFile: controller.driver.currentSessionFile(),
    };
  };
  controller.deliverAssistantReply = async (delivery) => {
    deliveries.push(delivery.text);
  };

  const oldTurn = controller.runTurn({
    text: "old prompt",
    attachments: [],
    incomingMessageId: "m-old",
    replyToMessageId: "m-old",
    requestTag: "request-old-complete",
  });
  await waitUntil(
    () => oldDriverTurnStarted,
    "old frontend turn did not start",
  );
  const command = controller.runCommand("/abort", "m-abort", "m-abort");
  const [oldResult] = await Promise.all([oldTurn, command]);

  assert.equal(oldResult.superseded, true);
  assert.equal(oldResult.finalText, "");
  assert.deepEqual(deliveries, ["Aborted current operation."]);
});

test("chat controller preserves the active turn when backend /abort fails", async () => {
  const controller = await createController();
  const activeTurn = {
    incomingMessageId: "m-active",
    replyToMessageId: "m-active",
    requestTag: "request-active",
  };
  controller.currentTurn = activeTurn;
  controller.awaitingTurnSettle = true;
  controller.hasActiveTurn = () => true;
  controller.connect = async () => true;
  controller.driver.runCommand = async () => {
    throw new Error("backend abort rejected");
  };
  controller.deliverAssistantReply = async () => {};
  let workingClears = 0;
  controller.clearWorkingReaction = async () => {
    workingClears += 1;
  };
  await assert.rejects(
    controller.runCommand("/abort", "m-abort", "m-abort"),
    /backend abort rejected/,
  );

  assert.equal(controller.currentTurn, activeTurn);
  assert.equal(controller.awaitingTurnSettle, true);
  assert.equal(workingClears, 0);
});

test("chat controller can deliver image-only extension command parts", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery);
    this.stagedDelivery = null;
  };

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "media-command-parts.jsonl",
  );
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-media",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-media",
    }),
    runCommand: async () => ({
      handled: true,
      text: "",
      parts: [{ type: "image", path: "/tmp/media.png", mimeType: "image/png" }],
      sessionFile,
    }),
    switchSession: async () => {},
  };

  await controller.runCommand("/media", "m-media", "m-media");

  assert.deepEqual(deliveries[0].parts, [
    { type: "quote", id: "m-media" },
    { type: "image", path: "/tmp/media.png", mimeType: "image/png" },
  ]);
});

test("chat controller suppresses ordinary Working for manual compaction", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  controller.app.bots[0].workingIndicators = [
    {
      ...testPollingIndicator(actions, reactions),
      presentation: "editable-message",
    },
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
        payload: { type: "backend_working_state", working: true },
      });
      await releaseCommandPromise;
      await controller.handleClientEvent({
        type: "ui",
        payload: { type: "backend_working_state", working: false },
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
  await controller.handleFrontendEvent({
    type: "compaction_start_notice",
    text: "Localized compacting",
  });
  actions.length = 0;
  reactions.length = 0;
  deliveries.length = 0;
  await controller.handleFrontendEvent({
    type: "extension_ui_request",
    method: "setMessageCatalog",
    catalog: { "session.compaction.started": "Localized compacting" },
  });
  await controller.handleFrontendEvent({
    type: "extension_ui_request",
    method: "setWorkingMessage",
    message: "Localized Working",
  });

  assert.deepEqual(actions, []);
  assert.deepEqual(reactions, []);

  releaseCommand();
  await command;

  assert.equal(controller.currentTurn, null);
  assert.deepEqual(actions, []);
  assert.deepEqual(reactions, []);
  assert.deepEqual(deliveries, ["Compacted session."]);
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
    .prepare("SELECT state, terminal_kind FROM inbox_jobs WHERE turn_id = ?")
    .get(claim.itemId);
  assert.deepEqual(turn, {
    state: "terminal",
    terminal_kind: "outbox_error",
  });
  const outbox = listChatOutboxHistoryItems(controller.agentDir, "delivered");
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].deliveryKind, "error");
});

test("chat command retry adopts its already delivered legacy error outbox", async () => {
  const controller = await createController("telegram/1:2");
  const claim = setDurableCurrentTurn(
    controller,
    "legacy-command-failure-message",
  );
  const turnFence = controller.currentTurn.outboxTurnFence;
  const legacyOutboxId = enqueueChatOutboxPayload(
    controller.agentDir,
    {
      createdAt: new Date().toISOString(),
      chatKey: controller.chatKey,
      parts: [
        { type: "quote", id: claim.messageId },
        { type: "text", text: "legacy compact failure" },
      ],
    },
    {
      idempotencyKey: "legacy-command-error",
      deliveryKind: "interim",
      turnFence,
    },
  );
  const legacyOutbox = readChatOutboxItemById(
    controller.agentDir,
    legacyOutboxId,
  ).item;
  writeChatOutboxItem(controller.agentDir, {
    ...legacyOutbox,
    status: "delivered",
    deliveryResult: ["legacy-error-message"],
    deliveredAt: new Date().toISOString(),
  });
  openChatDatabase(controller.agentDir)
    .prepare("UPDATE outbox SET delivery_kind = 'error' WHERE outbox_id = ?")
    .run(legacyOutboxId);
  let sends = 0;
  controller.app.bots[0].sendMessage = async () => {
    sends += 1;
    return [`unexpected-${sends}`];
  };
  controller.driver.runCommand = async () => {
    throw new Error("compact retry exploded");
  };

  await assert.rejects(
    controller.runCommand(
      "/compact",
      claim.messageId,
      claim.messageId,
      "",
      undefined,
      turnFence,
    ),
    /compact retry exploded/,
  );

  const turn = openChatDatabase(controller.agentDir)
    .prepare("SELECT state, terminal_kind FROM inbox_jobs WHERE turn_id = ?")
    .get(claim.itemId);
  assert.deepEqual(turn, {
    state: "terminal",
    terminal_kind: "outbox_error",
  });
  const terminalOutboxes = openChatDatabase(controller.agentDir)
    .prepare(
      `SELECT outbox_id, delivery_kind, payload_json, post_delivery_applied_at
       FROM outbox
       WHERE turn_id = ? AND delivery_kind != 'interim'`,
    )
    .all(claim.itemId);
  assert.equal(terminalOutboxes.length, 1);
  assert.equal(terminalOutboxes[0].outbox_id, legacyOutboxId);
  assert.equal(terminalOutboxes[0].delivery_kind, "error");
  assert.equal(
    JSON.parse(terminalOutboxes[0].payload_json).parts[1].text,
    "legacy compact failure",
  );
  assert.ok(terminalOutboxes[0].post_delivery_applied_at);
  assert.equal(sends, 0);
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
      result: { tokensBefore: 108642 },
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
      result: { tokensBefore: 108642 },
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
      result: { tokensBefore: 108642 },
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

test("chat controller delivers non-deferred passive notices during active inbox_jobs", async () => {
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
      text: "Error: Compaction failed: summary backend unavailable",
      kind: "error",
    },
  ]);
  assert.deepEqual(
    openChatDatabase(controller.agentDir)
      .prepare(`SELECT state, terminal_kind FROM inbox_jobs WHERE turn_id = ?`)
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
    text: "[ ] Unavailable state",
    noticeKind: "todo",
    deferDuringTurn: false,
    todoItems: [{ id: 1, text: "Unavailable state", done: false }],
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

test("chat controller does not replay todo after a new user message", async () => {
  const controller = await createController("example/1:2");
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
  const controller = await createController("example/1:2");
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
    { text: "Error: quiet failure", kind: "error" },
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

test("chat controller does not create processing inbox_jobs for slash commands", async () => {
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
  controller.commandResponses.current = {
    ...controller.commandResponses.current,
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

test("chat controller does not duplicate a projected pending rollback terminal error", async () => {
  const controller = await createController();
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    deliveries.push({
      text: nodes
        .map((node) => node?.attrs?.content || "")
        .filter(Boolean)
        .join(" "),
      options,
    });
    return [`m-terminal-error-${deliveries.length}`];
  };
  controller.driver.runTurn = async (input) => {
    await controller.handleSessionEvent({
      type: "agent_start",
      requestTag: input.requestTag,
    });
    await controller.handleFrontendEvent({
      type: "turn_error",
      requestTag: input.requestTag,
      error: "pending rollback terminal error",
    });
    const error = new Error("pending rollback terminal error");
    error.rinTurnTerminal = true;
    throw error;
  };

  const error = await controller
    .runTurn({
      text: "pending rollback",
      attachments: [],
      incomingMessageId: "m-pending-rollback-error",
    })
    .then(
      () => null,
      (failure) => failure,
    );

  assert.equal(error?.rinTurnTerminal, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0]?.text || "", /pending rollback terminal error/);
});

test("chat controller uses the dedicated compact command and delivers command results", async () => {
  for (const [command, resultText, expectedDeliveries] of [
    ["/compact", "Compacted session.", ["Compacted session."]],
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

test("chat controller commits manual /compact completion to its captured command target", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, content, options) => {
    deliveries.push({ content, options });
    return [`compact-${deliveries.length}`];
  };

  const receivedAt = new Date().toISOString();
  saveChatMessage(controller.agentDir, {
    messageId: "m-compact-no-presentation",
    chatKey: controller.chatKey,
    platform: "telegram",
    chatId: "2",
    chatType: "private",
    role: "user",
    receivedAt,
    text: "/compact",
  });

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "compact-no-presentation.jsonl",
  );
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-compact-no-presentation",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-compact-no-presentation",
    }),
    compact: async () => {
      const capturedInput = controller.activeCommandTurnInput;
      controller.activeCommandTurnInput = Object.freeze({
        commandName: "compact",
        incomingMessageId: "m-drifted-command",
        replyToMessageId: "m-drifted-command",
      });
      controller.compactionTurn = null;
      assert.equal(Object.isFrozen(capturedInput), true);
      return {
        handled: true,
        tokensBefore: 142065,
        sessionFile,
      };
    },
    prompt: async (text, options = {}) => {
      emitRpcTurnComplete(controller, options, "unexpected temp reply");
    },
    switchSession: async () => {},
  };

  assert.equal(controller.compactionTurn, null);
  await controller.runCommand(
    "/compact",
    "m-compact-no-presentation",
    "m-compact-no-presentation",
  );

  assert.deepEqual(
    deliveries.map(({ content, options }) => ({
      text: content.map((node) => node?.attrs?.content || "").join(""),
      quote: content.find((node) => node?.type === "quote")?.attrs?.id,
      deliveryKind: options?.deliveryKind,
    })),
    [
      {
        text: "Compacted from 142,065 tokens",
        quote: "m-compact-no-presentation",
        deliveryKind: "final",
      },
    ],
  );
  assert.ok(
    getChatMessage(
      controller.agentDir,
      controller.chatKey,
      "m-compact-no-presentation",
    )?.processedAt,
  );
});

test("chat controller rejects manual /compact when completion cannot enter outbox", async () => {
  const controller = await createController("telegram/1:2");
  controller.app.bots[0].sendMessage = async () => ["m-error"];
  const originalEnqueueAndDrainDelivery =
    controller.enqueueAndDrainDelivery.bind(controller);
  controller.enqueueAndDrainDelivery = async (payload, options = {}) => {
    if (options.deliveryKind === "final") {
      throw new Error("compact completion enqueue exploded");
    }
    return await originalEnqueueAndDrainDelivery(payload, options);
  };

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "compact-completion-failure.jsonl",
  );
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-compact-completion-failure",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-compact-completion-failure",
    }),
    compact: async () => {
      controller.compactionTurn = {
        startedAt: Date.now(),
        incomingMessageId: "m-progress",
        replyToMessageId: "m-compact-failure",
      };
      return { handled: true, tokensBefore: 99000, sessionFile };
    },
    prompt: async (text, options = {}) => {
      emitRpcTurnComplete(controller, options, "unexpected temp reply");
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    controller.runCommand("/compact", "m-compact-failure", "m-compact-failure"),
    /compact completion enqueue exploded/,
  );
});

test("chat controller completes manual /compact from its command response", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  const editableTicks = [];
  const deliveries = [];
  controller.app.bots[0].workingIndicators = [
    testPollingIndicator(actions, reactions),
    {
      type: "polling",
      presentation: "editable-message",
      async tick() {
        editableTicks.push("tick");
        return true;
      },
      async end() {
        return false;
      },
    },
  ];
  controller.app.bots[0].sendMessage = async (chatId, content, options) => {
    deliveries.push({ chatId, content, options });
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
        payload: { type: "backend_working_state", working: true },
      });
      await controller.handleClientEvent({
        type: "ui",
        payload: { type: "compaction_start", reason: "manual" },
      });
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "compaction_end",
          reason: "manual",
          aborted: false,
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      return {
        handled: true,
        text: "Compacted session.",
        tokensBefore: 77625,
        sessionFile,
      };
    },
    prompt: async (text, options = {}) => {
      emitRpcTurnComplete(controller, options, "unexpected temp reply");
    },
    switchSession: async () => {},
  };

  await controller.runCommand("/compact", "m-compact", "m-compact");
  const stored = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "m-compact",
  );
  assert.ok(stored?.acceptedAt);
  assert.ok(
    stored?.processedAt,
    "the awaited compact response should mark the original /compact processed",
  );
  assert.deepEqual(actions, []);
  assert.deepEqual(reactions, []);
  assert.deepEqual(editableTicks, []);
  assert.deepEqual(
    deliveries.map(({ chatId, content }) => ({ chatId, content })),
    [
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
    ],
  );
  assert.deepEqual(
    deliveries.map(({ options }) => ({
      deliveryKind: options?.deliveryKind,
      coalesceWithWorkingMessage: options?.coalesceWithWorkingMessage,
      exclusiveProgressMessage: options?.exclusiveProgressMessage,
    })),
    [
      {
        deliveryKind: "interim",
        coalesceWithWorkingMessage: true,
        exclusiveProgressMessage: true,
      },
      {
        deliveryKind: "final",
        coalesceWithWorkingMessage: undefined,
        exclusiveProgressMessage: undefined,
      },
    ],
  );
});

test("chat controller uses only the command response for manual /compact completion", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, content, options) => {
    deliveries.push({ content, options });
    return [`compact-${deliveries.length}`];
  };

  const receivedAt = new Date().toISOString();
  saveChatMessage(controller.agentDir, {
    messageId: "m-compact-single-owner",
    chatKey: controller.chatKey,
    platform: "telegram",
    chatId: "2",
    chatType: "private",
    role: "user",
    receivedAt,
    text: "/compact",
  });

  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "compact-single-owner.jsonl",
  );
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-compact-single-owner",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-compact-single-owner",
    }),
    compact: async () => {
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "compaction_end",
          reason: "manual",
          aborted: false,
          tokensBefore: 77625,
        },
      });
      return {
        handled: true,
        tokensBefore: 77625,
        sessionFile,
      };
    },
    prompt: async (text, options = {}) => {
      emitRpcTurnComplete(controller, options, "unexpected temp reply");
    },
    switchSession: async () => {},
  };

  await controller.runCommand(
    "/compact",
    "m-compact-single-owner",
    "m-compact-single-owner",
  );

  assert.deepEqual(
    deliveries.map(({ content }) =>
      content.map((node) => node?.attrs?.content || "").join(""),
    ),
    ["Compacted from 77,625 tokens"],
  );
});

test("chat controller leaves prompt-versus-steer admission to Pi", async () => {
  const controller = await createController("telegram/1:2");
  const submissions: any[] = [];
  controller.currentTurn = {
    requestTag: "owner-tag",
    assistantText: "",
    interimText: "",
  };
  controller.hasActiveTurn = () => true;
  controller.prepareTurnPrompt = async () => ({
    text: "insert this",
    images: ["img"],
    frontendReady: true,
  });
  controller.driver.runTurn = async (input) => {
    submissions.push(input);
    await input.commitNonterminalAcceptance?.({
      requestTag: input.requestTag,
      sessionFile: controller.currentSessionFile(),
    });
    return {
      outcome: "nonterminal",
      superseded: true,
      requestTag: input.requestTag,
      sessionFile: controller.currentSessionFile(),
    };
  };

  const result = await controller.runTurn({
    text: "insert this",
    attachments: [],
    incomingMessageId: "m-steer",
    replyToMessageId: "m-steer",
  });

  assert.equal(result.superseded, true);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].streamingBehavior, undefined);
  assert.match(submissions[0].requestTag, /^chat-inbox-[a-f0-9]{64}$/);
});

test("chat controller honors Pi prompt admission despite stale local active state", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries: any[] = [];
  controller.currentTurn = {
    requestTag: "settled-owner-tag",
    assistantText: "",
    interimText: "",
  };
  controller.hasActiveTurn = () => true;
  controller.prepareTurnPrompt = async () => ({
    text: "new lifecycle prompt",
    images: [],
    frontendReady: true,
  });
  controller.driver.runTurn = async () => ({
    outcome: "terminalOwner",
    superseded: false,
    finalText: "new final",
    result: { parts: [{ type: "text", text: "new final" }] },
    requestTag: "new-owner-tag",
    sessionFile: "/tmp/new-owner.jsonl",
  });
  controller.deliverAssistantReply = async (delivery) => {
    deliveries.push(delivery);
  };

  const result = await controller.runTurn({
    text: "new lifecycle prompt",
    attachments: [],
    incomingMessageId: "m-new-owner",
    replyToMessageId: "m-new-owner",
  });

  assert.equal(result.superseded, false);
  assert.equal(result.finalText, "new final");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].terminalRequestTag, "new-owner-tag");
});

test("chat controller settles remote Pi steering without taking or delivering its terminal", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery);
    this.stagedDelivery = null;
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
    prompt: async () => ({ outcome: "nonterminal" }),
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "steer after reconnect",
    attachments: [],
    incomingMessageId: "m-remote-steer",
    replyToMessageId: "m-remote-steer",
  });

  assert.equal(result.superseded, true);
  assert.equal(result.finalText, undefined);
  assert.equal(deliveries.length, 0);
  assert.equal(controller.currentTurn, null);
});

test("chat controller adopts a backend-accepted pending presentation before interim output", async () => {
  const controller = await createController("discord/1:pending-presentation");
  controller.app.bots[0].platform = "discord";
  controller.app.bots[0].selfId = "1";
  const accepted = [];
  const contexts = [];
  const interimDeliveries = [];
  controller.markAcceptedMessage = (messageId) => {
    accepted.push(messageId);
    return true;
  };
  controller.app.bots[0].getWorkingIndicators = () => [
    {
      type: "polling",
      presentation: "editable-message",
      async tick(context) {
        contexts.push({ event: "tick", ...context });
        return true;
      },
      async end(context) {
        contexts.push({ event: "end", ...context });
        return true;
      },
    },
  ];
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-old-owner",
    replyToMessageId: "m-old-owner",
    requestTag: "request-old-owner",
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: "turn-old-owner",
      chatKey: controller.chatKey,
      messageId: "m-old-owner",
      ownerEpoch: "owner-old",
      attempt: 1,
    },
    workingNoticeSent: false,
  };
  controller.presentationIncomingMessageId = "m-old-owner";
  controller.presentationReplyToMessageId = "m-old-owner";
  controller.activeWorkingIndicators =
    controller.app.bots[0].getWorkingIndicators();
  controller.awaitingTurnSettle = true;
  controller.driver.isWorking = () => true;
  controller.canDeliverReplies = () => true;
  controller.enqueueAndDrainDelivery = async (payload) => {
    interimDeliveries.push(payload);
    return { accepted: true, delivered: true, settled: true };
  };
  controller.pendingTurnPresentations.set("request-new-owner", {
    incomingMessageId: "m-new-owner",
    replyToMessageId: "m-new-owner",
    requestTag: "request-new-owner",
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: "turn-new-owner",
      chatKey: controller.chatKey,
      messageId: "m-new-owner",
      ownerEpoch: "owner-new",
      attempt: 1,
    },
    backendAccepted: false,
    joinedOwnerTurnId: "turn-old-owner",
    sessionFile: "/tmp/chat-session.jsonl",
  });

  await controller.handleFrontendEvent({
    type: "working_state",
    working: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    contexts,
    [],
    "backend Working must not reactivate the completed presentation while a new input awaits acceptance",
  );

  await controller.handleFrontendEvent({
    type: "turn_accepted",
    requestTag: "request-new-owner",
    sessionFile: "/tmp/pending-presentation.jsonl",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.currentTurn.incomingMessageId, "m-old-owner");
  assert.equal(controller.presentationIncomingMessageId, "m-new-owner");
  assert.equal(controller.presentationReplyToMessageId, "m-new-owner");
  assert.equal(controller.backendAcceptedIncomingMessageId, "m-new-owner");
  assert.deepEqual(accepted, ["m-new-owner"]);
  assert.equal(contexts[0].event, "end");
  assert.equal(contexts[0].messageId, "m-old-owner");
  assert.equal(contexts[0].endReason, "presentation_transferred");
  assert.equal(contexts[1].event, "tick");
  assert.equal(contexts[1].messageId, "m-new-owner");

  await controller.handleFrontendEvent({
    type: "assistant_interim",
    text: "New owner interim",
    requestTag: "request-new-owner",
  });

  assert.equal(interimDeliveries.length, 1);
  assert.equal(interimDeliveries[0].deliveryKind, "interim");
  assert.equal(interimDeliveries[0].parts[0].id, "m-new-owner");
  assert.deepEqual(accepted, ["m-new-owner", "m-new-owner"]);
  assert.equal(controller.currentTurn.incomingMessageId, "m-old-owner");
  assert.equal(controller.currentTurn.outboxTurnFence.turnId, "turn-old-owner");
  assert.deepEqual(
    controller.currentDeliveryTarget({
      incomingMessageId: "m-old-owner",
      replyToMessageId: "m-old-owner",
    }),
    {
      incomingMessageId: "m-new-owner",
      replyToMessageId: "m-new-owner",
      outboxTurnFence: {
        agentDir: controller.agentDir,
        turnId: "turn-old-owner",
        chatKey: controller.chatKey,
        messageId: "m-old-owner",
        ownerEpoch: "owner-old",
        attempt: 1,
      },
    },
  );
});

test("chat controller retires a stale accepted listener after its durable fence rotates", async () => {
  const logs = [];
  const controller = await createController("telegram/1:2", {
    logger: {
      info(...args) {
        logs.push(args.join(" "));
      },
      warn() {},
    },
  });
  const stale = claimDurableTurnFence(controller, "m-stale-accepted");
  const current = claimDurableTurnFence(controller, "m-current-owner");
  const requestTag = "request-stale-accepted";
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "stale-accepted.jsonl",
  );
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: current.claim.messageId,
    replyToMessageId: current.claim.messageId,
    requestTag: "request-current-owner",
    outboxTurnFence: current.fence,
    workingNoticeSent: false,
  };
  controller.pendingTurnPresentations.set(requestTag, {
    incomingMessageId: stale.claim.messageId,
    replyToMessageId: stale.claim.messageId,
    requestTag,
    outboxTurnFence: stale.fence,
    backendAccepted: false,
    joinedOwnerTurnId: current.claim.itemId,
    sessionFile,
  });
  openChatDatabase(controller.agentDir)
    .prepare(
      `UPDATE inbox_jobs
       SET owner_epoch = 'replacement-owner', attempt = attempt + 1
       WHERE turn_id = ?`,
    )
    .run(stale.claim.itemId);

  await controller.handleFrontendEvent({
    type: "turn_accepted",
    requestTag,
    sessionFile,
  });
  await controller.handleFrontendEvent({
    type: "turn_accepted",
    requestTag,
    sessionFile,
  });

  assert.equal(controller.pendingTurnPresentations.has(requestTag), false);
  assert.equal(
    openChatDatabase(controller.agentDir)
      .prepare("SELECT accepted_at FROM messages WHERE message_id = ?")
      .get(stale.claim.messageId).accepted_at,
    null,
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /stale turn acceptance retired/);
});

test("restart recovery joins a native nonterminal from its durable owner request identity", async () => {
  const controller = await createController("telegram/1:2");
  const ownerClaim = claimDurableTurnFence(
    controller,
    "m-restart-terminal-owner",
  );
  const joinedClaim = claimDurableTurnFence(
    controller,
    "m-restart-joined-input",
  );
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "restart-joined-input.jsonl",
  );
  controller.prepareTurnPrompt = async () => ({
    text: "follow-up during recovery",
    images: [],
    frontendReady: true,
  });
  controller.driver.currentSessionFile = () => sessionFile;
  const joinedOwnerRequestTag = controller.requestTagForInboundMessage(
    ownerClaim.claim.messageId,
    ownerClaim.fence,
  );
  controller.driver.runTurn = async (input: any) => {
    await input.commitNonterminalAcceptance?.({
      requestTag: "request-restart-joined-input",
      joinedRequestTag: joinedOwnerRequestTag,
      sessionFile,
    });
    await controller.handleFrontendEvent({
      type: "turn_accepted",
      requestTag: "request-restart-joined-input",
    });
    return {
      outcome: "nonterminal",
      superseded: true,
      requestTag: "request-restart-joined-input",
      sessionFile,
    };
  };

  await controller.runTurn({
    text: "follow-up during recovery",
    attachments: [],
    incomingMessageId: joinedClaim.claim.messageId,
    replyToMessageId: joinedClaim.claim.messageId,
    requestTag: "request-restart-joined-input",
    outboxTurnFence: joinedClaim.fence,
  });

  const joined = openChatDatabase(controller.agentDir)
    .prepare(
      `SELECT messages.accepted_at,
              inbox_jobs.execution_session_file,
              json_extract(inbox_jobs.admission_json, '$.joinedTurnId') AS joined_turn_id
         FROM inbox_jobs
         JOIN messages ON messages.id = inbox_jobs.inbound_message_id
        WHERE inbox_jobs.turn_id = ?`,
    )
    .get(joinedClaim.claim.itemId);
  assert.ok(joined.accepted_at);
  assert.equal(
    joined.execution_session_file,
    "managed/chat/restart-joined-input.jsonl",
  );
  assert.equal(joined.joined_turn_id, ownerClaim.claim.itemId);
  assert.equal(controller.currentTurn, null);
  assert.equal(
    controller.presentationIncomingMessageId,
    joinedClaim.claim.messageId,
  );
});

test("nonterminal input durably joins the terminal owner and takes presentation ownership", async () => {
  const controller = await createController("telegram/1:2");
  const ownerInbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "m-terminal-owner",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "m-terminal-owner",
      content: "first request",
      stripped: { content: "first request" },
    },
    elements: [{ type: "text", attrs: { content: "first request" } }],
  }).item;
  const ownerClaim = claimChatInboxItem(
    controller.agentDir,
    ownerInbound.itemId,
  );
  const joinedInbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "m-joined-input",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "m-joined-input",
      content: "second request",
      stripped: { content: "second request" },
    },
    elements: [{ type: "text", attrs: { content: "second request" } }],
  }).item;
  const joinedClaim = claimChatInboxItem(
    controller.agentDir,
    joinedInbound.itemId,
  );
  const ownerFence = {
    turnId: ownerClaim.itemId,
    chatKey: controller.chatKey,
    messageId: ownerClaim.messageId,
    ownerEpoch: ownerClaim.ownerEpoch,
    attempt: ownerClaim.attemptCount,
  };
  const joinedFence = {
    turnId: joinedClaim.itemId,
    chatKey: controller.chatKey,
    messageId: joinedClaim.messageId,
    ownerEpoch: joinedClaim.ownerEpoch,
    attempt: joinedClaim.attemptCount,
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: ownerClaim.messageId,
    replyToMessageId: ownerClaim.messageId,
    requestTag: "request-terminal-owner",
    outboxTurnFence: ownerFence,
    workingNoticeSent: false,
  };
  controller.prepareTurnPrompt = async () => ({
    text: "second request",
    images: [],
    frontendReady: true,
  });
  const absoluteSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "joined-input.jsonl",
  );
  controller.driver.currentSessionFile = () => absoluteSessionFile;
  let driverAdmissions = 0;
  controller.driver.runTurn = async (input: any) => {
    driverAdmissions += 1;
    assert.equal(
      controller.pendingTurnPresentations.get("request-joined-input")
        ?.joinedOwnerTurnId,
      ownerClaim.itemId,
    );
    const currentSessionFile = controller.driver.currentSessionFile;
    controller.driver.currentSessionFile = () =>
      path.join(controller.agentDir, "sessions", "mutable-other.jsonl");
    try {
      await input.commitNonterminalAcceptance?.({
        requestTag: "request-joined-input",
        sessionFile: absoluteSessionFile,
      });
    } finally {
      controller.driver.currentSessionFile = currentSessionFile;
    }
    await controller.handleFrontendEvent({
      type: "turn_accepted",
      requestTag: "request-joined-input",
      sessionFile: absoluteSessionFile,
    });
    await controller.handleFrontendEvent({
      type: "assistant_interim",
      requestTag: "request-joined-input",
      text: "response to second request",
    });
    return {
      outcome: driverAdmissions === 1 ? "nonterminal" : "rejoined",
      originalOutcome:
        driverAdmissions === 1 ? undefined : ("nonterminal" as const),
      superseded: true,
      requestTag: "request-joined-input",
      sessionFile: absoluteSessionFile,
    };
  };
  const enqueueAndDrainDelivery =
    controller.enqueueAndDrainDelivery.bind(controller);
  const interimPayloads: any[] = [];
  controller.enqueueAndDrainDelivery = async (payload: any) => {
    interimPayloads.push(payload);
    return { accepted: true, settled: true, messageIds: ["sent-interim"] };
  };

  const joinedTurnInput = {
    text: "second request",
    attachments: [],
    incomingMessageId: joinedClaim.messageId,
    replyToMessageId: joinedClaim.messageId,
    requestTag: "request-joined-input",
    outboxTurnFence: joinedFence,
  };
  const db = openChatDatabase(controller.agentDir);
  const controllerSessionBeforeFailure = controller.state.sessionFile;
  const bindingBeforeFailure = readChatSessionBinding(
    controller.agentDir,
    controller.chatKey,
  );
  db.exec(`CREATE TRIGGER fail_joined_acceptance_once
    BEFORE UPDATE OF accepted_at ON messages
    WHEN NEW.message_id = 'm-joined-input'
    BEGIN
      SELECT RAISE(ABORT, 'simulated_acceptance_commit_crash');
    END`);
  await assert.rejects(
    controller.runTurn(joinedTurnInput),
    /simulated_acceptance_commit_crash/,
  );
  assert.equal(controller.currentIncomingMessageId(), ownerClaim.messageId);
  assert.equal(controller.backendAcceptedIncomingMessageId, "");
  assert.equal(controller.state.sessionFile, controllerSessionBeforeFailure);
  assert.equal(
    readChatSessionBinding(controller.agentDir, controller.chatKey),
    bindingBeforeFailure,
  );
  assert.deepEqual(
    db
      .prepare(
        `SELECT messages.accepted_at,
                json_extract(inbox_jobs.admission_json, '$.joinedTurnId') AS joined_turn_id
           FROM inbox_jobs
           JOIN messages ON messages.id = inbox_jobs.inbound_message_id
          WHERE inbox_jobs.turn_id = ?`,
      )
      .get(joinedClaim.itemId),
    { accepted_at: null, joined_turn_id: null },
  );
  db.exec(`DROP TRIGGER fail_joined_acceptance_once`);

  await controller.runTurn(joinedTurnInput);
  assert.equal(driverAdmissions, 2);

  const joined = db
    .prepare(
      `SELECT messages.accepted_at,
              json_extract(inbox_jobs.admission_json, '$.joinedTurnId') AS joined_turn_id
         FROM inbox_jobs
         JOIN messages ON messages.id = inbox_jobs.inbound_message_id
        WHERE inbox_jobs.turn_id = ?`,
    )
    .get(joinedClaim.itemId);
  assert.ok(joined.accepted_at);
  assert.equal(joined.joined_turn_id, ownerClaim.itemId);
  assert.equal(
    controller.currentTurn.outboxTurnFence.turnId,
    ownerClaim.itemId,
  );

  assert.equal(interimPayloads[0].parts[0].type, "quote");
  assert.equal(interimPayloads[0].parts[0].id, joinedClaim.messageId);
  assert.equal(
    completeClaimedChatInboxItem(controller.agentDir, joinedClaim),
    true,
  );
  assert.equal(
    completeClaimedChatInboxItem(controller.agentDir, ownerClaim),
    true,
  );

  controller.enqueueAndDrainDelivery = enqueueAndDrainDelivery;
  controller.presentationIncomingMessageId = "";
  controller.presentationReplyToMessageId = "";
  controller.setCurrentTurn({
    incomingMessageId: ownerClaim.messageId,
    replyToMessageId: ownerClaim.messageId,
    requestTag: "request-terminal-owner",
    outboxTurnFence: ownerFence,
  });
  const finalDeliveries: any[] = [];
  controller.app.bots[0].sendMessage = async (
    chatId: string,
    content: any,
    options: any,
  ) => {
    finalDeliveries.push({ chatId, content, options });
    return ["sent-final"];
  };
  await controller.settleProjectedTurnComplete({
    finalText: "aggregate final",
    requestTag: "request-terminal-owner",
    chatDeliveryContext: {
      chatKey: controller.chatKey,
      turnId: ownerClaim.itemId,
      messageId: ownerClaim.messageId,
    },
    terminalRecord: {
      terminalId: "terminal-joined-owner",
      state: "complete",
    },
  });
  assert.equal(finalDeliveries[0].content[0].type, "quote");
  assert.equal(finalDeliveries[0].content[0].attrs.id, joinedClaim.messageId);

  const legacyFixtureDb = openChatDatabase(controller.agentDir);
  const preservedJoinedUpdatedAt = "2001-02-03T04:05:06.000Z";
  legacyFixtureDb
    .prepare(
      `UPDATE messages
          SET delivery_kind = NULL,
              record_json = json_remove(record_json, '$.deliveryKind'),
              updated_at = ?
        WHERE id = ?`,
    )
    .run(preservedJoinedUpdatedAt, joinedClaim.itemId);
  const joinedBeforeReplay = legacyFixtureDb
    .prepare(
      `SELECT processed_at, delivery_kind, disposition, updated_at
         FROM messages WHERE id = ?`,
    )
    .get(joinedClaim.itemId);
  assert.ok(joinedBeforeReplay.processed_at);
  assert.equal(joinedBeforeReplay.delivery_kind, null);
  assert.equal(joinedBeforeReplay.disposition, "actionable");
  assert.equal(joinedBeforeReplay.updated_at, preservedJoinedUpdatedAt);
  legacyFixtureDb
    .prepare(
      `UPDATE messages
          SET processed_at = NULL,
              delivery_kind = NULL,
              record_json = json_remove(
                record_json,
                '$.processedAt',
                '$.deliveryKind'
              )
        WHERE id = ?`,
    )
    .run(ownerClaim.itemId);
  const canonicalOutbox = legacyFixtureDb
    .prepare(
      `SELECT post_delivery_json, post_delivery_applied_at
         FROM outbox WHERE outbox_id = ?`,
    )
    .get("chat-terminal-joined-owner");
  assert.ok(canonicalOutbox.post_delivery_applied_at);
  const genericAppliedPostDelivery = JSON.parse(
    canonicalOutbox.post_delivery_json,
  );
  delete genericAppliedPostDelivery.markJoinedProcessed;
  legacyFixtureDb
    .prepare(`UPDATE outbox SET post_delivery_json = ? WHERE outbox_id = ?`)
    .run(
      JSON.stringify(genericAppliedPostDelivery),
      "chat-terminal-joined-owner",
    );

  const recoveredController = createRecoveredController(controller);
  let duplicateSends = 0;
  recoveredController.app.bots[0].sendMessage = async () => {
    duplicateSends += 1;
    return ["duplicate-final"];
  };
  const acknowledgements: Array<{ requestTag: string; terminalId: string }> =
    [];
  recoveredController.driver.acknowledgeTerminal = async (
    requestTag: string,
    terminalId: string,
  ) => {
    acknowledgements.push({ requestTag, terminalId });
  };
  const authoritativeTerminal = {
    type: "rpc_turn_event",
    event: "complete",
    finalText: "aggregate final",
    requestTag: "request-terminal-owner",
    chatDeliveryContext: {
      chatKey: controller.chatKey,
      turnId: ownerClaim.itemId,
      messageId: ownerClaim.messageId,
    },
    terminalRecord: {
      terminalId: "terminal-joined-owner",
      state: "complete",
    },
  };
  await recoveredController.driver.projectAuthoritativeTerminal(
    authoritativeTerminal,
  );
  assert.equal(duplicateSends, 0);
  assert.deepEqual(acknowledgements, []);
  const missingMarkerDb = openChatDatabase(controller.agentDir);
  assert.equal(
    missingMarkerDb
      .prepare(`SELECT processed_at FROM messages WHERE id = ?`)
      .get(ownerClaim.itemId).processed_at,
    null,
  );

  missingMarkerDb
    .prepare(`UPDATE outbox SET post_delivery_json = ? WHERE outbox_id = ?`)
    .run(canonicalOutbox.post_delivery_json, "chat-terminal-joined-owner");
  missingMarkerDb
    .prepare(
      `UPDATE inbox_jobs
          SET admission_json = json_set(
                admission_json,
                '$.settledOutboxId',
                'chat-terminal-conflict'
              )
        WHERE turn_id = ?`,
    )
    .run(joinedClaim.itemId);
  await recoveredController.driver.projectAuthoritativeTerminal(
    authoritativeTerminal,
  );
  assert.equal(duplicateSends, 0);
  assert.deepEqual(acknowledgements, []);
  const conflictingDb = openChatDatabase(controller.agentDir);
  assert.equal(
    conflictingDb
      .prepare(`SELECT processed_at FROM messages WHERE id = ?`)
      .get(ownerClaim.itemId).processed_at,
    null,
  );
  assert.equal(
    conflictingDb
      .prepare(
        `SELECT post_delivery_applied_at FROM outbox WHERE outbox_id = ?`,
      )
      .get("chat-terminal-joined-owner").post_delivery_applied_at,
    canonicalOutbox.post_delivery_applied_at,
  );
  conflictingDb
    .prepare(
      `UPDATE inbox_jobs
          SET admission_json = json_remove(
                admission_json,
                '$.settledOutboxId'
              )
        WHERE turn_id = ?`,
    )
    .run(joinedClaim.itemId);
  await recoveredController.driver.projectAuthoritativeTerminal(
    authoritativeTerminal,
  );

  assert.equal(duplicateSends, 0);
  assert.deepEqual(acknowledgements, [
    {
      requestTag: "request-terminal-owner",
      terminalId: "terminal-joined-owner",
    },
  ]);
  const appliedRepairDb = openChatDatabase(controller.agentDir);
  const appliedRepair = appliedRepairDb
    .prepare(
      `SELECT inbox_jobs.turn_id, messages.processed_at,
              messages.delivery_kind, messages.updated_at,
              json_extract(inbox_jobs.admission_json, '$.settledOutboxId') AS outbox_id
         FROM inbox_jobs
         JOIN messages ON messages.id = inbox_jobs.inbound_message_id
        WHERE inbox_jobs.turn_id IN (?, ?)
        ORDER BY inbox_jobs.turn_id`,
    )
    .all(ownerClaim.itemId, joinedClaim.itemId);
  const appliedRepairOwner = appliedRepair.find(
    (row) => row.turn_id === ownerClaim.itemId,
  );
  assert.ok(appliedRepairOwner.processed_at);
  assert.equal(appliedRepairOwner.delivery_kind, "outbox_final");
  const appliedRepairJoined = appliedRepair.find(
    (row) => row.turn_id === joinedClaim.itemId,
  );
  assert.equal(appliedRepairJoined.delivery_kind, null);
  assert.equal(appliedRepairJoined.outbox_id, "chat-terminal-joined-owner");
  assert.equal(
    appliedRepairJoined.processed_at,
    joinedBeforeReplay.processed_at,
  );
  assert.equal(appliedRepairJoined.updated_at, joinedBeforeReplay.updated_at);

  const mismatchedPostDelivery = JSON.parse(canonicalOutbox.post_delivery_json);
  mismatchedPostDelivery.markJoinedProcessed.ownerTurnId = "wrong-owner-turn";
  appliedRepairDb
    .prepare(
      `UPDATE messages
          SET processed_at = NULL,
              delivery_kind = NULL,
              session_file = NULL,
              record_json = json_remove(
                record_json,
                '$.processedAt',
                '$.deliveryKind',
                '$.sessionFile'
              )
        WHERE id IN (?, ?)`,
    )
    .run(ownerClaim.itemId, joinedClaim.itemId);
  appliedRepairDb
    .prepare(
      `UPDATE inbox_jobs
          SET admission_json = json_remove(
                admission_json,
                '$.settledOutboxId'
              )
        WHERE turn_id = ?`,
    )
    .run(joinedClaim.itemId);
  appliedRepairDb
    .prepare(
      `UPDATE outbox
          SET post_delivery_json = ?, post_delivery_applied_at = NULL
        WHERE outbox_id = ?`,
    )
    .run(JSON.stringify(mismatchedPostDelivery), "chat-terminal-joined-owner");

  const unappliedController = createRecoveredController(controller);
  unappliedController.app.bots[0].sendMessage = async () => {
    duplicateSends += 1;
    return ["duplicate-final"];
  };
  const unappliedAcknowledgements: Array<{
    requestTag: string;
    terminalId: string;
  }> = [];
  unappliedController.driver.acknowledgeTerminal = async (
    requestTag: string,
    terminalId: string,
  ) => {
    unappliedAcknowledgements.push({ requestTag, terminalId });
  };
  await unappliedController.driver.projectAuthoritativeTerminal(
    authoritativeTerminal,
  );
  assert.equal(duplicateSends, 0);
  assert.deepEqual(unappliedAcknowledgements, []);
  const rejectedDb = openChatDatabase(controller.agentDir);
  assert.equal(
    rejectedDb
      .prepare(
        `SELECT post_delivery_applied_at FROM outbox WHERE outbox_id = ?`,
      )
      .get("chat-terminal-joined-owner").post_delivery_applied_at,
    null,
  );
  assert.deepEqual(
    rejectedDb
      .prepare(
        `SELECT id, processed_at, session_file
           FROM messages WHERE id IN (?, ?) ORDER BY id`,
      )
      .all(ownerClaim.itemId, joinedClaim.itemId),
    [
      { id: joinedClaim.itemId, processed_at: null, session_file: null },
      { id: ownerClaim.itemId, processed_at: null, session_file: null },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );

  rejectedDb
    .prepare(`UPDATE outbox SET post_delivery_json = ? WHERE outbox_id = ?`)
    .run(canonicalOutbox.post_delivery_json, "chat-terminal-joined-owner");
  rejectedDb
    .prepare(
      `CREATE TRIGGER force_generic_post_delivery_failure
       BEFORE UPDATE OF session_file ON messages
       WHEN NEW.session_file IS NOT OLD.session_file
       BEGIN
         SELECT RAISE(ABORT, 'forced_generic_post_delivery_failure');
       END`,
    )
    .run();
  await unappliedController.driver.projectAuthoritativeTerminal(
    authoritativeTerminal,
  );

  assert.equal(duplicateSends, 0);
  assert.deepEqual(unappliedAcknowledgements, []);
  const interruptedDb = openChatDatabase(controller.agentDir);
  assert.equal(
    interruptedDb
      .prepare(
        `SELECT post_delivery_applied_at FROM outbox WHERE outbox_id = ?`,
      )
      .get("chat-terminal-joined-owner").post_delivery_applied_at,
    null,
  );
  const interruptedMessages = interruptedDb
    .prepare(
      `SELECT inbox_jobs.turn_id, messages.processed_at, messages.session_file
         FROM inbox_jobs
         JOIN messages ON messages.id = inbox_jobs.inbound_message_id
        WHERE inbox_jobs.turn_id IN (?, ?)`,
    )
    .all(ownerClaim.itemId, joinedClaim.itemId);
  assert.ok(
    interruptedMessages.find((row) => row.turn_id === ownerClaim.itemId)
      .processed_at,
  );
  const interruptedJoined = interruptedMessages.find(
    (row) => row.turn_id === joinedClaim.itemId,
  );
  assert.equal(interruptedJoined.processed_at, null);
  assert.equal(interruptedJoined.session_file, null);
  interruptedDb
    .prepare(`DROP TRIGGER force_generic_post_delivery_failure`)
    .run();

  await unappliedController.driver.projectAuthoritativeTerminal(
    authoritativeTerminal,
  );

  assert.equal(duplicateSends, 0);
  assert.deepEqual(unappliedAcknowledgements, [
    {
      requestTag: "request-terminal-owner",
      terminalId: "terminal-joined-owner",
    },
  ]);
  const recoveredDb = openChatDatabase(controller.agentDir);
  assert.equal(
    recoveredDb
      .prepare(
        `SELECT COUNT(*) AS count FROM outbox
          WHERE turn_id = ? AND outbox_id = ?`,
      )
      .get(ownerClaim.itemId, "chat-terminal-joined-owner").count,
    1,
  );
  const processed = recoveredDb
    .prepare(
      `SELECT inbox_jobs.turn_id, messages.processed_at,
              messages.delivery_kind, messages.session_file,
              json_extract(inbox_jobs.admission_json, '$.settledOutboxId') AS outbox_id
         FROM inbox_jobs
         JOIN messages ON messages.id = inbox_jobs.inbound_message_id
        WHERE inbox_jobs.turn_id IN (?, ?)
        ORDER BY inbox_jobs.turn_id`,
    )
    .all(ownerClaim.itemId, joinedClaim.itemId);
  assert.equal(processed.length, 2);
  for (const row of processed) assert.ok(row.processed_at);
  const processedOwner = processed.find(
    (row) => row.turn_id === ownerClaim.itemId,
  );
  assert.equal(processedOwner.delivery_kind, "outbox_final");
  const processedJoined = processed.find(
    (row) => row.turn_id === joinedClaim.itemId,
  );
  assert.equal(processedJoined.delivery_kind, "outbox_final");
  assert.equal(processedJoined.outbox_id, "chat-terminal-joined-owner");
  assert.equal(processedJoined.session_file, "managed/chat/joined-input.jsonl");
  assert.ok(
    recoveredDb
      .prepare(
        `SELECT post_delivery_applied_at FROM outbox WHERE outbox_id = ?`,
      )
      .get("chat-terminal-joined-owner").post_delivery_applied_at,
  );
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
    .update(JSON.stringify({ text: "Error: boom", parts: [] }))
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
  controller.driver.frontendState.working = true;
  controller.driver.isWorking = () => true;

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
  controller.driver.isWorking = () => false;

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

test("chat controller polls typing without repeating the fixed working reaction", async () => {
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
  controller.driver.frontendState.working = true;

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

  controller.lastWorkingIndicatorAt -= 4_000;
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
  ]);
  assert.deepEqual(reactions, [["create", "2", "m1", "🤔"]]);
});

test("chat controller polls static editable Working on the platform heartbeat", async () => {
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
  controller.driver.isWorking = () => true;

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(calls, [
    ["typing", 0],
    ["edit", 0],
    ["typing", 0],
  ]);

  controller.lastTypingIndicatorAt -= 9_000;
  controller.lastWorkingIndicatorAt -= 9_000;
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(calls, [
    ["typing", 0],
    ["edit", 0],
    ["typing", 0],
    ["typing", 1],
    ["edit", 1],
    ["typing", 1],
  ]);
});

test("chat controller starts typing and editable Working concurrently", async () => {
  const controller = await createController("discord/1:2");
  const calls: string[] = [];
  let releaseTyping!: () => void;
  const typingAccepted = new Promise<void>((resolve) => {
    releaseTyping = resolve;
  });
  controller.app.bots[0].platform = "discord";
  controller.app.bots[0].getWorkingIndicators = () => [
    {
      type: "polling",
      presentation: "typing",
      async tick() {
        calls.push("typing:start");
        await typingAccepted;
        calls.push("typing:accepted");
        return true;
      },
    },
    {
      type: "polling",
      presentation: "editable-message",
      async tick() {
        calls.push("working:visible");
        return true;
      },
    },
  ];
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-typing-before-working",
    workingNoticeSent: false,
  };
  controller.driver.isWorking = () => true;

  const poll = controller.pollTyping();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["typing:start", "working:visible"]);

  releaseTyping();
  assert.equal(await poll, true);
  assert.deepEqual(calls, [
    "typing:start",
    "working:visible",
    "typing:accepted",
    "typing:start",
    "typing:accepted",
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
        type: "agent_start",
        working: true,
      });
      await controller.handleSessionEvent({
        type: "agent_end",
        working: false,
      });
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
          type: "agent_start",
          working: true,
        });
        await controller.handleSessionEvent({
          type: "agent_end",
          working: false,
        });
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
  controller.driver.frontendState.working = true;

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

test("chat controller routes an exact active terminal through its live presentation owner", async () => {
  const controller = await createController(
    "discord/guild:terminal-live-owner",
  );
  (controller as any).currentTurn = {
    requestTag: "chat-inbox-live-terminal",
  };

  assert.equal(
    controller.ownsAuthoritativeTerminalProjection({
      requestTag: "chat-inbox-live-terminal",
    }),
    true,
  );
  assert.equal(
    controller.ownsAuthoritativeTerminalProjection({
      requestTag: "chat-inbox-another-terminal",
    }),
    false,
  );
  assert.equal(controller.ownsAuthoritativeTerminalProjection({}), false);
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
              return editableTicks === 1;
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
  controller.driver.frontendState.working = true;

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
    assert.equal(editableTicks, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("chat controller establishes typing and editable progress from backend Working", async () => {
  const controller = await createController("discord/bot-1:channel-1");
  let typingTicks = 0;
  let editableTicks = 0;
  let releaseTyping!: () => void;
  const typingMayFinish = new Promise<void>((resolve) => {
    releaseTyping = resolve;
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
              editableTicks += 1;
              return true;
            },
          },
          {
            type: "polling",
            presentation: "typing",
            async tick() {
              typingTicks += 1;
              await typingMayFinish;
              return true;
            },
          },
        ],
      },
    ],
  };

  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-discord-start",
    replyToMessageId: "m-discord-start",
    workingNoticeSent: false,
  };
  controller.awaitingTurnSettle = true;
  controller.driver.isWorking = () => true;

  await controller.handleFrontendEvent({
    type: "working_state",
    working: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typingTicks, 1);
  assert.equal(editableTicks, 1);
  releaseTyping();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typingTicks, 2);
  assert.equal(await controller.pollTyping(), false);
  assert.equal(typingTicks, 2);
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
  controller.driver.frontendState.working = true;

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(calls, ["typing:tick", "reaction:tick"]);
  assert.equal(await controller.clearWorkingReaction(), true);
  assert.deepEqual(calls, ["typing:tick", "reaction:tick", "reaction:end"]);
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
      type: "agent_start",
      working: true,
    });
    calls.push("prompt");
    await controller.handleSessionEvent({
      type: "agent_end",
      working: false,
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

test("chat typing and reactions follow only backend Working state", async () => {
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
    type: "agent_start",
    working: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.driver.isWorking(), true);

  await controller.handleSessionEvent({
    type: "agent_end",
    working: false,
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
  controller.awaitingTurnSettle = true;
  controller.stagedDelivery = {
    chatKey: controller.chatKey,
    parts: [{ type: "text", text: "pending" }],
  };

  await controller.clearProcessingState();

  assert.deepEqual(reactions, [["delete", "2", "m-finished", "🤔", "1"]]);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
  assert.equal(controller.stagedDelivery, null);
});

test("chat controller treats rpc completion as the canonical final reply for prompt inbox_jobs", async () => {
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
      .prepare(`SELECT state FROM inbox_jobs WHERE turn_id = ?`)
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
      .prepare(`SELECT state FROM inbox_jobs WHERE turn_id = ?`)
      .get(claim.itemId).state,
    "terminal",
  );
});

test("chat controller leaves confirmed pre-dispatch failure to durable outbox retry", async () => {
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

  const projectionFailures = [];
  const reportFailure = controller.driver.onEventHandlingError;
  controller.driver.onEventHandlingError = async (failure) => {
    projectionFailures.push(failure);
    await reportFailure(failure);
  };
  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-send-fail",
      replyToMessageId: "m-send-fail",
    }),
    /rin_terminal_projection_failed/,
  );

  const stored = getChatMessage(controller.agentDir, chatKey, "m-send-fail");
  const [queued] = listChatOutboxItems(controller.agentDir).map(
    ({ item }) => item,
  );
  assert.ok(stored?.acceptedAt);
  assert.equal(stored?.processedAt, undefined);
  assert.equal(projectionFailures.length, 1);
  assert.match(String(projectionFailures[0].error?.message), /send failed/);
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

test("chat controller renders an empty rpc terminal as the shared frontend error", async () => {
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

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-turn-observed-final",
      replyToMessageId: "m-turn-observed-final",
    }),
    /Agent returned an empty response/,
  );
  assert.deepEqual(deliveries, [
    {
      text: "Agent returned an empty response.",
      replyToMessageId: "m-turn-observed-final",
    },
  ]);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
  assert.equal(await controller.pollTyping(), false);
});

test("chat controller never scans stale session text to repair an empty producer result", async () => {
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

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-turn-empty-final",
      replyToMessageId: "m-turn-empty-final",
    }),
    /Agent returned an empty response/,
  );
  assert.deepEqual(deliveries, [
    {
      text: "Agent returned an empty response.",
      replyToMessageId: "m-turn-empty-final",
    },
  ]);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
  assert.equal(await controller.pollTyping(), false);
});

test("chat controller rejects a linked reply session as a non-/new switch", async () => {
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

  await assert.rejects(
    () =>
      controller.runTurn({
        text: "continue",
        attachments: [],
        sessionFile: linkedSessionFile,
      }),
    /frontend_session_switch_requires_new/,
  );

  assert.deepEqual(operations, []);
  assert.equal(controller.state.sessionFile, undefined);
});

test("chat controller fails fast when prompt submission is rejected while disconnected instead of hanging forever", async () => {
  const controller = await createController("telegram/1:2");
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/offline-chat.jsonl",
      getSessionId: () => "session-offline",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/offline-chat.jsonl",
      sessionId: "session-offline",
    }),
    prompt: async () => {
      throw new Error("rin_frontend_disconnected");
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-offline",
    }),
    /rin_frontend_disconnected/,
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

test("chat controller preconnects an explicit startup recovery session", async () => {
  const controller = await createController("telegram/1:2");
  delete controller.connect;
  controller.state.sessionFile = "other-chat.jsonl";
  const explicitSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "startup-recovery.jsonl",
  );
  await fs.mkdir(path.dirname(explicitSessionFile), { recursive: true });
  await fs.writeFile(explicitSessionFile, "", "utf8");
  const attempts = [];
  controller.driver.connect = async ({ restoreSessionFile = "" } = {}) => {
    attempts.push(restoreSessionFile);
    return true;
  };

  await controller.connect({
    restoreSessionFile: "startup-recovery.jsonl",
    recoverTerminals: false,
  });

  assert.deepEqual(attempts, [explicitSessionFile]);
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
      type: "agent_start",
      working: true,
    });
    calls.push("prompt");
    await promptMayFinish;
    await controller.handleSessionEvent({
      type: "agent_end",
      working: false,
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
  const controller = await createController("example/1:2");
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

test(
  "a settling terminal cannot clear or unquote a newer turn",
  { timeout: 5_000 },
  async () => {
    const controller = await createController("telegram/1:2");
    for (const messageId of ["m-old-terminal", "m-new-turn"]) {
      saveChatMessage(controller.agentDir, {
        chatKey: controller.chatKey,
        platform: "telegram",
        botId: "1",
        chatId: "2",
        messageId,
        role: "user",
        receivedAt: new Date().toISOString(),
        text: messageId,
      });
    }
    const deliveries: any[] = [];
    let announceOldTerminalStarted!: () => void;
    const oldTerminalStarted = new Promise<void>((resolve) => {
      announceOldTerminalStarted = resolve;
    });
    let releaseOldTerminal!: () => void;
    const oldTerminalMayFinish = new Promise<void>((resolve) => {
      releaseOldTerminal = resolve;
    });
    controller.app.bots[0].sendMessage = async (
      chatId: string,
      content: any,
      options: any,
    ) => {
      deliveries.push({ chatId, content, options });
      if (deliveries.length === 1) {
        announceOldTerminalStarted();
        await oldTerminalMayFinish;
      }
      return [`sent-${deliveries.length}`];
    };
    controller.currentTurn = {
      startedAt: Date.now(),
      incomingMessageId: "m-old-terminal",
      replyToMessageId: "m-old-terminal",
      requestTag: "request-old-terminal",
      workingNoticeSent: false,
    };
    controller.awaitingTurnSettle = true;

    const settling = controller.settleProjectedTurnComplete({
      finalText: "old final",
      sessionFile: "/tmp/terminal-race.jsonl",
    });
    await oldTerminalStarted;
    const newerTurn = {
      startedAt: Date.now(),
      incomingMessageId: "m-new-turn",
      replyToMessageId: "m-new-turn",
      requestTag: "request-new-turn",
      workingNoticeSent: false,
    };
    controller.currentTurn = newerTurn;
    controller.awaitingTurnSettle = true;
    await controller.deliverAssistantInterim("new progress");
    assert.equal(deliveries[1].content[0].type, "quote");
    assert.equal(deliveries[1].content[0].attrs.id, "m-new-turn");

    releaseOldTerminal();
    await settling;
    assert.equal(controller.currentTurn, newerTurn);
    assert.equal(controller.awaitingTurnSettle, true);
  },
);

test(
  "old indicator cleanup cannot consume a newer turn or its Working owner",
  { timeout: 5_000 },
  async () => {
    const controller = await createController("telegram/1:2");
    const deliveries: any[] = [];
    controller.app.bots[0].sendMessage = async (
      chatId: string,
      content: any,
      options: any,
    ) => {
      deliveries.push({ chatId, content, options });
      return [`sent-${deliveries.length}`];
    };
    let announceOldIndicatorEnd!: () => void;
    const oldIndicatorEndStarted = new Promise<void>((resolve) => {
      announceOldIndicatorEnd = resolve;
    });
    let releaseOldIndicatorEnd!: () => void;
    const oldIndicatorMayEnd = new Promise<void>((resolve) => {
      releaseOldIndicatorEnd = resolve;
    });
    const oldIndicator = {
      type: "polling",
      presentation: "editable-message",
      async end() {
        announceOldIndicatorEnd();
        await oldIndicatorMayEnd;
        return true;
      },
    };
    let newIndicatorEnds = 0;
    const newIndicator = {
      type: "polling",
      presentation: "editable-message",
      async end() {
        newIndicatorEnds += 1;
        return true;
      },
    };
    const oldTurn = {
      startedAt: Date.now(),
      incomingMessageId: "m-old-indicator",
      replyToMessageId: "m-old-indicator",
      requestTag: "request-old-indicator",
      workingNoticeSent: false,
    };
    const newerTurn = {
      startedAt: Date.now(),
      incomingMessageId: "m-new-indicator",
      replyToMessageId: "m-new-indicator",
      requestTag: "request-new-indicator",
      workingNoticeSent: false,
    };
    controller.currentTurn = oldTurn;
    controller.awaitingTurnSettle = true;
    controller.activeWorkingIndicators = [oldIndicator];

    const settlingOld = controller.settleProjectedTurnComplete({
      finalText: "old final",
      sessionFile: "/tmp/indicator-race.jsonl",
    });
    await oldIndicatorEndStarted;
    controller.currentTurn = newerTurn;
    controller.awaitingTurnSettle = true;
    controller.activeWorkingIndicators = [newIndicator];
    releaseOldIndicatorEnd();
    await settlingOld;

    assert.equal(controller.currentTurn, newerTurn);
    assert.equal(controller.awaitingTurnSettle, true);
    assert.deepEqual(controller.activeWorkingIndicators, [newIndicator]);
    assert.equal(newIndicatorEnds, 0);

    await controller.settleProjectedTurnComplete({
      finalText: "new final",
      sessionFile: "/tmp/indicator-race.jsonl",
    });
    assert.equal(controller.currentTurn, null);
    assert.deepEqual(controller.activeWorkingIndicators, []);
    assert.equal(newIndicatorEnds, 1);
  },
);

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

test("authoritative terminal replay adopts one outbox after the transport job settled", async () => {
  const controller = await createController("telegram/1:2");
  const inbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "terminal-replay-inbound",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "terminal-replay-inbound",
      content: "run",
      stripped: { content: "run" },
    },
    elements: [{ type: "text", attrs: { content: "run" } }],
  }).item;
  const claim = claimChatInboxItem(controller.agentDir, inbound.itemId);
  assert.equal(completeClaimedChatInboxItem(controller.agentDir, claim), true);
  const payload = {
    createdAt: new Date().toISOString(),
    chatKey: controller.chatKey,
    parts: [{ type: "text", text: "one durable final" }],
  };
  const options = {
    id: "chat-terminal-replay-id",
    idempotencyKey: "chat-terminal-replay-id",
    deliveryKind: "final",
    terminalTurnKind: "final",
    terminalRecordId: "terminal-replay-id",
    terminalTurn: {
      turnId: claim.itemId,
      chatKey: claim.chatKey,
      messageId: claim.messageId,
      executionSessionFile: "terminal-replay.jsonl",
    },
    turnFence: {
      agentDir: controller.agentDir,
      turnId: claim.itemId,
      chatKey: claim.chatKey,
      messageId: claim.messageId,
      ownerEpoch: claim.ownerEpoch,
      attempt: claim.attemptCount,
    },
  };

  assert.equal(
    enqueueChatOutboxPayload(controller.agentDir, payload, options),
    "chat-terminal-replay-id",
  );
  assert.equal(
    enqueueChatOutboxPayload(controller.agentDir, payload, options),
    "chat-terminal-replay-id",
  );
  assert.throws(
    () =>
      enqueueChatOutboxPayload(
        controller.agentDir,
        { ...payload, parts: [{ type: "text", text: "conflicting final" }] },
        {
          ...options,
          id: "chat-terminal-conflicting-id",
          idempotencyKey: "chat-terminal-conflicting-id",
          terminalRecordId: "terminal-conflicting-id",
        },
      ),
    /chat_outbox_idempotency_collision|chat_terminal_turn_mismatch/,
  );
  const db = openChatDatabase(controller.agentDir);
  assert.deepEqual(
    db
      .prepare(`SELECT state, terminal_kind FROM inbox_jobs WHERE turn_id = ?`)
      .get(claim.itemId),
    { state: "terminal", terminal_kind: "outbox_final" },
  );
  assert.equal(
    db
      .prepare(`SELECT COUNT(*) AS count FROM outbox WHERE turn_id = ?`)
      .get(claim.itemId).count,
    1,
  );
});

test("an older terminal settles by its own identity after the presentation advances", async () => {
  const controller = await createController("telegram/1:2");
  const inbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "older-terminal-message",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "older-terminal-message",
      content: "older turn",
      stripped: { content: "older turn" },
    },
    elements: [{ type: "text", attrs: { content: "older turn" } }],
  }).item;
  const claim = claimChatInboxItem(controller.agentDir, inbound.itemId);
  const requestTag = "older-terminal-request";
  const terminalId = "terminal-older-turn";
  const chatDeliveryContext = {
    turnId: claim.itemId,
    chatKey: claim.chatKey,
    messageId: claim.messageId,
  };

  controller.setCurrentTurn({
    incomingMessageId: "newer-message",
    requestTag: "newer-request",
    outboxTurnFence: {
      agentDir: controller.agentDir,
      turnId: "newer-turn",
      chatKey: controller.chatKey,
      messageId: "newer-message",
      ownerEpoch: "newer-epoch",
      attempt: 1,
    },
  });
  controller.awaitingTurnSettle = true;
  const newerTurn = controller.currentTurn;
  await controller.settleProjectedTurnComplete({
    requestTag,
    finalText: "older final",
    sessionFile: "/tmp/older-terminal.jsonl",
    sessionId: "older-terminal",
    chatDeliveryContext,
    terminalRecord: {
      terminalId,
      state: "complete",
      terminalAt: "2026-08-12T03:47:46.000Z",
    },
  });

  const terminalOutbox = readChatOutboxItemById(
    controller.agentDir,
    `chat-${terminalId}`,
  )?.item;
  assert.equal(terminalOutbox?.turnId, claim.itemId);
  assert.equal(terminalOutbox?.payload?.replyToMessageId, undefined);
  assert.equal(deliveryQuoteId(terminalOutbox?.payload), claim.messageId);
  assert.equal(controller.currentTurn, newerTurn);
  assert.equal(controller.awaitingTurnSettle, true);
});

test("authoritative daemon terminal replaces a legacy interrupted inbox fixture", async () => {
  const controller = await createController("telegram/1:2");
  const inbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "terminal-after-interrupt",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "terminal-after-interrupt",
      content: "run",
      stripped: { content: "run" },
    },
    elements: [{ type: "text", attrs: { content: "run" } }],
  }).item;
  const claim = claimChatInboxItem(controller.agentDir, inbound.itemId);
  const db = openChatDatabase(controller.agentDir);
  setLegacyInterruptedInboxFixture(
    controller.agentDir,
    claim,
    "frontend_turn_interrupted",
  );
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, terminal_kind, owner_epoch, attempt FROM inbox_jobs WHERE turn_id = ?`,
      )
      .get(claim.itemId),
    {
      state: "failed",
      terminal_kind: "interrupted",
      owner_epoch: null,
      attempt: claim.attemptCount,
    },
  );

  enqueueChatOutboxPayload(
    controller.agentDir,
    {
      createdAt: new Date().toISOString(),
      chatKey: controller.chatKey,
      parts: [{ type: "text", text: "authoritative late final" }],
    },
    {
      id: "chat-terminal-after-interrupt-id",
      idempotencyKey: "chat-terminal-after-interrupt-id",
      deliveryKind: "final",
      terminalTurnKind: "final",
      terminalRecordId: "terminal-after-interrupt-id",
      terminalTurn: {
        turnId: claim.itemId,
        chatKey: claim.chatKey,
        messageId: claim.messageId,
        executionSessionFile: "terminal-after-interrupt.jsonl",
      },
      turnFence: {
        agentDir: controller.agentDir,
        turnId: claim.itemId,
        chatKey: claim.chatKey,
        messageId: claim.messageId,
        ownerEpoch: claim.ownerEpoch,
        attempt: claim.attemptCount,
      },
    },
  );

  assert.deepEqual(
    db
      .prepare(
        `SELECT state, terminal_kind, last_error
           FROM inbox_jobs WHERE turn_id = ?`,
      )
      .get(claim.itemId),
    { state: "terminal", terminal_kind: "outbox_final", last_error: null },
  );
});

test("daemon terminal refuses to overwrite a Chat-local terminal error", async () => {
  const controller = await createController("telegram/1:2");
  const inbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "terminal-after-local-error",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "terminal-after-local-error",
      content: "run",
      stripped: { content: "run" },
    },
    elements: [{ type: "text", attrs: { content: "run" } }],
  }).item;
  const claim = claimChatInboxItem(controller.agentDir, inbound.itemId);
  const db = openChatDatabase(controller.agentDir);
  const localErrorId = enqueueChatOutboxPayload(
    controller.agentDir,
    {
      createdAt: new Date().toISOString(),
      chatKey: controller.chatKey,
      parts: [{ type: "text", text: "local transport error" }],
    },
    {
      id: `error-${claim.itemId}`,
      idempotencyKey: `error-${claim.itemId}`,
      deliveryKind: "error",
    },
  );
  db.prepare(`UPDATE outbox SET turn_id = ? WHERE outbox_id = ?`).run(
    claim.itemId,
    localErrorId,
  );
  db.prepare(
    `UPDATE inbox_jobs
     SET state = 'terminal', terminal_kind = 'outbox_error',
         owner_epoch = NULL, lease_until = NULL, heartbeat_at = NULL
     WHERE turn_id = ?`,
  ).run(claim.itemId);

  assert.throws(
    () =>
      enqueueChatOutboxPayload(
        controller.agentDir,
        {
          createdAt: new Date().toISOString(),
          chatKey: controller.chatKey,
          parts: [{ type: "text", text: "non-authoritative replacement" }],
        },
        {
          id: "ordinary-terminal-replacement",
          idempotencyKey: "ordinary-terminal-replacement",
          deliveryKind: "final",
          terminalTurnKind: "final",
          terminalRecordId: "terminal-record-not-matching-id",
          terminalTurn: {
            turnId: claim.itemId,
            chatKey: claim.chatKey,
            messageId: claim.messageId,
            executionSessionFile: "terminal-after-local-error.jsonl",
          },
          turnFence: {
            agentDir: controller.agentDir,
            turnId: claim.itemId,
            chatKey: claim.chatKey,
            messageId: claim.messageId,
            ownerEpoch: claim.ownerEpoch,
            attempt: claim.attemptCount,
          },
        },
      ),
    /chat_terminal_record_missing/,
  );
  assert.equal(
    db
      .prepare(`SELECT turn_id FROM outbox WHERE outbox_id = ?`)
      .get(localErrorId).turn_id,
    claim.itemId,
  );

  assert.throws(
    () =>
      enqueueChatOutboxPayload(
        controller.agentDir,
        {
          createdAt: new Date().toISOString(),
          chatKey: controller.chatKey,
          parts: [{ type: "text", text: "authoritative recovered final" }],
        },
        {
          id: "chat-terminal-authoritative-after-local-error",
          idempotencyKey: "chat-terminal-authoritative-after-local-error",
          deliveryKind: "final",
          terminalTurnKind: "final",
          terminalRecordId: "terminal-authoritative-after-local-error",
          terminalTurn: {
            turnId: claim.itemId,
            chatKey: claim.chatKey,
            messageId: claim.messageId,
            executionSessionFile: "terminal-after-local-error.jsonl",
          },
          turnFence: {
            agentDir: controller.agentDir,
            turnId: claim.itemId,
            chatKey: claim.chatKey,
            messageId: claim.messageId,
            ownerEpoch: claim.ownerEpoch,
            attempt: claim.attemptCount,
          },
        },
      ),
    /chat_terminal_turn_mismatch/,
  );

  assert.deepEqual(
    db
      .prepare(`SELECT state, terminal_kind FROM inbox_jobs WHERE turn_id = ?`)
      .get(claim.itemId),
    { state: "terminal", terminal_kind: "outbox_error" },
  );
  assert.equal(
    db
      .prepare(`SELECT turn_id FROM outbox WHERE outbox_id = ?`)
      .get(localErrorId).turn_id,
    claim.itemId,
  );
});

test("resumeTurn primes the recovered presentation before an admitted startup connect", async () => {
  const controller = await createController("discord/1:2");
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "startup-recovery-presentation.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "");
  const contexts = [];
  let resumed = false;
  controller.driver.resumeTurn = async () => {
    resumed = true;
    return {
      finalText: "resumed final",
      sessionFile,
      sessionId: "startup-recovery-presentation",
    };
  };

  await controller.resumeTurn(
    {
      incomingMessageId: "recovered-incoming",
      replyToMessageId: "recovered-quote",
      requestTag: "startup-recovery-request",
      sessionFile,
    },
    {
      connect: async () => {
        contexts.push(controller.workingIndicatorContext());
      },
    },
  );

  assert.equal(resumed, true);
  assert.deepEqual(contexts, [
    {
      chatKey: "discord/1:2",
      platform: "discord",
      botId: "1",
      chatId: "2",
      messageId: "recovered-incoming",
      replyToMessageId: "recovered-quote",
      tick: 0,
      todoNoticeText: undefined,
      assistantSummaryText: undefined,
    },
  ]);
});

test("resumeTurn attaches to the durable request without submitting the prompt again", async () => {
  const controller = await createController("telegram/1:2");
  const sessionFile = path.join(
    controller.agentDir,
    "sessions",
    "resumed-session.jsonl",
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "");
  const inbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "resumed-message",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "resumed-message",
      content: "resume",
      stripped: { content: "resume" },
    },
    elements: [{ type: "text", attrs: { content: "resume" } }],
  }).item;
  const claim = claimChatInboxItem(controller.agentDir, inbound.itemId);
  openChatDatabase(controller.agentDir)
    .prepare(
      `UPDATE inbox_jobs SET execution_session_file = ? WHERE turn_id = ?`,
    )
    .run("resumed-session.jsonl", claim.itemId);
  const requestTag = `chat-inbox-${crypto
    .createHash("sha256")
    .update(JSON.stringify([claim.chatKey, claim.messageId, claim.itemId]))
    .digest("hex")}`;
  beginDaemonTurn(controller.agentDir, {
    requestTag,
    sessionFile,
    chatDeliveryContext: {
      turnId: claim.itemId,
      chatKey: claim.chatKey,
      messageId: claim.messageId,
    },
  });
  const terminalEvent = daemonTurnTerminalEvent(
    recordDaemonTurnTerminal(controller.agentDir, {
      requestTag,
      terminalKind: "complete",
      terminalEvent: {
        type: "rpc_turn_event",
        event: "complete",
        requestTag,
        finalText: "resumed final",
        sessionFile,
        sessionId: "resumed-session",
      },
    }),
  );
  let promptSubmissions = 0;
  let resumeSubmissions = 0;
  controller.driver.runTurn = async () => {
    promptSubmissions += 1;
    throw new Error("prompt must not be submitted during recovery");
  };
  controller.driver.resumeTurn = async (input) => {
    resumeSubmissions += 1;
    assert.equal(input.requestTag, requestTag);
    assert.equal(input.sessionFile, sessionFile);
    await controller.handleFrontendEvent({
      type: "turn_complete",
      finalText: terminalEvent.finalText,
      requestTag: terminalEvent.requestTag,
      sessionFile: terminalEvent.sessionFile,
      sessionId: terminalEvent.sessionId,
      chatDeliveryContext: terminalEvent.chatDeliveryContext,
      terminalRecord: terminalEvent.terminalRecord,
    });
    return {
      finalText: terminalEvent.finalText,
      sessionFile,
      sessionId: "resumed-session",
    };
  };

  assert.deepEqual(
    openChatDatabase(controller.agentDir)
      .prepare(
        `SELECT state, owner_epoch, attempt, execution_session_file FROM inbox_jobs WHERE turn_id = ?`,
      )
      .get(claim.itemId),
    {
      state: "running",
      owner_epoch: claim.ownerEpoch,
      attempt: claim.attemptCount,
      execution_session_file: "resumed-session.jsonl",
    },
  );
  controller.state.sessionFile = sessionFile;
  controller.driver.currentSessionFile = () => sessionFile;
  await controller.resumeTurn({
    incomingMessageId: claim.messageId,
    sessionFile,
    outboxTurnFence: {
      turnId: claim.itemId,
      chatKey: claim.chatKey,
      messageId: claim.messageId,
      ownerEpoch: claim.ownerEpoch,
      attempt: claim.attemptCount,
    },
  });

  assert.equal(promptSubmissions, 0);
  assert.equal(resumeSubmissions, 1);
  assert.deepEqual(
    openChatDatabase(controller.agentDir)
      .prepare(
        `SELECT state, terminal_kind, last_error FROM inbox_jobs WHERE turn_id = ?`,
      )
      .get(claim.itemId),
    { state: "terminal", terminal_kind: "outbox_final", last_error: null },
  );
});

test("connect drains an older terminal before restoring the new primed turn", async () => {
  const controller = await createController("telegram/1:2");
  const oldInbound = enqueueChatInboxItem(controller.agentDir, {
    chatKey: controller.chatKey,
    messageId: "old-interrupted-message",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      messageId: "old-interrupted-message",
      content: "old turn",
      stripped: { content: "old turn" },
    },
    elements: [{ type: "text", attrs: { content: "old turn" } }],
  }).item;
  const oldClaim = claimChatInboxItem(controller.agentDir, oldInbound.itemId);
  setLegacyInterruptedInboxFixture(
    controller.agentDir,
    oldClaim,
    "chat_turn_interrupted",
  );
  const requestTag = "old-interrupted-request";
  beginDaemonTurn(controller.agentDir, {
    requestTag,
    sessionFile: "old-session.jsonl",
    chatDeliveryContext: {
      turnId: oldClaim.itemId,
      chatKey: oldClaim.chatKey,
      messageId: oldClaim.messageId,
    },
  });
  const terminalEvent = daemonTurnTerminalEvent(
    interruptDaemonTurn(controller.agentDir, requestTag, "rin_worker_exit"),
  );
  const newTurn = {
    startedAt: Date.now(),
    incomingMessageId: "new-message",
    replyToMessageId: "new-message",
    requestTag: "new-request",
    workingNoticeSent: false,
  };
  controller.currentTurn = newTurn;
  controller.awaitingTurnSettle = true;
  controller.connect = ChatController.prototype.connect.bind(controller);
  const acknowledgements = [];
  controller.driver.connect = async () => true;
  controller.driver.acknowledgeTerminal = async (tag, terminalId) => {
    acknowledgements.push({ tag, terminalId });
  };
  controller.driver.recoverUnacknowledgedChatTerminals = async () => {
    assert.equal(controller.currentTurn, newTurn);
    await controller.handleFrontendEvent({
      type: "turn_error",
      error: terminalEvent.error,
      requestTag: terminalEvent.requestTag,
      sessionFile: terminalEvent.sessionFile,
      chatDeliveryContext: terminalEvent.chatDeliveryContext,
      terminalRecord: terminalEvent.terminalRecord,
    });
    return 1;
  };

  await controller.connect();
  assert.equal(controller.currentTurn, newTurn);
  assert.equal(controller.awaitingTurnSettle, true);
  assert.deepEqual(acknowledgements, [
    {
      tag: requestTag,
      terminalId: terminalEvent.terminalRecord.terminalId,
    },
  ]);
  const db = openChatDatabase(controller.agentDir);
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, terminal_kind, last_error
           FROM inbox_jobs WHERE turn_id = ?`,
      )
      .get(oldClaim.itemId),
    { state: "terminal", terminal_kind: "outbox_error", last_error: null },
  );
  assert.equal(
    db
      .prepare(`SELECT COUNT(*) AS count FROM outbox WHERE turn_id = ?`)
      .get(oldClaim.itemId).count,
    1,
  );
});

test("chat controller internal ownership helpers normalize durable and display state", async () => {
  const controller = await createController("telegram/1:2");
  const ControllerClass = controller.constructor;
  const mismatchedStatePath = path.join(controller.dataDir, "mismatched.json");
  await fs.writeFile(
    mismatchedStatePath,
    `${JSON.stringify({ chatKey: "other", sessionFile: "", chatType: "other" })}\n`,
  );
  const variants = [
    new ControllerClass(
      controller.app,
      controller.dataDir,
      "invalid-chat-key",
      {
        logger: controller.logger,
        h: controller.h,
        affectChatBinding: false,
        statePath: mismatchedStatePath,
        sleepAfterIdleMs: -1,
        commandResponses: {},
        useChatFrontendIdentity: false,
      },
    ),
    new ControllerClass(controller.app, controller.dataDir, "telegram/1:3", {
      logger: controller.logger,
      h: controller.h,
      affectChatBinding: false,
      linkDeliveriesToSession: true,
      sleepAfterIdleMs: 5,
      frontendIdentity: { kind: "chat", chatKey: "telegram/1:3" },
    }),
  ];
  variants[0].state.chatType = "private";
  variants[0].state.sessionFile = "../outside.jsonl";
  variants[0].saveState();
  variants[1].state.chatType = "group";
  variants[1].saveState();
  variants[0].driver.connect = async () => false;
  assert.equal(
    await variants[0].connect({
      restoreSession: false,
      recoverTerminals: false,
    }),
    false,
  );
  let recoveredTerminals = 0;
  variants[0].driver.connect = async () => true;
  variants[0].driver.recoverUnacknowledgedChatTerminals = async () => {
    recoveredTerminals += 1;
  };
  variants[0].setCurrentTurn({
    incomingMessageId: "reserved",
    requestTag: "reserved-tag",
  });
  assert.equal(await variants[0].connect(), true);
  assert.equal(recoveredTerminals, 1);
  assert.equal(variants[0].currentIncomingMessageId(), "reserved");
  variants[0].clearCurrentTurn();
  const variantStoredSession = path.join(
    variants[0].agentDir,
    "sessions",
    "stored.jsonl",
  );
  assert.equal(
    variants[0].updateStoredSessionFile(variantStoredSession, {
      persist: true,
    }),
    "stored.jsonl",
  );
  variants[0].state.sessionFile = path.join(
    variants[0].agentDir,
    "sessions",
    "missing.jsonl",
  );
  assert.equal(variants[0].getRecoverableSessionFile(), "");
  variants[0].rememberPromptChatType({ chatType: "private" });
  variants[0].rememberPromptChatType(undefined);
  assert.equal(await variants[0].startWorkingMarker(), false);
  assert.equal(await variants[0].startCompactionWorkingMarker(), false);
  assert.equal(await variants[0].pollCompactionTyping(), false);
  assert.equal(await variants[0].refreshEditableWorkingNotice(), false);
  assert.equal(await variants[0].showAssistantSummary(""), false);
  assert.equal(await variants[0].pollTyping(), false);
  for (const variant of variants) variant.dispose();

  const originalClient = controller.client;
  controller.client = originalClient;
  assert.equal(controller.client, originalClient);
  assert.equal(typeof controller.frontendPhase, "string");
  const restoredSession = path.join(
    controller.agentDir,
    "sessions",
    "restored.jsonl",
  );
  await fs.mkdir(path.dirname(restoredSession), { recursive: true });
  await fs.writeFile(restoredSession, "{}\n");
  controller.state.sessionFile = restoredSession;
  const originalConnect = controller.driver.connect.bind(controller.driver);
  const originalCurrentSessionFile = controller.driver.currentSessionFile.bind(
    controller.driver,
  );
  controller.driver.connect = async () => true;
  controller.driver.currentSessionFile = () => restoredSession;
  assert.equal(
    await ControllerClass.prototype.connect.call(controller, {
      recoverTerminals: false,
    }),
    true,
  );
  controller.driver.connect = originalConnect;
  controller.driver.currentSessionFile = originalCurrentSessionFile;
  assert.equal(
    controller.updateStoredSessionFile(restoredSession, { persist: false }),
    "restored.jsonl",
  );
  assert.doesNotThrow(() =>
    controller.assertRestoredTurnStayedOnSession(
      restoredSession,
      restoredSession,
    ),
  );
  controller.assertRestoredTurnStayedOnSession("", "other");
  assert.throws(
    () =>
      controller.assertRestoredTurnStayedOnSession(
        restoredSession,
        path.join(controller.agentDir, "sessions", "other.jsonl"),
      ),
    /chat_restored_session_mismatch/,
  );
  assert.equal(controller.managedSessionLeafForFreshChat(), undefined);
  controller.state.sessionFile = undefined;
  assert.equal(controller.managedSessionLeafForFreshChat(), "chat");
  controller.rememberPromptChatType({ chatType: "group" });
  assert.equal(controller.state.chatType, "group");
  controller.rememberPromptChatType({ chatType: "invalid" });
  assert.equal(controller.state.chatType, "group");

  controller.state.chatType = "private";
  controller.state.sessionFile = "";
  controller.saveState();
  controller.state.chatType = "unsupported";
  controller.saveState();

  assert.equal(controller.requestTagForInboundMessage(""), "");
  const requestTag = controller.requestTagForInboundMessage("message-1");
  assert.match(requestTag, /^chat-inbox-/);
  const fence = {
    agentDir: controller.agentDir,
    turnId: "turn-1",
    chatKey: controller.chatKey,
    messageId: "message-1",
    ownerEpoch: "epoch-1",
    attempt: 1,
  };
  assert.notEqual(
    controller.requestTagForInboundMessage("message-1", fence),
    requestTag,
  );
  assert.equal(controller.claimsInboundMessage(""), false);
  assert.equal(controller.hasBackendAcceptedInboundMessage(""), false);
  assert.equal(controller.acceptsScopedTurnEvent("anything"), true);

  controller.setCurrentTurn({
    incomingMessageId: " message-1 ",
    replyToMessageId: " reply-1 ",
    receivedAt: "invalid",
    requestTag,
    outboxTurnFence: fence,
    frontendReadyAt: 1,
    backendAcceptedAt: 2,
    workingVisible: true,
    submittedInputWorkingVisible: true,
    commandOwned: true,
  });
  assert.equal(controller.currentIncomingMessageId(), "message-1");
  assert.equal(controller.currentReplyToMessageId(), "reply-1");
  controller.currentTurn.replyToMessageId = undefined;
  assert.equal(controller.currentReplyToMessageId(), "reply-1");
  controller.currentTurn.incomingMessageId = undefined;
  assert.equal(controller.currentReplyToMessageId(), "reply-1");
  controller.currentTurn.incomingMessageId = "message-1";
  controller.currentTurn.replyToMessageId = "reply-1";
  assert.equal(controller.claimsInboundMessage("message-1"), true);
  assert.equal(controller.currentTurnMatches(""), true);
  assert.equal(controller.currentTurnMatches("other"), false);
  assert.equal(controller.hasCurrentTurnMatching("message-1"), true);
  assert.equal(controller.acceptsScopedTurnEvent("other"), false);
  controller.backendAcceptedIncomingMessageId = "message-1";
  assert.equal(controller.hasBackendAcceptedInboundMessage("message-1"), true);
  assert.equal(controller.hasBackendAcceptedInboundMessage("other"), false);
  controller.awaitingTurnSettle = true;
  assert.equal(controller.hasActiveTurn(), true);
  controller.awaitingTurnSettle = false;
  const originalHasActiveTurn = controller.driver.hasActiveTurn.bind(
    controller.driver,
  );
  controller.driver.hasActiveTurn = () => true;
  assert.equal(controller.hasActiveTurn(), true);
  controller.driver.hasActiveTurn = () => false;
  assert.equal(controller.hasActiveTurn(), false);
  controller.driver.hasActiveTurn = originalHasActiveTurn;

  controller.currentTurn.outboxTurnFence = fence;
  assert.equal(controller.acceptsScopedTurnEvent(""), true);
  assert.equal(controller.acceptsScopedTurnEvent(requestTag), true);
  assert.equal(controller.acceptsScopedTurnEvent("mismatch"), false);
  controller.currentTurn.requestTag = undefined;
  assert.equal(
    controller.acceptsScopedTurnEvent("tag-without-expected"),
    false,
  );
  controller.currentTurn.requestTag = requestTag;
  assert.equal(controller.ownsOutboxTurnFence(undefined), false);
  assert.equal(controller.ownsOutboxTurnFence(fence), true);
  assert.equal(
    controller.ownsOutboxTurnFence({ ...fence, ownerEpoch: "other" }),
    false,
  );

  assert.equal(await controller.showWaitingReaction(""), false);
  assert.equal(await controller.showWaitingReaction("waiting-tag"), true);
  assert.equal(await controller.clearWaitingReaction("waiting-tag"), true);
  assert.equal(await controller.clearWaitingReaction(""), false);
  assert.equal(await controller.clearWaitingReaction("missing-tag"), false);
  assert.equal(await controller.clearAllWaitingReactions(), false);
  assert.equal(await controller.startDeferredWorkingReaction(""), false);
  assert.equal(await controller.startBackendAcceptedWorkingReaction(), false);
  controller.waitingReactionCreatesByRequestTag.set(
    "pending-create",
    Promise.resolve(false),
  );
  assert.equal(await controller.clearWaitingReaction("pending-create"), true);
  const originalClearWaitingReaction =
    controller.clearWaitingReaction.bind(controller);
  const originalStartDeferredWorkingReaction =
    controller.startDeferredWorkingReaction.bind(controller);
  controller.waitingReactionsByRequestTag.set("clear-all", "message-clear-all");
  controller.clearWaitingReaction = async () => true;
  controller.startDeferredWorkingReaction = async () => true;
  assert.equal(
    await controller.clearAllWaitingReactions({ startDeferredWorking: true }),
    true,
  );
  controller.clearWaitingReaction = originalClearWaitingReaction;
  controller.startDeferredWorkingReaction =
    originalStartDeferredWorkingReaction;
  controller.deferredWorkingReactionRequestTags.add(requestTag);
  controller.startedReactionRequestTags.add(requestTag);
  controller.currentTurn.requestTag = requestTag;
  const originalStartBackendAcceptedWorkingReaction =
    controller.startBackendAcceptedWorkingReaction.bind(controller);
  controller.startBackendAcceptedWorkingReaction = async () => true;
  assert.equal(await controller.startDeferredWorkingReaction(requestTag), true);
  controller.startBackendAcceptedWorkingReaction =
    originalStartBackendAcceptedWorkingReaction;
  controller.setCurrentTurn({
    incomingMessageId: "backend-working-message",
    requestTag,
  });
  controller.app.bots[0].workingIndicators = [
    {
      type: "polling",
      presentation: "reaction",
      async tick() {
        return true;
      },
    },
  ];
  assert.equal(await controller.startBackendAcceptedWorkingReaction(), true);
  controller.backendAcceptedIncomingMessageId = "backend-only-message";
  assert.equal(controller.ownsInboundMessage("backend-only-message"), true);
  controller.setCurrentTurn({
    incomingMessageId: "message-1",
    replyToMessageId: "reply-1",
    requestTag,
    outboxTurnFence: fence,
  });
  assert.equal(
    controller.currentPresentationForTerminal({
      turnId: "other-turn",
      chatKey: controller.chatKey,
      messageId: "message-1",
    }),
    null,
  );
  assert.equal(
    controller.currentPresentationForTerminal({
      turnId: fence.turnId,
      chatKey: controller.chatKey,
      messageId: "other-message",
    }),
    null,
  );
  assert.equal(
    controller.currentPresentationForTerminal({
      turnId: fence.turnId,
      chatKey: controller.chatKey,
      messageId: "message-1",
    }),
    controller.currentTurn,
  );
  assert.throws(
    () => controller.authoritativeTerminalEvent({}, "complete"),
    /chat_terminal_record_missing/,
  );
  assert.throws(
    () =>
      controller.authoritativeTerminalEvent(
        {
          requestTag,
          chatDeliveryContext: {
            turnId: fence.turnId,
            chatKey: controller.chatKey,
            messageId: "message-1",
          },
          terminalRecord: { terminalId: "terminal-1", state: "error" },
        },
        "complete",
      ),
    /chat_terminal_delivery_mismatch/,
  );
  assert.equal(
    controller.authoritativeTerminalEvent(
      {
        requestTag,
        chatDeliveryContext: {
          turnId: fence.turnId,
          chatKey: controller.chatKey,
          messageId: "message-1",
        },
        terminalRecord: { terminalId: "terminal-1", state: "complete" },
      },
      "complete",
    ).requestTag,
    requestTag,
  );
  assert.equal(
    controller.authoritativeTerminalEvent(
      {
        requestTag,
        chatDeliveryContext: {
          turnId: fence.turnId,
          chatKey: controller.chatKey,
          messageId: "message-1",
        },
        terminalRecord: { terminalId: "terminal-2", state: "interrupted" },
      },
      "error",
    ).terminalRecord.state,
    "interrupted",
  );

  controller.clearCurrentTurnFor("other");
  assert.ok(controller.currentTurn);
  assert.equal(await controller.clearWorkingReactionFor("other"), false);
  const indicatorContext = controller.workingIndicatorContext({ tick: 7 });
  assert.equal(indicatorContext.platform, "telegram");
  assert.equal(indicatorContext.tick, 7);
  assert.equal(
    controller.compactionWorkingIndicatorContext().platform,
    "telegram",
  );
  assert.equal(controller.canDeliverReplies(), true);
  assert.equal(controller.chatPlatform(), "telegram");
  controller.warnTypingIndicatorFailure(new Error("first"), 10);
  controller.warnTypingIndicatorFailure("suppressed", 11);
  assert.equal(controller.getWorkingIndicators().length, 1);
  assert.equal(controller.isQuietModeEnabled(), false);
  controller.quietModeOverride = true;
  assert.equal(controller.isQuietModeEnabled(), true);
  controller.quietModeOverride = false;
  assert.equal(controller.isQuietModeEnabled(), false);
  controller.quietModeOverride = undefined;
  assert.deepEqual(
    await controller.pollWorkingIndicators(
      [
        {
          presentation: "typing",
          async tick() {
            throw new Error("typing failed");
          },
        },
      ],
      controller.workingIndicatorContext(),
      100,
    ),
    [false],
  );

  controller.clearActiveCommandTurnInput();
  assert.equal(controller.ensureVisibleCommandTurn(), false);
  controller.setActiveCommandTurnInput({ incomingMessageId: "command-1" });
  controller.clearCurrentTurn();
  assert.equal(controller.ensureVisibleCommandTurn(), true);
  controller.clearCurrentTurn();
  controller.connect = async () => true;
  const prepared = await controller.prepareTurnPrompt(
    { text: "prepared", attachments: [] },
    false,
  );
  assert.equal(prepared.frontendReady, true);

  const failing = await createController("telegram/1:failure");
  failing.connect = async () => {
    throw new Error("connect failed");
  };
  await assert.rejects(
    () =>
      failing.prepareTurnPrompt(
        {
          text: "failure",
          attachments: [],
          incomingMessageId: "failure-message",
          outboxTurnFence: {
            ...fence,
            agentDir: failing.agentDir,
            chatKey: failing.chatKey,
            messageId: "failure-message",
          },
        },
        true,
      ),
    /connect failed/,
  );
  assert.equal(failing.currentTurn, null);
  failing.dispose();

  assert.equal(await controller.clearReactionWorkingIndicatorFor(""), false);
  assert.equal(
    await controller.clearReactionWorkingIndicatorFor("message-1"),
    false,
  );
  for (const [indicator, eventName] of [
    [{ start: async () => true }, "start"],
    [{ onStart: async () => true }, "start"],
    [{ tick: async () => true }, "tick"],
    [{ onTick: async () => true }, "tick"],
    [{ end: async () => true }, "end"],
    [{ onEnd: async () => true }, "end"],
    [{}, "start"],
    [{}, "tick"],
    [{}, "end"],
  ] as const) {
    assert.equal(
      await controller.callWorkingIndicator(
        indicator,
        eventName,
        controller.workingIndicatorContext(),
      ),
      Object.keys(indicator).length > 0,
    );
  }
  const originalRunTurn = controller.driver.runTurn.bind(controller.driver);
  controller.driver.runTurn = async (input) => input;
  assert.equal(
    (
      await controller.runDriverTurnWithQuietMode(undefined, {
        text: "quiet-default",
      })
    ).text,
    "quiet-default",
  );
  assert.equal(
    (
      await controller.runDriverTurnWithQuietMode(true, {
        text: "quiet-enabled",
      })
    ).text,
    "quiet-enabled",
  );
  controller.driver.runTurn = originalRunTurn;

  controller.clearCurrentTurn();
  const reactionEvents = [];
  controller.app.bots[0].workingIndicators = [
    {
      type: "polling",
      presentation: "reaction",
      async end(context) {
        reactionEvents.push(context.messageId);
        return true;
      },
    },
  ];
  assert.equal(
    await controller.clearReactionWorkingIndicatorFor("reaction-message"),
    true,
  );
  assert.deepEqual(reactionEvents, ["reaction-message"]);
  controller.app.bots[0].getWorkingIndicators = () => undefined;
  assert.deepEqual(controller.getWorkingIndicators(), []);
  delete controller.app.bots[0].getWorkingIndicators;

  const markerEvents = [];
  const marker = {
    type: "marker",
    async start(context) {
      markerEvents.push(["start", context.event]);
      return true;
    },
    async end(context) {
      markerEvents.push(["end", context.event]);
      return true;
    },
  };
  const polling = testPollingIndicator([], []);
  controller.app.bots[0].workingIndicators = [marker, polling];
  assert.equal(await controller.startWorkingMarker(), true);
  const editable = {
    type: "polling",
    presentation: "editable-message",
    async tick() {
      return true;
    },
    async end() {
      return true;
    },
  };
  controller.setCurrentTurn({ incomingMessageId: "editable-message" });
  controller.awaitingTurnSettle = true;
  controller.app.bots[0].workingIndicators = [marker];
  assert.equal(
    await controller.refreshEditableWorkingNotice({ force: true }),
    false,
  );
  controller.app.bots[0].workingIndicators = [editable];
  assert.equal(
    await controller.refreshEditableWorkingNotice({ force: true }),
    true,
  );
  controller.compactionTurn = {
    startedAt: Date.now(),
    incomingMessageId: "compaction-message",
    replyToMessageId: "compaction-reply",
    workingNoticeSent: false,
  };
  controller.app.bots[0].workingIndicators = [editable, polling];
  assert.equal(await controller.pollCompactionTyping(), true);
  controller.setCurrentTurn({ incomingMessageId: "summary-message" });
  controller.awaitingTurnSettle = true;
  assert.equal(await controller.showAssistantSummary(""), false);
  controller.shouldShowTypingIndicator = () => true;
  assert.equal(
    await controller.showAssistantSummary("**latest summary**"),
    true,
  );
  assert.deepEqual(
    controller.currentDeliveryTarget({
      incomingMessageId: "fallback-message",
      replyToMessageId: "fallback-reply",
      outboxTurnFence: fence,
    }),
    {
      incomingMessageId: "summary-message",
      replyToMessageId: "summary-message",
      outboxTurnFence: fence,
    },
  );
  assert.equal(
    await controller.endWorkingIndicatorsForTurn([polling], {
      incomingMessageId: "working-message",
    }),
    false,
  );
  assert.equal(await controller.clearWorkingReaction(), true);
  assert.equal(
    await controller.clearWorkingReaction({ preserveTodoNotice: true }),
    true,
  );
  controller.app.bots[0].workingIndicators = [marker];
  assert.equal(await controller.startCompactionWorkingMarker(), true);
  assert.equal(await controller.clearCompactionWorkingReaction(), true);
  assert.ok(markerEvents.length >= 3);

  const originalStageAssistantDelivery =
    controller.stageAssistantDelivery.bind(controller);
  const originalCommitPendingDelivery =
    controller.commitPendingDelivery.bind(controller);
  const originalMarkProcessedMessage =
    controller.markProcessedMessage.bind(controller);
  const processed = [];
  let deliveryResult = { accepted: true, settled: true };
  controller.stageAssistantDelivery = (input) => {
    controller.stagedDelivery = {
      chatKey: controller.chatKey,
      deliveryKind: input.deliveryKind || "final",
      parts: input.parts || [{ type: "text", text: input.text || "" }],
    };
    return input.text || "";
  };
  controller.commitPendingDelivery = async () => deliveryResult;
  controller.markProcessedMessage = (...args) => processed.push(args);
  assert.equal(
    await controller.deliverAssistantReply({
      text: "without message",
      bindSession: false,
    }),
    "without message",
  );
  controller.setActiveCommandTurnInput({
    incomingMessageId: "error-message",
    outboxTurnFence: fence,
  });
  assert.equal(
    await controller.deliverAssistantReply({
      text: "error delivery",
      parts: [{ type: "text", text: "error delivery" }],
      incomingMessageId: "error-message",
      replyToMessageId: "error-reply",
      sessionFile: "/tmp/error-session.jsonl",
      deliveryKind: "error",
      clearProcessing: true,
    }),
    "error delivery",
  );
  deliveryResult = { accepted: false, settled: true };
  assert.equal(
    await controller.deliverAssistantReply({
      text: "explicit delivery",
      incomingMessageId: "explicit-message",
      idempotencyKey: "explicit-key",
      bindSession: true,
    }),
    "explicit delivery",
  );
  deliveryResult = { accepted: true, settled: false };
  await controller.deliverAssistantReply({
    text: "unsettled delivery",
    incomingMessageId: "unsettled-message",
  });
  assert.equal(processed.length, 2);
  controller.stageAssistantDelivery = originalStageAssistantDelivery;
  controller.commitPendingDelivery = originalCommitPendingDelivery;
  controller.markProcessedMessage = originalMarkProcessedMessage;

  await controller.clearProcessingState();
  controller.dispose();
});
