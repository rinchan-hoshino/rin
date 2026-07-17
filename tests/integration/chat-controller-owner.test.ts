import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

await import("../support/register-chat-controller-owner-fixture.ts");

const { ChatController, loadChatSettings } = await importBuiltModule<
  typeof import("../../src/core/chat/controller.js")
>("dist/core/chat/controller.js");
const ownerFixture = (globalThis as any).__chatControllerOwnerFixture as {
  drainChatOutbox?: (...args: any[]) => unknown;
};

type Call = { type: string; [key: string]: any };

type PromptPlan = {
  admission?: { acceptedAs: "prompt" | "steer" | "followUp" | "rejoin" };
  complete?: boolean;
  error?: Error;
  finalText?: string;
  result?: any;
  sessionFile?: string;
  sessionId?: string;
  superseded?: boolean;
};

class ControllerClient {
  calls: Call[] = [];
  connected = false;
  listener: ((event: any) => void) | undefined;
  sessionFile = "";
  sessionId = "controller-owner-session";
  sessionName = "";
  turnActive = false;
  isStreaming = false;
  isCompacting = false;
  sessionRecovering = false;
  promptPlans: PromptPlan[] = [];
  commandResults = new Map<string, any>();
  commandErrors = new Map<string, unknown>();
  requestErrors = new Map<string, Error>();
  requestResults = new Map<string, any>();
  connectError: Error | undefined;
  sessions: any[] = [];

  record(type: string, values: Record<string, unknown> = {}) {
    this.calls.push({ type, ...values });
  }

  state() {
    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      turnActive: this.turnActive,
      isStreaming: this.isStreaming,
      isCompacting: this.isCompacting,
      sessionRecovering: this.sessionRecovering,
    };
  }

  async connect() {
    this.record("connect");
    if (this.connectError) {
      const error = this.connectError;
      this.connectError = undefined;
      throw error;
    }
    this.connected = true;
  }

  async disconnect() {
    this.record("disconnect");
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }

  subscribe(listener: (event: any) => void) {
    this.record("subscribe");
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  async getState() {
    this.record("getState");
    return this.state();
  }

  async ensureSessionReady(
    restoreSessionFile = "",
    managedSessionLeaf = "",
    resourceOptions?: unknown,
  ) {
    this.record("ensureSessionReady", {
      restoreSessionFile,
      managedSessionLeaf,
      resourceOptions,
    });
    if (restoreSessionFile) this.sessionFile = restoreSessionFile;
    if (!restoreSessionFile && managedSessionLeaf) {
      this.sessionFile = path.join(
        os.tmpdir(),
        `${managedSessionLeaf.replaceAll("/", "-")}.jsonl`,
      );
    }
    return this.state();
  }

  async prompt(text: string, options: any = {}) {
    this.record("prompt", { text, options });
    const plan = this.promptPlans.shift() || {};
    if (plan.error) throw plan.error;
    if (plan.sessionFile) this.sessionFile = plan.sessionFile;
    if (plan.sessionId) this.sessionId = plan.sessionId;
    const admission = plan.admission || { acceptedAs: "prompt" as const };
    this.turnActive = true;
    this.isStreaming = true;
    await this.emitUi({
      type: "rpc_turn_event",
      event: "start",
      requestTag: options.requestTag,
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
    });
    if (plan.complete !== false && admission.acceptedAs === "prompt") {
      queueMicrotask(() => {
        this.turnActive = false;
        this.isStreaming = false;
        void this.emitUi({
          type: "rpc_turn_event",
          event: "complete",
          requestTag: options.requestTag,
          finalText: plan.finalText ?? "controller owner final",
          result: plan.result || {
            messages: [
              {
                role: "assistant",
                content: plan.finalText ?? "controller owner final",
              },
            ],
          },
          sessionFile: this.sessionFile,
          sessionId: this.sessionId,
          superseded: plan.superseded,
        });
      });
    }
    return admission;
  }

  async submit(text: string) {
    return await this.prompt(text);
  }

  async runCommand(commandLine: string) {
    this.record("runCommand", { commandLine });
    if (this.commandErrors.has(commandLine)) {
      throw this.commandErrors.get(commandLine);
    }
    const configured = this.commandResults.get(commandLine);
    if (configured instanceof Error) throw configured;
    return (
      configured || {
        handled: true,
        text: `ran:${commandLine}`,
        sessionFile: this.sessionFile,
        sessionId: this.sessionId,
      }
    );
  }

  async compact(customInstructions?: string, options?: any) {
    this.record("compact", { customInstructions, options });
    const configured = this.commandResults.get("/compact");
    if (configured instanceof Error) throw configured;
    return (
      configured || {
        handled: true,
        text: "compacted",
        sessionFile: this.sessionFile,
      }
    );
  }

  async abort() {
    this.record("abort");
    this.turnActive = false;
    this.isStreaming = false;
  }

  async shutdownSession() {
    this.record("shutdownSession");
  }

  async terminateSession() {
    this.record("terminateSession");
  }

  async resumeSession(sessionFile: string, options?: any) {
    this.record("resumeSession", { sessionFile, options });
    this.sessionFile = sessionFile;
    return this.state();
  }

  async newSession(options: any = {}) {
    this.record("newSession", { options });
    this.sessionId = `controller-owner-${this.calls.length}`;
    this.sessionFile = path.join(
      os.tmpdir(),
      `${String(options.managedSessionLeaf || "new").replaceAll("/", "-")}.jsonl`,
    );
    return {
      cancelled: false,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
    };
  }

  async listSessions() {
    this.record("listSessions");
    return this.sessions;
  }

  async listModels() {
    return [{ provider: "owner", id: "large/model" }];
  }

  async setModel(provider: string, modelId: string, options?: any) {
    this.record("setModel", { provider, modelId, options });
  }

  async setThinkingLevel(level: string, options?: any) {
    this.record("setThinkingLevel", { level, options });
  }

  async resetModelOptionsFromSettings() {
    this.record("resetModelOptionsFromSettings");
  }

  async getMessages() {
    return [];
  }

  async getCommands() {
    return [];
  }

  async getAutocompleteItems() {
    return [];
  }

  async getCommandArgumentCompletions() {
    return [];
  }

  async respondExtensionUi() {}

  async request(command: any) {
    this.record("request", { command });
    const requestError = this.requestErrors.get(command.type);
    if (requestError) throw requestError;
    if (this.requestResults.has(command.type)) {
      return this.requestResults.get(command.type);
    }
    switch (command.type) {
      case "get_state":
        return this.state();
      case "run_command":
        return await this.runCommand(command.commandLine);
      case "set_session_name":
        this.sessionName = command.name;
        return { updated: true };
      case "reset_model_options_from_settings":
        return { reset: true };
      case "resolve_submitted_turn":
        return null;
      case "replay_pending_terminal_turn_event":
        return { replayed: false };
      default:
        return {};
    }
  }

  async send(command: any) {
    return { type: "response", command: command.type, success: true };
  }

  consumeQueuedOfflineOperation() {
    return false;
  }

  async emitUi(payload: any) {
    await this.listener?.({ type: "ui", payload });
  }

  async emitBackend(payload: any) {
    await this.listener?.({ type: "backend_event", payload });
  }
}

