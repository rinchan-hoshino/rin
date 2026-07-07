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
const { getChatMessage, saveChatMessage } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);
const { lookupReplySession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-helpers.js"))
    .href
);
const {
  chatOutboxHistoryItemsDir,
  listChatOutboxItems,
  readChatOutboxItem,
  writeChatOutboxItem,
} = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
);
const { isChatOutboxDeliveryPendingError } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "delivery-errors.js"),
  ).href
);

async function readOnlyChatOutboxHistoryItem(agentDir, status) {
  const dir = chatOutboxHistoryItemsDir(agentDir, status);
  const names = await fs.readdir(dir);
  assert.equal(names.length, 1);
  return readChatOutboxItem(agentDir, path.join(dir, names[0]));
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

test("chat controller delivers compact collapsed notice without summary text", async () => {
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
    deliveries.push(this.stagedDelivery?.text || "");
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
    deliveries.push(this.stagedDelivery?.text || "");
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
    deliveries.push(this.stagedDelivery?.text || "");
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
    deliveries.push(this.stagedDelivery?.text || "");
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
    deliveries.push(this.stagedDelivery?.text || "");
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
    deliveries.push(this.stagedDelivery?.text || "");
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
      deliveries.push(this.stagedDelivery?.text || "");
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

test("chat controller can deliver builtin command image parts", async () => {
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
      text: "usage summary",
      parts: [
        { type: "text", text: "usage summary" },
        { type: "image", path: "/tmp/usage.png", mimeType: "image/png" },
      ],
      sessionFile,
    }),
    switchSession: async () => {},
  };

  await controller.runCommand("/usage", "m-usage", "m-usage");

  assert.equal(deliveries[0].type, "parts_delivery");
  assert.deepEqual(deliveries[0].parts, [
    { type: "quote", id: "m-usage" },
    { type: "text", text: "usage summary" },
    { type: "image", path: "/tmp/usage.png", mimeType: "image/png" },
  ]);
});

test("chat controller starts command reactions from frontend working status", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  controller.app.bots[0].workingIndicators = [
    testPollingIndicator(actions, reactions),
  ];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery?.text || "");
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

test("chat controller sends compaction start notice and reacts on that notice", async () => {
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
      .map((node) => node?.attrs?.content || node?.attrs?.id || "")
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
    { text: "Compacting...", kind: "passive_notice", coalesce: true },
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
    { text: "Compacting...", kind: "passive_notice", coalesce: true },
    {
      text: "Compacted from 108,642 tokens",
      kind: "passive_notice",
      coalesce: false,
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
      .map((node) => node?.attrs?.content || node?.attrs?.id || "")
      .filter(Boolean)
      .join(" ");
    deliveries.push({
      text,
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
    { text: "Compacting...", kind: "passive_notice", coalesce: true },
    {
      text: "Compacted from 108,642 tokens",
      kind: "passive_notice",
      coalesce: true,
    },
  ]);
});

test("chat controller delivers non-deferred passive notices during active turns", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || node?.attrs?.id || "")
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

test("chat controller renders todo notices as markdown for markdown chats", async () => {
  const controller = await createController("telegram/1:2");
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
        content: "⏹️ Keep working\n✅ ~~Ship renderer~~",
      },
    },
  ]);
});

test("chat controller renders todo notices as character fallback for plain chats", async () => {
  const controller = await createController("minecraft/minecraft:overworld");
  controller.app.bots[0].platform = "minecraft";
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
        content: "⏹️ Keep working\n✅ Ship renderer",
      },
    },
  ]);
});

