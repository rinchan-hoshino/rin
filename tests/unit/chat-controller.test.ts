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

const NOTICE_NO_CHANGE = "💡 Self-improve review completed with no changes.";

async function createController(chatKey = "telegram/1:2") {
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

test("chat controller delivers passive notices as distinct short messages", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (chatId, content) => {
    deliveries.push({ chatId, content });
    return [`notice-${deliveries.length}`];
  };

  await controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "self_improve_review_notice",
      status: "completed",
      targets: [],
      changedCount: 0,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deliveries, [
    {
      chatId: "2",
      content: [{ type: "text", attrs: { content: NOTICE_NO_CHANGE } }],
    },
  ]);
});

test("chat controller pulls pending self-improve notices for the current session only", async () => {
  async function createScopedController(chatKey) {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rin-chat-notice-scope-"),
    );
    const dataDir = path.join(tempDir, "data");
    await fs.mkdir(dataDir, { recursive: true });
    const requests = [];
    const client = {
      async connect() {},
      async disconnect() {},
      isConnected() {
        return true;
      },
      subscribe() {
        return () => {};
      },
      async getState() {
        return { sessionFile: "/tmp/current.jsonl" };
      },
      async resumeSession() {},
      async request(command) {
        requests.push(command);
        return {};
      },
    };
    const controller = new ChatController({}, dataDir, chatKey, {
      logger: { info() {}, warn() {} },
      h: {
        text(content) {
          return { type: "text", attrs: { content } };
        },
      },
      frontendClientFactory: () => client,
    });
    return { controller, requests, agentDir: tempDir };
  }

  const group = await createScopedController("telegram/1:-100");
  group.controller.state.sessionFile = "/tmp/group-current.jsonl";
  saveChatMessage(group.agentDir, {
    chatKey: "telegram/1:-100",
    messageId: "group-old",
    role: "user",
    platform: "telegram",
    botId: "1",
    chatId: "-100",
    chatType: "group",
    receivedAt: new Date().toISOString(),
    sessionFile: "/tmp/group-old.jsonl",
  });
  saveChatMessage(group.agentDir, {
    chatKey: "telegram/1:200",
    messageId: "other-private",
    role: "user",
    platform: "telegram",
    botId: "1",
    chatId: "200",
    chatType: "private",
    receivedAt: new Date().toISOString(),
    sessionFile: "/tmp/other-private.jsonl",
  });

  await group.controller.connect({ restoreSession: false });

  assert.deepEqual(group.requests, [
    {
      type: "flush_self_improve_notices",
      sessionFile: "/tmp/current.jsonl",
    },
  ]);

  const privateChat = await createScopedController("telegram/1:200");
  privateChat.controller.state.chatType = "private";
  privateChat.controller.state.sessionFile = "/tmp/private-current.jsonl";
  saveChatMessage(privateChat.agentDir, {
    chatKey: "telegram/1:200",
    messageId: "private-old",
    role: "user",
    platform: "telegram",
    botId: "1",
    chatId: "200",
    chatType: "private",
    receivedAt: new Date().toISOString(),
    sessionFile: "/tmp/private-old.jsonl",
  });
  saveChatMessage(privateChat.agentDir, {
    chatKey: "telegram/1:300",
    messageId: "other-private",
    role: "user",
    platform: "telegram",
    botId: "1",
    chatId: "300",
    chatType: "private",
    receivedAt: new Date().toISOString(),
    sessionFile: "/tmp/other-private.jsonl",
  });
  await privateChat.controller.connect({ restoreSession: false });
  assert.deepEqual(privateChat.requests, [
    {
      type: "flush_self_improve_notices",
      sessionFile: "/tmp/current.jsonl",
    },
  ]);
});

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
          type: "text",
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

test("chat controller pulls self-improve notices after final delivery checkpoint", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.app.bots[0].sendMessage = async (_chatId, content) => {
    const first = Array.isArray(content) ? content[0] : content;
    deliveries.push(first?.attrs?.content || first);
    return [`m${deliveries.length}`];
  };

  const currentSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "managed",
    "chat",
    "checkpoint.jsonl",
  );
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => currentSessionFile,
      getSessionId: () => "session-checkpoint",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: currentSessionFile,
      sessionId: "session-checkpoint",
    }),
    prompt: async (_text, options = {}) => {
      emitRpcTurnComplete(controller, options, "final before notice");
    },
  };
  const originalRequest = controller.client.request.bind(controller.client);
  let flushCount = 0;
  controller.client.request = async (command) => {
    if (command?.type === "flush_self_improve_notices") {
      assert.equal(command.sessionFile, currentSessionFile);
      flushCount += 1;
      if (flushCount === 2) {
        await controller.handleClientEvent({
          type: "ui",
          payload: {
            type: "self_improve_review_notice",
            status: "completed",
            targets: [],
            changedCount: 0,
          },
        });
        return { flushed: 1 };
      }
      return { flushed: 0 };
    }
    return await originalRequest(command);
  };

  const result = await controller.runTurn({ text: "hello", attachments: [] });

  assert.equal(result.finalText, "final before notice");
  assert.deepEqual(deliveries, ["final before notice", NOTICE_NO_CHANGE]);
});