type Indicator = {
  type: "polling" | "marker";
  presentation: "typing" | "editable-message" | "reaction" | "message";
  priority?: number;
  tick?: (context: any) => unknown;
  start?: (context: any) => unknown;
  end?: (context: any) => unknown;
};

type HarnessOptions = {
  chatKey?: string;
  state?: Record<string, unknown>;
  client?: ControllerClient;
  indicators?: Indicator[];
  sendError?: Error;
  affectChatBinding?: boolean;
  sleepAfterIdleMs?: number;
  commandResponses?: Record<string, string>;
};

async function createHarness(options: HarnessOptions = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-controller-owner-"),
  );
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const statePath = path.join(root, "controller-state.json");
  if (options.state) {
    await fs.writeFile(statePath, `${JSON.stringify(options.state)}\n`);
  }
  const client = options.client || new ControllerClient();
  const deliveries: Array<{ chatId: string; content: any }> = [];
  const reactions: any[] = [];
  const chatKey = options.chatKey || "telegram/owner-bot:owner-room";
  const platform = chatKey.split("/")[0];
  const botId = chatKey.split("/")[1]?.split(":")[0] || "owner-bot";
  const bot = {
    platform,
    selfId: botId,
    workingIndicators: options.indicators || [],
    async sendMessage(chatId: string, content: any) {
      if (options.sendError) throw options.sendError;
      deliveries.push({ chatId, content });
      return [`delivery-${deliveries.length}`];
    },
    async createReaction(...args: any[]) {
      reactions.push(["create", ...args]);
    },
    async deleteReaction(...args: any[]) {
      reactions.push(["delete", ...args]);
    },
    internal: {
      async sendChatAction(...args: any[]) {
        reactions.push(["typing", ...args]);
      },
    },
  };
  const loggerEntries: any[] = [];
  const h: any = (type: string, attrs: Record<string, unknown> = {}) => ({
    type,
    attrs,
  });
  h.text = (content: string) => ({ type: "text", attrs: { content } });
  h.quote = (id: string) => ({ type: "quote", attrs: { id } });
  const logger = {
    info(...args: any[]) {
      loggerEntries.push(["info", ...args]);
    },
    warn(...args: any[]) {
      loggerEntries.push(["warn", ...args]);
    },
    error(...args: any[]) {
      loggerEntries.push(["error", ...args]);
    },
  };
  const controller = new ChatController({ bots: [bot] }, dataDir, chatKey, {
    logger,
    h,
    affectChatBinding: options.affectChatBinding,
    statePath,
    frontendClientFactory: () => client as any,
    sleepAfterIdleMs: options.sleepAfterIdleMs,
    commandResponses: options.commandResponses,
  });
  const frontendEvents: any[] = [];
  controller.driver.subscribe((event) => frontendEvents.push(event));
  return {
    root,
    statePath,
    controller,
    client,
    deliveries,
    reactions,
    loggerEntries,
    frontendEvents,
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
    async cleanup() {
      controller.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function deliveryText(content: any) {
  return (Array.isArray(content) ? content : [content])
    .map((part) => part?.attrs?.content || part?.text || "")
    .filter(Boolean)
    .join("\n");
}

async function temporarySession(root: string, name = "session.jsonl") {
  const sessionFile = path.join(root, "sessions", name);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "");
  return sessionFile;
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(label);
}

test("controller owns durable session, connection, and lifecycle boundaries", async () => {
  const sessionRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-controller-sessions-"),
  );
  const existing = await temporarySession(sessionRoot, "existing.jsonl");
  const missing = path.join(sessionRoot, "missing.jsonl");
  const h = await createHarness({
    state: { chatKey: "telegram/owner-bot:owner-room", sessionFile: existing },
    sleepAfterIdleMs: 1,
  });
  try {
    assert.equal(h.controller.client, null);
    assert.equal(h.controller.frontendPhase, "idle");
    assert.equal(h.controller.currentSessionId(), "");
    assert.equal(h.controller.claimsInboundMessage(), false);
    assert.equal(h.controller.hasBackendAcceptedInboundMessage(""), false);
    assert.equal(h.controller.hasPendingSteeredDeliveryTarget(""), false);
    assert.equal(h.controller.ownsInboundMessage("unknown"), false);
    assert.equal(h.controller.hasActiveTurn(), false);
    assert.equal(h.controller.canSteerActiveTurn(), false);
    const canSteer = h.controller.driver.canSteerActiveTurn;
    (h.controller.driver as any).canSteerActiveTurn = undefined;
    assert.equal(h.controller.canSteerActiveTurn(), false);
    h.controller.driver.canSteerActiveTurn = canSteer;

    assert.equal(await h.controller.connect(), true);
    assert.equal(h.client.sessionFile, existing);
    assert.equal(h.controller.currentSessionId(), h.client.sessionId);
    assert.equal(await h.controller.connect({ restoreSession: false }), true);

    const unchanged = await h.controller.resumeSessionFile("");
    assert.equal(unchanged.changed, false);
    const resumed = await h.controller.resumeSessionFile(existing);
    assert.equal(resumed.sessionFile, existing);
    await assert.rejects(h.controller.resumeSessionFile(missing), /session/i);

    const liveResolved = h.controller.startLiveTurn();
    assert.equal(h.controller.awaitingTurnSettle, true);
    liveResolved.resolve({ outcome: "resolved" });
    assert.deepEqual(await liveResolved.promise, { outcome: "resolved" });
    assert.equal(h.controller.awaitingTurnSettle, false);

    const liveRejected = h.controller.startLiveTurn();
    liveRejected.reject(new Error("owner rejection"));
    await assert.rejects(liveRejected.promise, /owner rejection/);
    assert.equal(h.controller.awaitingTurnSettle, false);

    h.controller.lastActivityAt = 0;
    assert.equal(await h.controller.sleepIfIdle(), true);
    assert.equal(h.controller.client, null);
    assert.equal(await h.controller.sleepIfIdle(), false);

    await h.controller.connect();
    await h.controller.detachForDaemonShutdown();
    assert.equal(h.controller.client, null);
    assert.ok(h.client.calls.some((call) => call.type === "disconnect"));
  } finally {
    await h.cleanup();
    await fs.rm(sessionRoot, { recursive: true, force: true });
  }

  const stale = await createHarness({
    state: {
      chatKey: "telegram/owner-bot:owner-room",
      sessionFile: missing,
      chatType: "private",
      pendingSteeredDeliveryTargets: [null, {}, { incomingMessageId: "saved" }],
      transient: true,
    },
  });
  try {
    assert.equal(
      stale.controller.hasPendingSteeredDeliveryTarget("saved"),
      true,
    );
    assert.equal(await stale.controller.connect(), true);
    assert.equal(stale.client.sessionFile, "");
    await stale.controller.clearProcessingState();
    const saved = JSON.parse(await fs.readFile(stale.statePath, "utf8"));
    assert.deepEqual(saved, {
      chatKey: "telegram/owner-bot:owner-room",
      chatType: "private",
    });
  } finally {
    await stale.cleanup();
  }

  const shutdown = await createHarness();
  try {
    await shutdown.controller.connect({ restoreSession: false });
    await shutdown.controller.shutdownSession();
    assert.ok(
      shutdown.client.calls.some((call) => call.type === "shutdownSession"),
    );
    assert.equal(shutdown.controller.awaitingTurnSettle, false);
  } finally {
    await shutdown.cleanup();
  }

  const terminated = await createHarness();
  try {
    await terminated.controller.connect({ restoreSession: false });
    await terminated.controller.terminateSession();
    assert.ok(
      terminated.client.calls.some((call) => call.type === "terminateSession"),
    );
    assert.equal(terminated.controller.client, null);
  } finally {
    await terminated.cleanup();
  }
});