test("chat controller sends structured todo nodes to native todo chats", async () => {
  const controller = await createController("slack/B1:C1");
  controller.app.bots[0].platform = "slack";
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

test("chat controller quiet mode suppresses non-final visible messages", async () => {
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
      .map((node) => node?.attrs?.content || node?.attrs?.id || "")
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
      .map((node) => node?.attrs?.content || node?.attrs?.id || "")
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

test("chat controller runTurn quiet mode option overrides stored chat settings", async () => {
  const quietController = await createController("telegram/1:2");
  const quietDeliveries = [];
  quietController.app.bots[0].sendMessage = async (_chatId, nodes, options) => {
    const text = nodes
      .map((node) => node?.attrs?.content || node?.attrs?.id || "")
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
      .map((node) => node?.attrs?.content || node?.attrs?.id || "")
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
    { text: "… visible interim", kind: "interim" },
    { text: "- [ ] visible todo", kind: "passive_notice" },
  ]);
});

test("chat controller runTurn quiet false allows deferred todo notices", async () => {
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
      .map((node) => node?.attrs?.content || node?.attrs?.id || "")
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

  assert.deepEqual(deliveries, [
    { text: "final", kind: "final" },
    { text: "- [ ] visible deferred todo", kind: "passive_notice" },
  ]);
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
    deliveries.push(this.stagedDelivery?.text || "");
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
    deliveries.push(this.stagedDelivery?.text || "");
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
    deliveries.push(this.stagedDelivery?.text || "");
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
    deliveries.push(this.stagedDelivery?.text || "");
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
});

test("chat controller /new aborts a visible turn before driver live turn exists", async () => {
  const controller = await createController();
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery?.text || "");
    this.stagedDelivery = null;
  };

  const originalBeginVisible =
    controller.beginVisibleProcessingTurn.bind(controller);
  let markVisibleEntered!: () => void;
  let releaseVisible!: () => void;
  const visibleEntered = new Promise<void>((resolve) => {
    markVisibleEntered = resolve;
  });
  const visibleReleased = new Promise<void>((resolve) => {
    releaseVisible = resolve;
  });
  controller.beginVisibleProcessingTurn = async (input: any) => {
    await originalBeginVisible(input);
    markVisibleEntered();
    await visibleReleased;
  };

  let promptCalled = false;
  let abortCalled = false;
  controller.driver.runTurn = async () => {
    promptCalled = true;
    return { finalText: "should not be submitted" };
  };
  controller.driver.interruptActiveTurnLikeTui = () => {
    abortCalled = true;
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
  await visibleEntered;

  const newCommandPromise = controller.runCommand("/new", "m-new", "m-new");
  await new Promise((resolve) => setImmediate(resolve));
  releaseVisible();
  const [newCommand, aborted] = await Promise.all([
    newCommandPromise,
    firstTurn,
  ]);

  assert.equal(newCommand.text, "Started a new session.");
  assert.equal(abortCalled, true);
  assert.equal(promptCalled, false);
  assert.equal(aborted.aborted, true);
  assert.deepEqual(deliveries, ["Started a new session."]);
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
      deliveries.push(this.stagedDelivery?.text || "");
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
          type: "markdown",
          attrs: {
            content: "Compacted from 77,625 tokens",
          },
        },
      ],
    },
  ]);
});

test("chat controller keeps working reaction on current message while steer is queued", async () => {
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
      if (controller.session.isStreaming) return;
      controller.session.isStreaming = true;
      await controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "rpc_turn_event",
          event: "start",
          requestTag: options.requestTag,
        },
      });
      resolveFirstPromptStarted();
      await new Promise((resolve) => {
        releaseFirstPrompt = resolve;
      });
      controller.session.isStreaming = false;
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

  const steerResult = await controller.runTurn(
    {
      text: "steer now",
      attachments: [],
      incomingMessageId: "m-steer",
      replyToMessageId: "m-steer",
    },
    "steer",
  );

  assert.equal(steerResult.steered, true);
  assert.equal(controller.currentTurn?.incomingMessageId, "m-first");
  assert.equal(controller.currentTurn?.replyToMessageId, "m-first");
  assert.equal(controller.hasBackendAcceptedInboundMessage("m-steer"), true);
  assert.equal(controller.ownsInboundMessage("m-steer"), true);
  const steeredState = JSON.parse(
    await fs.readFile(controller.statePath, "utf8"),
  );
  assert.equal(
    steeredState.pendingSteeredDeliveryTargets?.[0]?.incomingMessageId,
    "m-steer",
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
    restoredController.hasPendingSteeredDeliveryTarget("m-steer"),
    true,
  );
  assert.deepEqual(actions, []);
  assert.deepEqual(reactions, []);

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
  assert.equal(activatedState.pendingSteeredDeliveryTargets, undefined);
  assert.equal(controller.currentTurn?.incomingMessageId, "m-steer");
  assert.equal(controller.currentTurn?.replyToMessageId, "m-steer");
  const steeredMessage = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "m-steer",
  );
  assert.ok(
    steeredMessage?.processedAt,
    "steered inbox item should be processed when Pi starts the user message",
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
  assert.equal((await firstTurn).finalText, "done");
});

test("chat controller keeps steering open after assistant tool-call interim", async () => {
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
      if (controller.session.isStreaming) return;
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

  assert.equal(controller.canSteerActiveTurn(), true);
  const steerResult = await controller.runTurn(
    {
      text: "steer now",
      attachments: [],
      incomingMessageId: "m-steer-now",
    },
    "steer",
  );

  assert.equal(steerResult.steered, true);
  assert.deepEqual(promptCalls, [
    { text: "first", streamingBehavior: undefined },
    { text: "steer now", streamingBehavior: "steer" },
  ]);

  releaseFirstPrompt();
  assert.equal((await firstTurn).finalText, "done");
});