test("chat controller surfaces SDK overflow errors instead of following continuation markers", async () => {
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
        payload: {
          type: "rpc_turn_event",
          event: "error",
          requestTag: options.requestTag,
          error: "context_length_exceeded",
        },
      });
      setTimeout(() => {
        void (async () => {
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
        })();
      }, 5);
    },
  };

  await assert.rejects(
    () => controller.runTurn({ text: "hello", attachments: [] }),
    /context_length_exceeded/,
  );
  assert.deepEqual(deliveries, []);
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
    model: "openai-codex/old",
    thinkingLevel: "low",
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
  assert.deepEqual(deliveries, ["Compacted session."]);
});

test("chat controller sends compaction start notice and reacts on that notice", async () => {
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
    deliveries.push({ text, kind: options?.deliveryKind });
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
    { text: "Compacting...", kind: "passive_notice" },
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
    { text: "Compacting...", kind: "passive_notice" },
    { text: "Compacted from 108,642 tokens", kind: "passive_notice" },
  ]);
});

test("chat controller keeps compaction notice independent from the underlying chat turn", async () => {
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
    deliveries.push({ text, kind: options?.deliveryKind });
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
    { text: "Compacting...", kind: "passive_notice" },
    { text: "Compacted from 108,642 tokens", kind: "passive_notice" },
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
  const controller = await createController();
  controller.deliveryEnabled = false;
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
  assert.equal(backendAbortCalled, false);
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

test("chat controller keeps /status immediate during an active chat turn", async () => {
  const controller = await createController();
  controller.deliveryEnabled = false;
  const calls = [];
  let firstRequestTag = "";
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => "/tmp/old-chat.jsonl",
      getSessionId: () => "session-old",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/old-chat.jsonl",
      sessionId: "session-old",
    }),
    prompt: async (_text, options = {}) => {
      firstRequestTag = options.requestTag || "";
      await controller.handleClientEvent({
        type: "ui",
        payload: { type: "rpc_frontend_status", phase: "working" },
      });
    },
    runCommand: async (commandLine) => {
      calls.push(`runCommand:${commandLine}`);
      return { handled: true, text: "unreachable" };
    },
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

  const status = await Promise.race([
    controller.runCommand("/status", "m-status", "m-status"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("status command queued")), 50),
    ),
  ]);

  assert.equal(status.local, true);
  assert.match(status.text, /Status: working/);
  assert.deepEqual(calls, []);
  assert.equal(controller.currentIncomingMessageId(), "m1");

  await emitRpcTurnComplete(
    controller,
    { requestTag: firstRequestTag },
    "first done",
  );
  assert.equal((await firstTurn).finalText, "first done");
});

test("chat controller uses configured command responses for /compact and /reload", async () => {
  for (const [command, resultText] of [
    ["/compact", "Compacted session."],
    ["/reload", "Reloaded extensions, prompts, skills, and themes."],
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
    assert.deepEqual(deliveries, [resultText]);
  }
});

test("chat controller leaves the working reaction on the active message while steering", async () => {
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
      if (options.streamingBehavior === "steer") return;
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
  });
  await firstPromptStarted;

  const steerResult = await controller.runTurn(
    {
      text: "steer now",
      attachments: [],
      incomingMessageId: "m-steer",
    },
    "steer",
  );

  assert.equal(steerResult.steered, true);
  assert.deepEqual(actions, []);
  assert.deepEqual(reactions, []);
  assert.equal(controller.hasBackendAcceptedInboundMessage("m-steer"), false);

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
      if (options.streamingBehavior === "steer") return;
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
  assert.deepEqual(deliveries, ["boom"]);
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

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
  ]);
  assert.deepEqual(reactions, [["create", "2", "m1", "🤔"]]);

  controller.lastWorkingReactionAt -= 30_000;
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

test("chat controller uses adapter reaction capability for lark working indicators", async () => {
  const controller = await createController("lark:chat-1");
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
  assert.equal(noticeSent, false);
});

test("chat controller uses discord typing and reaction capabilities together", async () => {
  const controller = await createController("discord:channel-1");
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
});

test("chat controller does not deliver text-only assistant messages as interim", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `··· ${text}`,
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
      text: `··· ${text}`,
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
        { text: "··· I will check this", replyToMessageId: "m-tool-interim" },
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
    { text: "··· I will check this", replyToMessageId: "m-tool-interim" },
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
  assert.equal(assistant?.text, "··· I will check this");
  assert.equal(assistant?.sessionFile, "interim-boundary-chat.jsonl");
});

test("chat controller does not treat assistant message updates as interim when a tool boundary follows", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `··· ${text}`,
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
      text: `··· ${text}`,
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
      text: `··· ${text}`,
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
    { type: "text", attrs: { content: "ok" } },
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
      scheduledTaskInitiator: "agent",
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
          error: "fetch failed",
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
    /fetch failed/,
  );

  const assistantError = getChatMessage(controller.agentDir, chatKey, "m1");
  assert.equal(assistantError?.text, "fetch failed");
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
    /rpc_turn_final_output_missing/,
  );
  assert.deepEqual(deliveries, []);
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
    /rpc_turn_final_output_missing/,
  );
  assert.deepEqual(deliveries, []);
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

  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push(this.stagedDelivery?.text || "");
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
      if (options.streamingBehavior === "steer") return;
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
  const firstResult = await firstTurn;
  assert.equal(firstResult.finalText, "done");
  assert.deepEqual(deliveries, ["done"]);
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