test("controller routes prompt sessions, identity, steering, and terminal outcomes", async () => {
  const h = await createHarness();
  try {
    h.client.promptPlans.push({ finalText: "first final" });
    const first = await h.controller.runTurn({
      text: "  first prompt  ",
      attachments: [],
      incomingMessageId: "inbound-1",
      replyToMessageId: "reply-1",
      requestTag: "explicit-owner-tag",
      sessionName: "Owner Session",
      model: "owner/large/model",
      thinkingLevel: "high",
      tools: ["read", "bash"],
      excludeTools: ["bash"],
      disabledRinCapabilities: ["browse"],
      piStartupOptions: { noBuiltinTools: true } as any,
      promptMeta: {
        source: "chat-bridge",
        chatKey: h.controller.chatKey,
        chatType: "private",
        senderId: "owner",
        sentAt: 1,
      },
      deliverFinal: false,
      quietMode: true,
    });
    assert.equal(first.finalText, "first final");
    const firstPrompt = h.client.calls.find((call) => call.type === "prompt");
    assert.equal(firstPrompt.options.requestTag, "explicit-owner-tag");
    assert.match(firstPrompt.text, /first prompt/);
    assert.ok(
      h.client.calls.some(
        (call) => call.type === "ensureSessionReady" && call.managedSessionLeaf,
      ),
    );

    const existing = await temporarySession(h.root, "bound.jsonl");
    h.client.promptPlans.push({ finalText: "bound final" });
    const bound = await h.controller.runTurn({
      text: "bound prompt",
      attachments: [],
      sessionFile: existing,
      incomingMessageId: "inbound-2",
      deliverFinal: false,
    });
    assert.equal(bound.finalText, "bound final");
    assert.equal(h.client.sessionFile, existing);

    await assert.rejects(
      h.controller.runTurn({
        text: "missing prompt",
        attachments: [],
        sessionFile: path.join(h.root, "absent.jsonl"),
        deliverFinal: false,
      }),
      /session/i,
    );

    h.client.promptPlans.push({
      admission: { acceptedAs: "steer" },
      complete: false,
    });
    h.client.turnActive = true;
    h.client.isStreaming = true;
    await h.client.emitBackend({
      type: "status",
      phase: "working",
      turnActive: true,
      isStreaming: true,
    });
    const steered = await h.controller.runTurn({
      text: "steered prompt",
      attachments: [],
      incomingMessageId: "steered-inbound",
      replyToMessageId: "steered-reply",
      deliverFinal: true,
    });
    assert.equal(steered.steered, true);
    assert.equal(
      h.controller.hasPendingSteeredDeliveryTarget("steered-inbound"),
      true,
    );
    assert.equal(
      h.controller.hasBackendAcceptedInboundMessage("steered-inbound"),
      true,
    );
    assert.equal(h.controller.ownsInboundMessage("steered-inbound"), true);

    h.client.turnActive = false;
    h.client.isStreaming = false;
    await h.client.emitBackend({
      type: "status",
      phase: "idle",
      turnActive: false,
      isStreaming: false,
    });
    await h.client.emitBackend({
      type: "user_message_start",
      text: "steered prompt",
      userMessageId: "user-steered",
    });
    await h.settle();
    assert.equal(
      h.controller.hasPendingSteeredDeliveryTarget("steered-inbound"),
      false,
    );
    assert.equal(h.controller.claimsInboundMessage("steered-inbound"), false);

    h.client.turnActive = false;
    h.client.isStreaming = false;
    await h.client.emitUi({ type: "agent_end" });
  } finally {
    await h.cleanup();
  }
});

test("controller delivers final and command outcomes through the real outbox boundary", async () => {
  const h = await createHarness({
    commandResponses: {
      abort: "Owner abort",
      new: "Owner new",
      newCancelled: "Owner cancelled",
      reload: "Owner reload",
      compact: "Owner compact",
    },
  });
  try {
    h.client.promptPlans.push({ finalText: "visible final" });
    const visible = await h.controller.runTurn({
      text: "visible prompt",
      attachments: [],
      incomingMessageId: "visible-inbound",
      replyToMessageId: "visible-reply",
      deliveryIdempotencyKey: "visible-final-key",
    });
    assert.equal(visible.finalText, "visible final");
    assert.ok(
      h.deliveries.some(
        (item) => deliveryText(item.content) === "visible final",
      ),
    );

    const usage = await h.controller.runCommand(
      "/usage",
      "command-reply",
      "command-inbound",
      "ignored-session",
      { source: "chat-bridge", senderId: "owner", chatType: "group" },
    );
    assert.equal(usage.text, "ran:/usage");
    assert.ok(
      h.deliveries.some((item) => deliveryText(item.content) === "ran:/usage"),
    );

    const fresh = await h.controller.runCommand(
      "/new",
      "new-reply",
      "new-inbound",
      "ignored",
    );
    assert.equal(fresh.text, "Owner new");
    assert.ok(h.client.calls.some((call) => call.type === "newSession"));

    const compact = await h.controller.runCommand(
      "/compact facts",
      "compact-reply",
      "compact-inbound",
    );
    assert.equal(compact.text, "Owner compact");

    h.client.commandResults.set("/reload", {
      handled: true,
      text: "driver reload",
      parts: [
        null,
        { type: "image", url: "https://example.invalid/image.png" },
      ],
      sessionFile: h.client.sessionFile,
    });
    const reload = await h.controller.runCommand("/reload");
    assert.equal(reload.text, "Owner reload");
    assert.equal(reload.parts.length, 1);

    h.client.commandResults.set("/usage", {
      handled: true,
      text: "",
      parts: [{ type: "image", url: "https://example.invalid/only.png" }],
    });
    const imageOnly = await h.controller.runCommand("/usage");
    assert.equal(imageOnly.parts.length, 1);

    h.client.commandResults.set("/usage", {
      handled: true,
      text: "",
      parts: [],
    });
    const beforeMissingText = h.deliveries.length;
    await assert.rejects(
      h.controller.runCommand("/usage"),
      /chat_command_text_missing/,
    );
    assert.equal(h.deliveries.length, beforeMissingText + 1);
    assert.ok(deliveryText(h.deliveries.at(-1)?.content));

    h.client.commandResults.set("/usage", new Error("owner command failure"));
    const beforeCommandFailure = h.deliveries.length;
    await assert.rejects(
      h.controller.runCommand("/usage"),
      /owner command failure/,
    );
    assert.equal(h.deliveries.length, beforeCommandFailure + 1);
    assert.ok(deliveryText(h.deliveries.at(-1)?.content));
  } finally {
    await h.cleanup();
  }

  const noBot = await createHarness({ affectChatBinding: false });
  try {
    noBot.controller.app = { bots: [] };
    noBot.client.promptPlans.push({ finalText: "detached final" });
    const result = await noBot.controller.runTurn({
      text: "detached",
      attachments: [],
      incomingMessageId: "detached-inbound",
    });
    assert.equal(result.finalText, "detached final");
    assert.deepEqual(noBot.deliveries, []);
  } finally {
    await noBot.cleanup();
  }
});