test("chat controller delivers visible non-transient command errors", async () => {
  const controller = await createController();
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery?.text || "");
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

  await assert.rejects(controller.runCommand("/reload"), /boom/);
  assert.deepEqual(deliveries, ["rin error: boom"]);
});

test("chat controller keeps transient daemon command errors out of chat replies", async () => {
  const controller = await createController();
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery?.text || "");
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
  assert.deepEqual(deliveries, []);
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

test("chat controller preserves active turn typing when external working ends", async () => {
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

  assert.equal(controller.currentTurn?.incomingMessageId, "m-active-external");
  assert.equal(controller.externalWorkingVisible, false);
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
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
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.pollTyping();
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

test("chat controller keeps typing and working reaction until dispatched final delivery finishes", async () => {
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
        await controller.handleSessionEvent({ type: "agent_start" });
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
    assert.equal(await controller.pollTyping(), true);
    assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
    assert.deepEqual(reactions, [["create", "2", "m-dispatched-final", "🤔"]]);

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

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(calls, ["typing:tick", "reaction:tick"]);
  assert.equal(await controller.clearWorkingReaction(), true);
  assert.deepEqual(calls, ["typing:tick", "reaction:tick", "reaction:end"]);
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
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
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
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
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
  assert.equal(assistant?.text, "… I will check this");
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
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
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
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
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
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
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
  for (const state of [
    { isCompacting: true },
    { sessionRecovering: true },
    { piWorkingVisible: true },
  ]) {
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
    type: "text_delivery",
    chatKey: controller.chatKey,
    text: "pending",
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
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
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

test("chat controller leaves inbound unprocessed when final reply delivery fails", async () => {
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
  controller.app.bots[0].sendMessage = async () => {
    throw new Error("send failed");
  };
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
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-send-fail",
      replyToMessageId: "m-send-fail",
    }),
    /send failed/,
  );

  const stored = getChatMessage(controller.agentDir, chatKey, "m-send-fail");
  assert.ok(stored?.acceptedAt);
  assert.equal(stored?.processedAt, undefined);
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

test("chat controller rejects rpc completion without finalText instead of reusing observed assistant text", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
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
      emitRpcTurnComplete(controller, options, "", {
        messages: [{ type: "text", text: "canonical result text" }],
      });
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
    /rin_turn_result_invariant_failed/,
  );
  assert.deepEqual(deliveries, []);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.awaitingTurnSettle, false);
  assert.equal(await controller.pollTyping(), false);
});

test("chat controller rejects rpc completion without finalText instead of scanning session messages", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
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
      emitRpcTurnComplete(controller, options, "", {
        messages: [{ type: "text", text: "canonical result text" }],
      });
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-turn-missing-final",
      replyToMessageId: "m-turn-missing-final",
    }),
    /rin_turn_result_invariant_failed/,
  );
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

test("chat controller steers an already streaming session instead of waiting for a new owned turn", async () => {
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
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn(
    {
      text: "follow up",
      attachments: [],
      incomingMessageId: "m-steer",
    },
    "steer",
  );

  assert.deepEqual(promptCalls, [
    { text: "follow up", streamingBehavior: "steer" },
  ]);
  assert.equal(result.steered, true);
});

test("chat controller lets steer bypass the owned turn queue while the current turn is still streaming", async () => {
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
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId || null,
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
      if (controller.session.isStreaming) return;
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

  const steerResult = await controller.runTurn(
    {
      text: "steer now",
      attachments: [],
      incomingMessageId: "m-steer-now",
      replyToMessageId: "m-steer-now",
    },
    "steer",
  );

  assert.equal(steerResult.steered, true);
  assert.equal(controller.currentTurn?.incomingMessageId, "m-first");
  assert.deepEqual(promptCalls, [
    { text: "first", streamingBehavior: undefined },
    { text: "steer now", streamingBehavior: "steer" },
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
  const firstResult = await firstTurn;
  assert.equal(firstResult.finalText, "done");
  assert.deepEqual(deliveries, [
    {
      text: "done",
      replyToMessageId: "m-steer-now",
      markProcessedMessageId: "m-steer-now",
    },
  ]);
});

test("chat controller marks superseded restored inbox turns processed without duplicate final delivery", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery?.text || "");
    this.stagedDelivery = null;
  };
  controller.driver.runTurn = async () => ({
    superseded: true,
    sessionFile: "/tmp/restored-chat.jsonl",
    sessionId: "session-restored",
  });
  saveChatMessage(controller.agentDir, {
    chatKey: controller.chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "group",
    messageId: "m-old",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "older restored input",
  });

  const result = await controller.runTurn({
    text: "older restored input",
    attachments: [],
    incomingMessageId: "m-old",
    replyToMessageId: "m-old",
  });

  assert.deepEqual(deliveries, []);
  assert.equal(result.superseded, true);
  const stored = getChatMessage(
    controller.agentDir,
    controller.chatKey,
    "m-old",
  );
  assert.equal(Boolean(stored?.processedAt), true);
});