test("controller preserves error, cancellation, abort, and restored-session invariants", async () => {
  const h = await createHarness();
  try {
    const existing = await temporarySession(h.root, "error-session.jsonl");
    const promptError = Object.assign(new Error("owner prompt failure"), {
      sessionFile: existing,
      sessionId: "error-session",
    });
    h.client.promptPlans.push({ error: promptError });
    await assert.rejects(
      h.controller.runTurn({
        text: "error prompt",
        attachments: [],
        incomingMessageId: "error-inbound",
        replyToMessageId: "error-reply",
      }),
      /owner prompt failure/,
    );
    assert.ok(
      h.deliveries.some((item) =>
        deliveryText(item.content).includes("owner prompt failure"),
      ),
    );

    const lifecycleError = Object.assign(
      new Error("frontend_turn_cancelled:disposed"),
      { code: "FRONTEND_TURN_CANCELLED" },
    );
    h.client.promptPlans.push({ error: lifecycleError });
    const beforeCancellation = h.deliveries.length;
    await assert.rejects(
      h.controller.runTurn({
        text: "cancelled prompt",
        attachments: [],
        incomingMessageId: "cancelled-inbound",
      }),
      /frontend_turn_cancelled/,
    );
    assert.equal(h.deliveries.length, beforeCancellation);

    const restore = await temporarySession(h.root, "restore-session.jsonl");
    h.client.promptPlans.push({
      sessionFile: await temporarySession(h.root, "wrong-session.jsonl"),
      finalText: "wrong session final",
    });
    await assert.rejects(
      h.controller.runTurn({
        text: "restore mismatch",
        attachments: [],
        sessionFile: restore,
        deliverFinal: false,
      }),
      /chat_restored_session_mismatch/,
    );

    h.client.turnActive = true;
    h.client.isStreaming = true;
    await h.client.emitBackend({
      type: "status",
      phase: "working",
      turnActive: true,
      isStreaming: true,
    });
    const abort = await h.controller.runCommand(
      "/abort",
      "abort-reply",
      "abort-inbound",
    );
    assert.equal(abort.text, "Aborted current operation.");
    assert.equal(h.controller.awaitingTurnSettle, false);
    assert.equal(h.controller.turnAbortRequested, false);
  } finally {
    await h.cleanup();
  }

  const deliveryFailure = await createHarness({
    sendError: new Error("platform delivery failed"),
  });
  try {
    deliveryFailure.client.promptPlans.push({ finalText: "cannot deliver" });
    await assert.rejects(
      deliveryFailure.controller.runTurn({
        text: "delivery error",
        attachments: [],
        incomingMessageId: "delivery-inbound",
      }),
      /platform delivery failed/,
    );
  } finally {
    await deliveryFailure.cleanup();
  }
});

test("controller coordinates typing, visible indicators, summaries, and compaction", async () => {
  const indicatorCalls: any[] = [];
  const indicators: Indicator[] = [
    {
      type: "polling",
      presentation: "typing",
      async tick(context) {
        indicatorCalls.push(["typing", context]);
        return true;
      },
      async end(context) {
        indicatorCalls.push(["typing-end", context]);
        return false;
      },
    },
    {
      type: "polling",
      presentation: "editable-message",
      async tick(context) {
        indicatorCalls.push(["editable", context]);
        return true;
      },
      async end(context) {
        indicatorCalls.push(["editable-end", context]);
        return true;
      },
    },
    {
      type: "polling",
      presentation: "reaction",
      priority: 200,
      async tick(context) {
        indicatorCalls.push(["reaction", context]);
        return true;
      },
      async end(context) {
        indicatorCalls.push(["reaction-end", context]);
        return true;
      },
    },
    {
      type: "marker",
      presentation: "message",
      async start(context) {
        indicatorCalls.push(["marker", context]);
        return true;
      },
      async end(context) {
        indicatorCalls.push(["marker-end", context]);
        return true;
      },
    },
  ];
  const h = await createHarness({ indicators });
  try {
    await h.controller.connect({ restoreSession: false });
    await h.controller.beginExternalWorking();
    assert.equal(h.controller.externalWorkingVisible, true);
    assert.equal(h.controller.awaitingTurnSettle, true);
    assert.ok(indicatorCalls.some(([name]) => name === "editable"));

    h.client.turnActive = true;
    h.client.isStreaming = true;
    await h.client.emitBackend({
      type: "status",
      phase: "working",
      turnActive: true,
      isStreaming: true,
    });
    h.controller.lastTypingIndicatorAt = 0;
    h.controller.lastWorkingIndicatorAt = 0;
    h.controller.lastWorkingReactionAt = 0;
    assert.equal(await h.controller.pollTyping(), true);
    assert.ok(indicatorCalls.some(([name]) => name === "typing"));
    assert.ok(indicatorCalls.some(([name]) => name === "editable"));
    assert.ok(!indicatorCalls.some(([name]) => name === "reaction"));

    await h.client.emitBackend({
      type: "assistant_summary",
      text: "**done**\n\nlatest summary",
    });
    await waitFor(
      () => h.controller.latestAssistantSummaryText === "latest summary",
      `assistant summary reaches editable progress:${JSON.stringify(h.frontendEvents)}`,
    );

    await h.client.emitBackend({
      type: "compaction_start_notice",
      text: "Compacting",
    });
    await waitFor(
      () => h.controller.workingStatusText === "Compacting",
      "compaction start reaches visible progress",
    );
    await h.client.emitBackend({
      type: "passive_notice",
      noticeKind: "compaction_end",
      text: "Compacted from 12,000 tokens",
      deferDuringTurn: false,
    });
    await h.settle();
    assert.equal(h.controller.compactionTurn, null);

    await h.controller.endExternalWorking();
    assert.equal(h.controller.externalWorkingVisible, false);
    await h.controller.clearWorkingReaction({ preserveTodoNotice: true });
    await h.controller.housekeep();
  } finally {
    await h.cleanup();
  }

  const markerCalls: any[] = [];
  const marker = await createHarness({
    indicators: [
      {
        type: "marker",
        presentation: "message",
        async start(context) {
          markerCalls.push(["start", context]);
          return true;
        },
        async end(context) {
          markerCalls.push(["end", context]);
          return true;
        },
      },
    ],
  });
  try {
    await marker.controller.beginExternalWorking();
    assert.ok(markerCalls.some(([name]) => name === "start"));
    await marker.controller.endExternalWorking();
    assert.ok(markerCalls.some(([name]) => name === "end"));
  } finally {
    await marker.cleanup();
  }

  const reactionCalls: any[] = [];
  const reaction = await createHarness({
    indicators: [
      {
        type: "polling",
        presentation: "reaction",
        async tick(context) {
          reactionCalls.push(["tick", context]);
          return true;
        },
        async end(context) {
          reactionCalls.push(["end", context]);
          return true;
        },
      },
    ],
  });
  try {
    await reaction.controller.beginExternalWorking();
    reaction.controller.lastWorkingIndicatorAt = 0;
    reaction.controller.lastWorkingReactionAt = 0;
    assert.equal(await reaction.controller.pollTyping(), true);
    assert.ok(reactionCalls.some(([name]) => name === "tick"));
    await reaction.controller.endExternalWorking();
    assert.ok(reactionCalls.some(([name]) => name === "end"));
  } finally {
    await reaction.cleanup();
  }

  const typingFailure = await createHarness({
    chatKey: "discord/owner-bot:owner-room",
    indicators: [
      {
        type: "polling",
        presentation: "typing",
        async tick() {
          throw new Error("typing unavailable");
        },
      },
    ],
  });
  try {
    await typingFailure.controller.beginExternalWorking();
    typingFailure.controller.lastTypingIndicatorAt = 0;
    await typingFailure.controller.pollTyping();
    await typingFailure.controller.pollTyping();
    assert.equal(
      typingFailure.loggerEntries.filter(([level]) => level === "warn").length,
      1,
    );
  } finally {
    await typingFailure.cleanup();
  }
});

test("controller translates passive, todo, interim, and frontend status events", async () => {
  for (const [chatKey, expectedPartType, expectedText] of [
    ["telegram/owner-bot:markdown", "markdown", "⬜ first"],
    ["onebot/owner-bot:plain", "markdown", "⬜ first"],
    ["slack/owner-bot:native", "todo", ""],
  ] as const) {
    const h = await createHarness({ chatKey });
    try {
      await h.controller.connect({ restoreSession: false });
      await h.client.emitBackend({
        type: "passive_notice",
        noticeKind: "todo",
        deferDuringTurn: false,
        todoItems: [
          { id: 1, text: "first", done: false },
          { id: 2, text: "second", done: true },
        ],
        todoError: "todo warning",
      });
      await waitFor(
        () => h.deliveries.length >= 1,
        `${chatKey} todo delivery events=${JSON.stringify(h.frontendEvents)} logs=${JSON.stringify(h.loggerEntries)}`,
      );
      const flattened = h.deliveries.flatMap((item) => item.content);
      assert.ok(
        flattened.some((part) => part?.type === expectedPartType),
        `${chatKey}:${JSON.stringify(flattened)}`,
      );
      if (expectedText) {
        assert.ok(
          h.deliveries.some((item) =>
            deliveryText(item.content).includes(expectedText),
          ),
          `${chatKey}:${JSON.stringify(h.deliveries)}`,
        );
      }

      await h.client.emitBackend({
        type: "passive_notice",
        text: "immediate notice",
        deferDuringTurn: false,
      });
      await h.settle();
      assert.ok(
        h.deliveries.some((item) =>
          deliveryText(item.content).includes("immediate notice"),
        ),
      );

      await h.client.emitBackend({
        type: "assistant_interim",
        text: "interim text",
      });
      await h.settle();
      assert.ok(
        h.deliveries.some((item) =>
          deliveryText(item.content).includes("interim text"),
        ),
      );

      await h.controller.handleClientEvent(null);
      await h.controller.handleSessionEvent({ type: "unknown" });
      await h.client.emitBackend({ type: "turn_accepted" });
      await h.client.emitBackend({
        type: "status",
        phase: "idle",
        turnActive: false,
        isStreaming: false,
      });
      await h.settle();
    } finally {
      await h.cleanup();
    }
  }

  const quiet = await createHarness();
  try {
    quiet.controller.quietModeOverride = true;
    await quiet.controller.connect({ restoreSession: false });
    await quiet.client.emitBackend({
      type: "passive_notice",
      text: "quiet progress",
      deferDuringTurn: false,
    });
    await quiet.settle();
    assert.equal(quiet.deliveries.length, 0);

    quiet.client.promptPlans.push({ finalText: "quiet final" });
    await quiet.controller.runTurn({
      text: "quiet prompt",
      attachments: [],
      incomingMessageId: "quiet-inbound",
      quietMode: true,
    });
    assert.ok(
      quiet.deliveries.some(
        (item) => deliveryText(item.content) === "quiet final",
      ),
    );
  } finally {
    await quiet.cleanup();
  }
});