test("chat controller queues follow-up after an assistant reply is committed", async () => {
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
        emitRpcTurnComplete(controller, firstPromptOptions, "first answer");
        return;
      }

      assert.equal(options.streamingBehavior, undefined);
      emitRpcTurnComplete(controller, options, "second answer");
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

  assert.equal(controller.canSteerActiveTurn(), false);
  const secondTurn = controller.runTurn(
    {
      text: "follow up",
      attachments: [],
      incomingMessageId: "m-second",
      replyToMessageId: "m-second",
    },
    "steer",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(promptCalls, [
    { text: "hello", streamingBehavior: undefined },
  ]);

  releaseFirstPrompt();
  const [firstResult, secondResult] = await Promise.all([
    firstTurn,
    secondTurn,
  ]);

  assert.equal(firstResult.finalText, "first answer");
  assert.equal(secondResult.finalText, "second answer");
  assert.deepEqual(promptCalls, [
    { text: "hello", streamingBehavior: undefined },
    { text: "follow up", streamingBehavior: undefined },
  ]);
  assert.deepEqual(
    deliveries.map((delivery) => delivery.content?.[1]?.attrs?.content),
    ["first answer", "second answer"],
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

test("chat controller preserves a bound session after transient prompt timeout", async () => {
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
  assert.equal(disposed, 1);
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

test("chat controller waits for editable Working before prompt submission and keeps polling", async () => {
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
    calls.push("prompt");
    await promptMayFinish;
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["working:0"]);
  releaseWorking();
  while (!calls.includes("prompt")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.driver.frontendPhase = "working";
  controller.driver.frontendState = { isStreaming: true, turnActive: true };
  controller.lastWorkingIndicatorAt = 0;
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(ticks, [0, 1]);
  releasePrompt();

  const result = await turn;
  assert.equal(result.finalText, "ok");
  assert.deepEqual(calls, ["working:0", "prompt", "working:1", "final"]);
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
  assert.deepEqual(calls, ["pollTyping", "prompt"]);
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
    type: "text_delivery",
    chatKey: controller.chatKey,
    text: "hello",
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
  assert.equal(controller.stagedDelivery?.text, "hello");
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

test("chat controller reuses a queued final outbox item on restart recovery", async () => {
  const controller = await createController("telegram/1:2");
  let sendCount = 0;
  controller.app.bots[0].sendMessage = async () => {
    sendCount += 1;
    if (sendCount === 1) throw new Error("temporary_network_down");
    return [`sent-${sendCount}`];
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
  let items = listChatOutboxItems(controller.agentDir).map(({ item }) => item);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "queued");
  writeChatOutboxItem(controller.agentDir, {
    ...items[0],
    nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
  });

  const recoveredController = createRecoveredController(controller);
  recoveredController.app.bots[0].sendMessage = async () => {
    sendCount += 1;
    return [`sent-${sendCount}`];
  };
  await recoveredController.deliverAssistantReply(input);

  items = listChatOutboxItems(controller.agentDir).map(({ item }) => item);
  const delivered = await readOnlyChatOutboxHistoryItem(
    controller.agentDir,
    "delivered",
  );
  assert.equal(sendCount, 2);
  assert.equal(items.length, 0);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.deliveryResult[0], "sent-2");
});

test("chat controller leaves an in-flight final outbox item pending on restart recovery", async () => {
  const controller = await createController("telegram/1:2");
  let sendCount = 0;
  controller.app.bots[0].sendMessage = async () => {
    sendCount += 1;
    throw new Error("temporary_network_down");
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
  const [item] = listChatOutboxItems(controller.agentDir).map(
    ({ item }) => item,
  );
  writeChatOutboxItem(controller.agentDir, {
    ...item,
    status: "sending",
    nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const recoveredController = createRecoveredController(controller);
  recoveredController.app.bots[0].sendMessage = async () => {
    sendCount += 1;
    return [`sent-${sendCount}`];
  };

  await assert.rejects(
    () => recoveredController.deliverAssistantReply(input),
    (error) => isChatOutboxDeliveryPendingError(error),
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
  assert.equal(items[0].status, "sending");
  assert.equal(message.processedAt, undefined);
});

test("chat controller surfaces a failed final outbox item on restart recovery", async () => {
  const controller = await createController("telegram/1:2");
  let sendCount = 0;
  controller.app.bots[0].sendMessage = async () => {
    sendCount += 1;
    throw new Error("forbidden: bot was kicked");
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