test("controller derives todo state from the active persisted user branch", async () => {
  const h = await createHarness({ chatKey: "onebot/owner-bot:todo-room" });
  try {
    const sessionFile = await temporarySession(h.root, "todo-owner.jsonl");
    await fs.writeFile(
      sessionFile,
      `${[
        {
          type: "custom",
          id: "todo-state",
          parentId: null,
          customType: "rin.todo",
          data: {
            todos: [{ id: 1, text: "Persist the owner contract", done: false }],
            nextId: 2,
          },
        },
        {
          type: "message",
          id: "persisted-user",
          parentId: "todo-state",
          message: {
            role: "user",
            content: [{ type: "text", text: "continue" }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    h.client.sessionFile = sessionFile;
    await h.controller.connect({ restoreSession: false });

    h.client.turnActive = true;
    h.client.isStreaming = true;
    await h.client.emitBackend({
      type: "status",
      phase: "working",
      turnActive: true,
      isStreaming: true,
    });
    h.client.promptPlans.push({
      admission: { acceptedAs: "steer" },
      complete: false,
    });
    const steering = await h.controller.runTurn({
      text: "continue",
      attachments: [],
      incomingMessageId: "todo-inbound",
      replyToMessageId: "todo-reply",
    });
    assert.equal(steering.steered, true);

    h.client.turnActive = false;
    h.client.isStreaming = false;
    await h.client.emitBackend({
      type: "status",
      phase: "idle",
      turnActive: false,
      isStreaming: false,
    });
    await h.client.emitBackend({
      type: "user_message_start",
      text: "continue",
      userMessageId: "todo-user-event",
    });
    await h.client.emitBackend({
      type: "user_message_persisted",
      sessionLeafId: "persisted-user",
      userMessageId: "todo-user-event",
    });
    await waitFor(
      () =>
        h.deliveries.some((item) =>
          deliveryText(item.content).includes("Persist the owner contract"),
        ),
      "todo snapshot follows the active persisted user branch",
    );
    const deliveredCount = h.deliveries.length;
    await h.client.emitBackend({
      type: "user_message_persisted",
      sessionLeafId: "persisted-user",
      userMessageId: "todo-user-event",
    });
    await h.settle();
    assert.equal(h.deliveries.length, deliveredCount);

    h.client.promptPlans.push({
      admission: { acceptedAs: "steer" },
      complete: false,
    });
    h.client.turnActive = true;
    h.client.isStreaming = true;
    await h.client.emitBackend({
      type: "status",
      phase: "working",
      turnActive: true,
      isStreaming: true,
    });
    await h.controller.runTurn({
      text: "missing branch",
      attachments: [],
      incomingMessageId: "todo-cancel-inbound",
    });
    h.client.turnActive = false;
    h.client.isStreaming = false;
    await h.client.emitBackend({
      type: "status",
      phase: "idle",
      turnActive: false,
      isStreaming: false,
    });
    await h.client.emitBackend({
      type: "user_message_start",
      text: "missing branch",
      userMessageId: "todo-cancel-start",
    });
    await h.client.emitBackend({
      type: "user_message_persisted",
      sessionLeafId: "not-yet-persisted",
      userMessageId: "todo-cancel-start",
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await h.controller.clearProcessingState();
    assert.equal(h.controller.todoNoticeOperation, null);
  } finally {
    await h.cleanup();
  }
});

test("controller owns non-editable compaction and deferred passive progress", async () => {
  const markerCalls: any[] = [];
  const h = await createHarness({
    indicators: [
      {
        type: "marker",
        presentation: "reaction",
        async start(context) {
          markerCalls.push(["start", context]);
          return true;
        },
        async end(context) {
          markerCalls.push(["end", context]);
          return true;
        },
      },
      {
        type: "polling",
        presentation: "typing",
        async tick(context) {
          markerCalls.push(["typing", context]);
          return true;
        },
      },
    ],
  });
  try {
    await h.controller.connect({ restoreSession: false });
    await h.client.emitBackend({
      type: "compaction_start_notice",
      text: "Compacting owner context",
    });
    await waitFor(
      () => Boolean(h.controller.compactionTurn),
      "non-editable compaction creates a delivery-scoped turn",
    );
    assert.ok(
      h.deliveries.some((item) =>
        deliveryText(item.content).includes("Compacting owner context"),
      ),
    );
    assert.ok(markerCalls.some(([name]) => name === "start"));

    await h.client.emitBackend({
      type: "passive_notice",
      noticeKind: "compaction_end",
      text: "Compacted owner context",
      deferDuringTurn: false,
    });
    await waitFor(
      () => h.controller.compactionTurn === null,
      "compaction end clears its delivery-scoped turn",
    );
    assert.ok(markerCalls.some(([name]) => name === "end"));

    await h.controller.beginExternalWorking();
    await h.client.emitBackend({
      type: "passive_notice",
      text: "deferred progress",
      deferDuringTurn: true,
    });
    await h.settle();
    assert.deepEqual(h.controller.pendingPassiveNotices, ["deferred progress"]);
    await h.controller.endExternalWorking();

    await h.client.emitBackend({
      type: "passive_notice",
      text: "ordinary passive notice",
      deferDuringTurn: true,
    });
    await waitFor(
      () =>
        h.deliveries.some((item) =>
          deliveryText(item.content).includes("ordinary passive notice"),
        ),
      "idle passive notice reaches chat",
    );
    assert.equal(await h.controller.recoverIfNeeded(), undefined);
  } finally {
    await h.cleanup();
  }
});

test("controller covers default, malformed-adapter, and interrupted-command boundaries", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-controller-defaults-"),
  );
  const logger = { info() {}, warn() {}, error() {} };
  const hNode: any = (type: string, attrs: Record<string, unknown> = {}) => ({
    type,
    attrs,
  });
  hNode.text = (content: string) => ({ type: "text", attrs: { content } });
  hNode.quote = (id: string) => ({ type: "quote", attrs: { id } });
  try {
    const invalidClient = new ControllerClient();
    const invalid = new ChatController(
      {},
      path.join(root, "data"),
      "detached",
      {
        logger,
        h: hNode,
        frontendClientFactory: () => invalidClient as any,
        useChatFrontendIdentity: false,
      },
    );
    assert.match(
      invalid.statePath,
      /session-state\/detached\/[a-f0-9]{16}\/state\.json$/,
    );
    assert.equal(await invalid.pollTyping(), false);
    await invalid.beginExternalWorking();
    assert.equal(await invalid.clearWorkingReaction(), false);
    await invalid.endExternalWorking();
    invalid.client = invalidClient as any;
    assert.equal(invalid.client, invalidClient);
    invalid.client = null;
    invalid.dispose();

    const valid = new ChatController(
      {},
      path.join(root, "valid-data"),
      "telegram/owner-bot:default-room",
      {
        logger,
        h: hNode,
        frontendClientFactory: () => new ControllerClient() as any,
      },
    );
    assert.match(valid.statePath, /chat/);
    valid.dispose();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const adapterCalls: any[] = [];
  const adapter = await createHarness({
    indicators: [
      null as any,
      {} as any,
      { kind: "invalid" } as any,
      {
        kind: "polling",
        capability: "unknown",
        priority: "not-a-number",
        async onTick(context: any) {
          adapterCalls.push(["legacy-tick", context]);
          return true;
        },
        async onEnd(context: any) {
          adapterCalls.push(["legacy-end", context]);
          return true;
        },
      } as any,
    ],
  });
  try {
    await adapter.controller.connect({ restoreSession: false });
    await adapter.controller.beginExternalWorking();
    adapter.controller.lastWorkingIndicatorAt = 0;
    assert.equal(await adapter.controller.pollTyping(), true);
    await adapter.controller.endExternalWorking();
    assert.ok(adapterCalls.some(([name]) => name === "legacy-tick"));
    assert.ok(adapterCalls.some(([name]) => name.endsWith("end")));

    adapter.client.turnActive = true;
    adapter.client.isStreaming = true;
    await adapter.client.emitBackend({
      type: "status",
      phase: "working",
      turnActive: true,
      isStreaming: true,
    });
    const fresh = await adapter.controller.runCommand(
      "/new",
      "new-active-reply",
      "new-active-inbound",
    );
    assert.equal(fresh.handled, true);
    assert.ok(adapter.client.calls.some((call) => call.type === "abort"));

    adapter.controller.sleepAfterIdleMs = 0;
    assert.equal(await adapter.controller.sleepIfIdle(), false);
    adapter.controller.sleepAfterIdleMs = 10_000;
    adapter.controller.lastActivityAt = Date.now();
    assert.equal(await adapter.controller.sleepIfIdle(), false);

    adapter.client.promptPlans.push({ finalText: "generated tag final" });
    const generated = await adapter.controller.runTurn({
      text: "generated tag",
      attachments: [],
      deliverFinal: false,
    });
    assert.equal(generated.finalText, "generated tag final");
    assert.match(
      adapter.client.calls.filter((call) => call.type === "prompt").at(-1)
        .options.requestTag,
      /^frontend_turn_/,
    );
  } finally {
    await adapter.cleanup();
  }

  const ended: any[] = [];
  const failingClient = new ControllerClient();
  failingClient.connectError = new Error("frontend unavailable");
  const failedConnect = await createHarness({
    client: failingClient,
    indicators: [
      {
        type: "polling",
        presentation: "editable-message",
        async tick() {
          return true;
        },
        async end(context) {
          ended.push(context);
          return true;
        },
      },
    ],
  });
  try {
    await assert.rejects(
      failedConnect.controller.runTurn({
        text: "cannot connect",
        attachments: [],
        incomingMessageId: "connect-failure",
      }),
      /frontend unavailable/,
    );
    await failedConnect.settle();
    assert.equal(failedConnect.controller.currentTurn, null);
    assert.equal(failedConnect.controller.awaitingTurnSettle, false);
    assert.ok(failedConnect.controller.turnAbortGeneration > 0);
    assert.ok(ended.length <= 1);
  } finally {
    await failedConnect.cleanup();
  }
});

test("controller honors dynamic legacy indicators and polling cadence", async () => {
  const events: any[] = [];
  const h = await createHarness({ indicators: [] });
  const bot = h.controller.app.bots[0];
  let dynamicIndicators: any[] = [
    {
      kind: "marker",
      capability: "unknown",
      async onStart(context: any) {
        events.push(["legacy-start", context]);
        return true;
      },
      async onEnd(context: any) {
        events.push(["legacy-end", context]);
        return true;
      },
    },
  ];
  bot.getWorkingIndicators = (context: any) => {
    events.push(["get", context]);
    return dynamicIndicators;
  };
  try {
    await h.controller.beginExternalWorking();
    assert.ok(events.some(([name]) => name === "legacy-start"));
    await h.controller.endExternalWorking();
    assert.ok(events.some(([name]) => name === "legacy-end"));

    dynamicIndicators = [{ kind: "marker", capability: "message" }];
    await h.controller.beginExternalWorking();
    await h.controller.endExternalWorking();

    dynamicIndicators = [
      {
        kind: "polling",
        capability: "typing",
        async onTick(context: any) {
          events.push(["typing-fallback", context]);
          return true;
        },
      },
      {
        kind: "polling",
        capability: "reaction",
        priority: 500,
        async onTick(context: any) {
          events.push(["reaction-fallback", context]);
          return true;
        },
        async onEnd(context: any) {
          events.push(["reaction-end", context]);
          return true;
        },
      },
      {
        kind: "polling",
        capability: "message",
        priority: 1,
        async onTick() {
          events.push(["lower-priority"]);
          return true;
        },
      },
    ];
    await h.controller.beginExternalWorking();
    assert.ok(events.some(([name]) => name === "typing-fallback"));
    assert.ok(events.some(([name]) => name === "reaction-fallback"));
    assert.ok(!events.some(([name]) => name === "lower-priority"));
    assert.equal(await h.controller.pollTyping(), false);

    await h.client.emitBackend({ type: "assistant_summary", text: "  " });
    assert.equal(h.controller.latestAssistantSummaryText, "");
    await h.controller.endExternalWorking();
    assert.ok(events.some(([name]) => name === "reaction-end"));
  } finally {
    await h.cleanup();
  }
});

test("controller polls and settles reaction-only compaction progress", async () => {
  const contexts: any[] = [];
  const h = await createHarness({
    indicators: [
      {
        type: "polling",
        presentation: "reaction",
        async tick(context) {
          contexts.push(["tick", context]);
          return true;
        },
        async end(context) {
          contexts.push(["end", context]);
          return true;
        },
      },
    ],
  });
  try {
    await h.controller.connect({ restoreSession: false });
    await h.client.emitBackend({
      type: "compaction_start_notice",
      text: "Reaction-only compaction",
    });
    await waitFor(
      () => contexts.some(([name]) => name === "tick"),
      "reaction-only compaction starts polling",
    );
    const firstTick = contexts.find(([name]) => name === "tick")[1];
    assert.equal(firstTick.reactionDue, true);
    assert.ok(firstTick.messageId);

    const tickCount = contexts.filter(([name]) => name === "tick").length;
    await h.controller.housekeep();
    assert.equal(
      contexts.filter(([name]) => name === "tick").length,
      tickCount,
    );

    await h.client.emitBackend({
      type: "passive_notice",
      noticeKind: "compaction_end",
      text: "Reaction-only compacted",
      deferDuringTurn: false,
    });
    await waitFor(
      () => h.controller.compactionTurn === null,
      "reaction-only compaction settles",
    );
    assert.ok(contexts.some(([name]) => name === "end"));
  } finally {
    await h.cleanup();
  }
});

test("controller recovers malformed steer targets and superseded prompt outcomes", async () => {
  const h = await createHarness({
    state: {
      chatKey: "telegram/owner-bot:owner-room",
      pendingSteeredDeliveryTargets: [
        { replyToMessageId: "reply-only", text: " saved raw " },
        {
          incomingMessageId: "submitted-inbound",
          submittedText: "submitted body",
        },
      ],
    },
  });
  try {
    await h.controller.connect({ restoreSession: false });
    await h.client.emitBackend({
      type: "user_message_start",
      text: "not queued",
      userMessageId: "unmatched-user",
    });
    assert.equal(h.controller.pendingSteeredDeliveryTargets.length, 2);

    await h.client.emitBackend({
      type: "user_message_start",
      text: "submitted body",
      userMessageId: "submitted-user",
    });
    assert.equal(
      h.controller.currentTurn?.incomingMessageId,
      "submitted-inbound",
    );
    await h.controller.endExternalWorking();

    await h.client.emitBackend({
      type: "user_message_start",
      text: "saved raw",
      userMessageId: "raw-user",
    });
    assert.equal(h.controller.currentTurn?.incomingMessageId, undefined);
    assert.equal(h.controller.currentTurn?.replyToMessageId, "reply-only");
    await h.controller.clearProcessingState();

    h.client.requestResults.set("resolve_submitted_turn", {
      superseded: true,
      sessionId: "superseded-session",
    });
    const superseded = await h.controller.runTurn({
      text: "superseded prompt",
      attachments: [],
      incomingMessageId: "superseded-inbound",
      promptMeta: { sentAt: Date.now() },
    });
    assert.equal(superseded.superseded, true);
    assert.ok(
      !h.deliveries.some(
        (item) => deliveryText(item.content) === "superseded final",
      ),
    );

    h.client.turnActive = true;
    h.client.isStreaming = true;
    await h.client.emitBackend({
      type: "status",
      phase: "working",
      turnActive: true,
      isStreaming: true,
    });
    h.client.promptPlans.push({
      admission: { acceptedAs: "steer" },
      complete: false,
    });
    const anonymousSteer = await h.controller.runTurn({
      text: "anonymous steer",
      attachments: [],
    });
    assert.equal(anonymousSteer.steered, true);
    assert.deepEqual(h.controller.pendingSteeredDeliveryTargets, []);
  } finally {
    await h.cleanup();
  }
});

test("controller allows explicit session creation and preserves empty command failures", async () => {
  const h = await createHarness();
  try {
    const absentSession = path.join(h.root, "must-already-exist.jsonl");
    await assert.rejects(
      h.controller.runTurn({
        text: "reject an absent explicit session",
        attachments: [],
        sessionFile: absentSession,
        deliverFinal: false,
      }),
      /session/i,
    );

    const missingSession = path.join(h.root, "created-on-demand.jsonl");
    h.client.promptPlans.push({ finalText: "created session final" });
    const created = await h.controller.runTurn({
      text: "create the explicit session",
      attachments: [],
      sessionFile: missingSession,
      createSessionFileIfMissing: true,
      deliverFinal: false,
    });
    assert.equal(created.finalText, "created session final");
    assert.ok(
      h.client.calls.some(
        (call) =>
          call.type === "ensureSessionReady" &&
          call.restoreSessionFile === missingSession,
      ),
    );

    h.client.commandErrors.set("/usage", "");
    let rejected: unknown = Symbol("not rejected");
    try {
      await h.controller.runCommand("/usage");
    } catch (error) {
      rejected = error;
    }
    assert.equal(rejected, "");
    assert.ok(h.deliveries.some((item) => deliveryText(item.content)));
  } finally {
    await h.cleanup();
  }

  for (const operation of ["shutdown", "terminate"] as const) {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), `rin-controller-${operation}-`),
    );
    const sessionFile = await temporarySession(root, `${operation}.jsonl`);
    const lifecycle = await createHarness({
      state: {
        chatKey: "telegram/owner-bot:owner-room",
        sessionFile,
      },
    });
    try {
      if (operation === "shutdown") {
        await lifecycle.controller.shutdownSession();
      } else {
        await lifecycle.controller.terminateSession();
      }
      assert.ok(lifecycle.client.calls.some((call) => call.type === "connect"));
      assert.ok(
        lifecycle.client.calls.some(
          (call) => call.type === operation + "Session",
        ),
      );
    } finally {
      await lifecycle.cleanup();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("controller scopes frontend working and compaction acknowledgements to the active command", async () => {
  const indicatorContexts: any[] = [];
  const h = await createHarness({
    indicators: [
      {
        type: "polling",
        presentation: "reaction",
        async tick(context) {
          indicatorContexts.push(["tick", context]);
          return true;
        },
        async end(context) {
          indicatorContexts.push(["end", context]);
          return true;
        },
      },
    ],
  });
  const baseRunCommand = h.client.runCommand.bind(h.client);
  h.client.runCommand = async (commandLine: string) => {
    if (commandLine !== "/compact") return await baseRunCommand(commandLine);
    h.client.record("runCommand", { commandLine });
    h.client.turnActive = true;
    await h.client.emitBackend({
      type: "status",
      phase: "working",
      turnActive: true,
      isStreaming: false,
    });
    await waitFor(
      () => h.controller.currentTurn?.incomingMessageId === "compact-inbound",
      "frontend working status scopes the command turn",
    );

    await h.client.emitBackend({
      type: "compaction_start_notice",
      text: "Command compaction",
    });
    await waitFor(
      () =>
        h.controller.compactionTurn?.ackIncomingMessageId ===
          "compact-inbound" &&
        h.controller.compactionTurn?.ackReplyToMessageId === "compact-reply",
      "compaction notice retains the active command acknowledgement target",
    );
    await waitFor(
      () => indicatorContexts.some(([name]) => name === "tick"),
      "command compaction starts its reaction indicator",
    );

    await h.client.emitBackend({
      type: "passive_notice",
      noticeKind: "compaction_end",
      text: "Command compacted",
      deferDuringTurn: false,
    });
    h.client.turnActive = false;
    await h.client.emitBackend({
      type: "status",
      phase: "idle",
      turnActive: false,
      isStreaming: false,
    });
    await waitFor(
      () => h.controller.compactionTurn === null,
      "command compaction end settles its scoped progress",
    );
    return {
      handled: true,
      text: "backend compact text",
      sessionFile: h.client.sessionFile,
    };
  };
  try {
    const result = await h.controller.runCommand(
      "/compact",
      "compact-reply",
      "compact-inbound",
    );
    assert.equal(result.handled, true);
    assert.equal(h.controller.compactionTurn, null);
  } finally {
    await h.cleanup();
  }
});

test("controller safely settles empty and detached frontend notices", async () => {
  const h = await createHarness({ affectChatBinding: false });
  try {
    h.controller.app = { bots: [] };
    await h.controller.connect({ restoreSession: false });

    await h.client.emitBackend({ type: "assistant_interim", text: "" });
    await h.client.emitBackend({
      type: "assistant_interim",
      text: "detached interim",
    });
    await h.client.emitBackend({
      type: "passive_notice",
      text: "",
      deferDuringTurn: false,
    });
    await h.client.emitBackend({ type: "passive_notice", text: "" });
    await h.client.emitBackend({
      type: "passive_notice",
      noticeKind: "todo",
      text: "legacy empty todo",
      todoItems: [],
      deferDuringTurn: false,
    });
    await h.client.emitBackend({
      type: "passive_notice",
      text: "detached passive",
      deferDuringTurn: false,
    });
    await h.client.emitBackend({ type: "compaction_start_notice", text: "" });
    await h.client.emitBackend({
      type: "compaction_start_notice",
      text: "detached compaction",
    });

    assert.deepEqual(h.deliveries, []);
    assert.equal(h.controller.compactionTurn, null);
  } finally {
    await h.cleanup();
  }
});

test("controller preserves outbox and idle-state fallback permutations", async () => {
  const timeout = await createHarness({ state: {}, sleepAfterIdleMs: 10_000 });
  try {
    ownerFixture.drainChatOutbox = (
      _app: unknown,
      _agentDir: string,
      _h: unknown,
      _logger: unknown,
      options: { itemId: string },
    ) => [
      {
        id: options.itemId,
        status: "failed",
        error: "chat_outbox_delivery_timeout:owner",
        deliveryResult: ["timed-out-delivery"],
      },
    ];
    const command = await timeout.controller.runCommand("/usage");
    assert.equal(command.handled, true);
    assert.equal(timeout.controller.state.chatKey, timeout.controller.chatKey);

    timeout.controller.turnAbortRequested = true;
    assert.equal(timeout.controller.canSteerActiveTurn(), false);
    timeout.controller.turnAbortRequested = false;
    await timeout.controller.connect({ restoreSession: false });
    assert.equal(await timeout.controller.sleepIfIdle(), false);
    const live = timeout.controller.startLiveTurn();
    assert.equal(await timeout.controller.sleepIfIdle(), false);
    live.resolve({ settled: true });
    await live.promise;
  } finally {
    ownerFixture.drainChatOutbox = undefined;
    await timeout.cleanup();
  }

  const pending = await createHarness();
  try {
    ownerFixture.drainChatOutbox = () => [];
    pending.client.promptPlans.push({ finalText: "pending final" });
    const result = await pending.controller.runTurn({
      text: "keep queued delivery pending",
      attachments: [],
      incomingMessageId: "pending-inbound",
      deliveryIdempotencyKey: "pending-owner-delivery",
    });
    assert.equal(result.finalText, "pending final");
  } finally {
    ownerFixture.drainChatOutbox = undefined;
    await pending.cleanup();
  }

  const failed = await createHarness();
  let drainCall = 0;
  try {
    ownerFixture.drainChatOutbox = (
      _app: unknown,
      _agentDir: string,
      _h: unknown,
      _logger: unknown,
      options: { itemId: string },
    ) => {
      drainCall += 1;
      return [
        drainCall === 1
          ? { id: options.itemId, status: "failed", error: "" }
          : {
              id: options.itemId,
              status: "delivered",
              deliveryResult: ["error-delivery"],
            },
      ];
    };
    await assert.rejects(
      failed.controller.runCommand("/usage"),
      /chat_outbox_delivery_pending/,
    );
    assert.equal(drainCall, 2);
  } finally {
    ownerFixture.drainChatOutbox = undefined;
    await failed.cleanup();
  }
});

test("controller settings preserve defaults and explicit command configuration", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-controller-settings-"),
  );
  try {
    const absent = path.join(root, "absent.json");
    assert.deepEqual(loadChatSettings(absent), { enableSkillCommands: true });

    const explicit = path.join(root, "explicit.json");
    await fs.writeFile(
      explicit,
      `${JSON.stringify({ enableSkillCommands: false, custom: "kept" })}\n`,
    );
    assert.deepEqual(loadChatSettings(explicit), {
      enableSkillCommands: false,
      custom: "kept",
    });

    const implicit = path.join(root, "implicit.json");
    await fs.writeFile(implicit, `${JSON.stringify({ custom: 1 })}\n`);
    assert.deepEqual(loadChatSettings(implicit), {
      custom: 1,
      enableSkillCommands: true,
    });

    const nullable = path.join(root, "nullable.json");
    await fs.writeFile(nullable, "null\n");
    assert.deepEqual(loadChatSettings(nullable), { enableSkillCommands: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
