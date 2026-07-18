import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const frontend = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/turn-driver.js")
>("dist/core/rin-frontend-sdk/turn-driver.js");

type Call = { type: string; [key: string]: any };

class IntegratedFrontendClient {
  calls: Call[] = [];
  connected = false;
  listener: ((event: any) => void) | undefined;
  sessionFile = "";
  sessionId = "owner-session";
  sessionName = "";
  turnActive = false;
  isStreaming = false;
  isCompacting = false;
  sessionRecovering = false;
  activeTools = ["read", "bash", "edit"];
  messages: any[] = [];
  sessions: any[] = [];
  models = [
    { provider: "owner", id: "small" },
    { provider: "owner", id: "large/model" },
  ];
  promptAdmission: any = { acceptedAs: "prompt" };
  promptError: unknown;
  promptFinal = "owner final";
  promptCompletes = true;
  queuedOfflineTag = "";
  replayEvent: any;
  ensureReady = true;

  record(type: string, values: Record<string, unknown> = {}) {
    this.calls.push({ type, ...values });
  }

  async connect() {
    this.record("connect");
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

  state() {
    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      turnActive: this.turnActive,
      isStreaming: this.isStreaming,
      isCompacting: this.isCompacting,
      sessionRecovering: this.sessionRecovering,
      thinkingLevel: "medium",
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
    if (managedSessionLeaf && !restoreSessionFile) {
      this.sessionFile = path.join(
        os.tmpdir(),
        "managed",
        `${managedSessionLeaf.replaceAll("/", "-")}.jsonl`,
      );
    }
    return this.state();
  }

  async prompt(text: string, options: any = {}) {
    this.record("prompt", { text, options });
    if (this.promptError) throw this.promptError;
    this.turnActive = true;
    this.isStreaming = true;
    await this.emitUi({
      type: "rpc_turn_event",
      event: "start",
      requestTag: options.requestTag,
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
    });
    if (this.promptCompletes) {
      queueMicrotask(() => {
        this.turnActive = false;
        this.isStreaming = false;
        void this.emitUi({
          type: "rpc_turn_event",
          event: "complete",
          requestTag: options.requestTag,
          finalText: this.promptFinal,
          result: {
            messages: [{ role: "assistant", content: this.promptFinal }],
          },
          sessionFile: this.sessionFile,
          sessionId: this.sessionId,
        });
      });
    }
    return this.promptAdmission;
  }

  async submit(text: string) {
    return await this.prompt(text);
  }

  async runCommand(commandLine: string) {
    this.record("runCommand", { commandLine });
    return {
      handled: true,
      text: `ran:${commandLine}`,
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
    };
  }

  async compact(customInstructions?: string, options?: any) {
    this.record("compact", { customInstructions, options });
    return {
      handled: true,
      text: `compacted:${customInstructions || "default"}`,
      sessionFile: this.sessionFile,
    };
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
  }

  async newSession(options: any = {}) {
    this.record("newSession", { options });
    this.sessionId = `owner-session-${this.calls.length}`;
    this.sessionFile = path.join(
      os.tmpdir(),
      `${String(options.managedSessionLeaf || "new").replaceAll("/", "-")}.jsonl`,
    );
    return {
      cancelled: Boolean(options.cancelled),
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
    };
  }

  async listSessions() {
    this.record("listSessions");
    return this.sessions;
  }

  async listModels() {
    this.record("listModels");
    return this.models;
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
    this.record("getMessages");
    return this.messages;
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
    switch (command.type) {
      case "get_state":
        return this.state();
      case "get_messages":
        return { messages: this.messages };
      case "get_active_tools":
        return { tools: [...this.activeTools] };
      case "set_active_tools":
        this.activeTools = [...command.toolNames];
        return { tools: this.activeTools };
      case "run_command":
        return await this.runCommand(command.commandLine);
      case "reset_model_options_from_settings":
        return { reset: true };
      case "set_model":
      case "set_thinking_level":
      case "set_session_name":
        if (command.type === "set_session_name")
          this.sessionName = command.name;
        return { updated: true };
      case "resolve_submitted_turn":
        return this.resolveSubmittedTurn(command);
      case "replay_pending_terminal_turn_event":
        if (this.replayEvent) {
          const payload = this.replayEvent;
          this.replayEvent = undefined;
          queueMicrotask(() => void this.emitUi(payload));
          return { replayed: true };
        }
        return { replayed: false };
      default:
        return {};
    }
  }

  resolveSubmittedTurn(_command: any): any {
    return null;
  }

  async send(command: any) {
    return { type: "response", command: command.type, success: true, data: {} };
  }

  consumeQueuedOfflineOperation(requestTag?: string) {
    if (!requestTag || requestTag !== this.queuedOfflineTag) return false;
    this.queuedOfflineTag = "";
    return true;
  }

  async emitUi(payload: any) {
    await this.listener?.({ type: "ui", payload });
  }

  async emitBackend(payload: any) {
    await this.listener?.({ type: "backend_event", payload });
  }
}

function createDriver(client = new IntegratedFrontendClient()) {
  const driver = new frontend.RinFrontendTurnDriver({
    clientFactory: () => client as any,
    promptSource: "owner-integration",
    frontendIdentity: { kind: "chat", key: "discord/owner:room" },
    commandResponses: {
      abort: "Owner abort",
      new: "Owner new",
      newCancelled: "Owner cancelled",
    },
  });
  return { driver, client };
}

async function temporarySession() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-owner-"));
  const sessionFile = path.join(directory, "session.jsonl");
  await fs.writeFile(sessionFile, "");
  return {
    directory,
    sessionFile,
    async cleanup() {
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(label);
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}`)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("frontend turn owner integrates connection, session, command, and lifecycle boundaries", async () => {
  const session = await temporarySession();
  try {
    const first = createDriver();
    const events: any[] = [];
    const unsubscribe = first.driver.subscribe((event) => events.push(event));
    assert.equal(first.driver.hasClient(), false);
    assert.equal(await first.driver.connect(), true);
    assert.equal(await first.driver.connect(), true);
    assert.equal(first.driver.hasClient(), true);
    assert.equal(first.driver.currentSessionId(), "owner-session");
    assert.equal(first.driver.hasActiveTurn(), false);
    assert.equal(first.driver.hasVisibleChatWorkingTurn(), false);
    assert.equal(first.driver.hasWorkerActiveTurn(), false);
    assert.equal(first.driver.hasExplicitWorkingVisible(), false);
    assert.equal(first.driver.canSteerActiveTurn(), false);

    const resumed = await first.driver.resumeSessionFile(session.sessionFile);
    assert.equal(resumed.sessionFile, session.sessionFile);
    assert.equal(first.driver.currentSessionFile(), session.sessionFile);
    assert.equal(
      first.client.calls.filter((call) => call.type === "resumeSession").length,
      1,
    );
    await assert.rejects(
      first.driver.resumeSessionFile(path.join(session.directory, "missing")),
      /session.*not found|missing/i,
    );

    first.client.sessions = [
      { id: "known", path: session.sessionFile },
      { id: "id-only", path: "" },
    ];
    const resumedById = await first.driver.runCommand("/resume known");
    assert.equal(resumedById.handled, true);
    assert.equal(resumedById.sessionFile, session.sessionFile);
    await first.driver.runCommand("/resume id-only");
    await assert.rejects(
      first.driver.runCommand("/resume absent"),
      /session not found/,
    );

    const created = await first.driver.runCommand("/new", {
      managedSessionLeaf: "discord/owner:room",
    });
    assert.equal(created.text, "Owner new");
    assert.match(created.sessionFile || "", /discord-owner:room/);
    await assert.rejects(
      first.driver.runCommand("/new", { sessionFile: session.sessionFile }),
      /new_session_session_file_unsupported/,
    );

    const compact = await first.driver.runCommand("/compact keep facts", {
      sessionFile: session.sessionFile,
      skipSessionRecovery: true,
    });
    assert.equal(compact.text, "Compacted session.");
    assert.ok(
      first.client.calls.some(
        (call) =>
          call.type === "compact" && call.customInstructions === "keep facts",
      ),
    );
    const command = await first.driver.runCommand("/usage", {
      sessionFile: session.sessionFile,
      assumeConnected: true,
      assumeSessionReady: true,
    });
    assert.equal(command.text, "ran:/usage");
    await assert.rejects(
      first.driver.runCommand("/usage", {
        assumeConnected: true,
        sessionFile: path.join(session.directory, "absent.jsonl"),
      }),
      /session.*not found|missing/i,
    );

    await first.client.emitBackend({ type: "working_visible", visible: true });
    assert.equal(first.driver.hasExplicitWorkingVisible(), true);
    assert.equal(first.driver.frontendPhase, "working");
    await first.client.emitBackend({ type: "working_visible", visible: false });
    assert.equal(first.driver.frontendPhase, "idle");

    await first.driver.shutdownSession();
    assert.equal(first.driver.hasClient(), false);
    assert.equal(first.driver.frontendPhase, "idle");
    assert.ok(
      first.client.calls.some((call) => call.type === "shutdownSession"),
    );

    const fallback = createDriver();
    await fallback.driver.connect();
    (fallback.client as any).shutdownSession = undefined;
    await fallback.driver.shutdownSession();
    assert.ok(
      fallback.client.calls.some(
        (call) =>
          call.type === "request" && call.command.type === "shutdown_session",
      ),
    );

    const terminated = createDriver();
    await terminated.driver.connect();
    await terminated.driver.terminateSession();
    assert.equal(terminated.driver.frontendPhase, "idle");
    assert.ok(
      terminated.client.calls.some((call) => call.type === "terminateSession"),
    );

    const terminationFallback = createDriver();
    await terminationFallback.driver.connect();
    (terminationFallback.client as any).terminateSession = undefined;
    await terminationFallback.driver.terminateSession();
    assert.ok(
      terminationFallback.client.calls.some(
        (call) =>
          call.type === "request" && call.command.type === "terminate_session",
      ),
    );

    unsubscribe();
    first.driver.dispose();
    first.driver.dispose();
    assert.ok(events.some((event) => event.type === "frontend_status"));

    const detached = createDriver();
    await detached.driver.connect();
    await detached.driver.detachForDaemonShutdown();
    assert.equal(detached.driver.hasClient(), false);
    assert.equal(await detached.driver.connect(), false);
  } finally {
    await session.cleanup();
  }
});

test("frontend turn owner integrates managed prompts, scoped options, admission, and terminal results", async () => {
  const { driver, client } = createDriver();
  const events: any[] = [];
  driver.subscribe((event) => events.push(event));

  const result = await driver.runTurn({
    text: "  owner prompt  ",
    images: [{ type: "image", data: "a" }],
    managedSessionLeaf: "discord/owner:room",
    sessionName: "Owner Session",
    model: "owner/large/model",
    thinkingLevel: "high",
    resetModelOptionsFromSettings: true,
    tools: ["read", "write"],
    excludeTools: ["write"],
    piStartupOptions: { noBuiltinTools: true } as any,
    disabledRinCapabilities: ["browse"],
    promptContext: {
      source: "chat-bridge",
      chatKey: "discord/owner:room",
      senderId: "owner",
      sentAt: Date.now(),
    },
    requestTag: "owner-turn-1",
  });
  assert.equal(result.finalText, "owner final");
  assert.match(result.sessionFile || "", /discord-owner:room/);
  assert.equal(driver.latestAssistantText, "owner final");
  assert.equal(driver.frontendPhase, "idle");
  assert.equal(driver.hasActiveTurn(), false);
  assert.ok(
    client.calls.some(
      (call) =>
        call.type === "ensureSessionReady" &&
        call.managedSessionLeaf === "discord/owner:room" &&
        call.resourceOptions.disabledRinCapabilities[0] === "browse",
    ),
  );
  assert.ok(
    client.calls.some(
      (call) =>
        call.type === "request" &&
        call.command.type === "set_active_tools" &&
        call.command.toolNames.join(",") === "read",
    ),
  );
  assert.ok(
    client.calls.some(
      (call) => call.type === "request" && call.command.type === "set_model",
    ),
  );
  assert.ok(
    client.calls.some(
      (call) =>
        call.type === "request" && call.command.type === "set_thinking_level",
    ),
  );
  const prompt = client.calls.find((call) => call.type === "prompt");
  assert.equal(prompt.text, "owner prompt");
  assert.equal(prompt.options.requestTag, "owner-turn-1");
  assert.equal(prompt.options.promptContext.chatKey, "discord/owner:room");

  client.promptAdmission = { acceptedAs: "steer" };
  client.promptCompletes = false;
  client.turnActive = true;
  client.isStreaming = true;
  await client.emitUi({ type: "agent_start" });
  const steered = await driver.runTurn({
    text: "correction",
    assumeConnected: true,
    assumeSessionReady: true,
    requestTag: "owner-steer",
  });
  assert.equal(steered.steered, true);

  client.promptAdmission = { acceptedAs: "followUp" };
  const followed = await driver.runTurn({
    text: "next",
    assumeConnected: true,
    assumeSessionReady: true,
  });
  assert.equal(followed.steered, true);

  client.turnActive = false;
  client.isStreaming = false;
  await client.emitUi({ type: "agent_end" });
  client.promptAdmission = { acceptedAs: "prompt" };
  client.promptCompletes = true;
  const submitted = await driver.submitTurn({
    text: "fire and continue",
    assumeSessionReady: true,
    model: "owner/small",
    thinkingLevel: "low",
    tools: [],
    source: "owner-source",
    requestTag: "owner-submit",
  });
  assert.equal(submitted.sessionId, client.sessionId);

  client.queuedOfflineTag = "queued-owner";
  await assert.rejects(
    driver.submitTurn({
      text: "queued",
      assumeSessionReady: true,
      requestTag: "queued-owner",
    }),
    /rpc_turn_queued_offline/,
  );

  driver.dispose();
  assert.ok(events.some((event) => event.type === "turn_accepted"));
});

test("frontend turn owner translates backend events and preserves terminal ownership", async () => {
  const { driver, client } = createDriver();
  const seen: any[] = [];
  const badListener = () => {
    throw new Error("listener failure is isolated");
  };
  driver.subscribe(badListener);
  driver.subscribe((event) => seen.push(event));
  await driver.connect();

  const backendEvents = [
    { type: "status", phase: "retrying", turnActive: true, isStreaming: true },
    { type: "turn_accepted" },
    { type: "user_message_start", text: "owner", userMessageId: "u1" },
    {
      type: "user_message_persisted",
      sessionLeafId: "leaf-1",
      userMessageId: "u1",
    },
    { type: "passive_notice", text: "deferred", deferDuringTurn: true },
    { type: "passive_notice", text: "forced", deferDuringTurn: false },
    { type: "compaction_start_notice", text: "Compacting" },
    { type: "external_working_start" },
    { type: "external_working_start" },
    { type: "assistant_stream", text: "stream" },
    { type: "assistant_summary", text: "summary" },
    { type: "assistant_interim", text: "interim" },
    { type: "assistant_final", text: "final segment" },
    { type: "external_working_end" },
    { type: "external_working_end" },
  ];
  for (const event of backendEvents) await client.emitBackend(event);
  assert.equal(driver.latestAssistantText, "final segment");
  assert.equal(driver.canSteerActiveTurn(), false);
  assert.ok(seen.some((event) => event.type === "user_message_start"));
  assert.ok(seen.some((event) => event.type === "user_message_persisted"));
  assert.ok(
    seen.some(
      (event) => event.type === "passive_notice" && event.text === "forced",
    ),
  );
  assert.ok(
    !seen.some(
      (event) => event.type === "passive_notice" && event.text === "deferred",
    ),
  );
  assert.ok(seen.some((event) => event.type === "assistant_summary"));
  assert.ok(seen.some((event) => event.type === "assistant_interim"));

  await client.emitUi({ type: "compaction_start" });
  assert.equal(driver.frontendPhase, "working");
  await client.emitUi({ type: "compaction_end" });
  await client.emitUi({ type: "queue_update" });
  await client.emitUi({ type: "session_recovering" });
  await client.emitUi({ type: "session_recovered" });
  client.turnActive = false;
  client.isStreaming = false;
  await client.emitUi({ type: "agent_end" });
  await client.emitBackend({
    type: "status",
    phase: "idle",
    turnActive: false,
    isStreaming: false,
  });
  assert.equal(driver.hasActiveTurn(), false);
  await driver.handleClientEvent(null);
  await driver.handleClientEvent({ type: "unknown" });

  client.promptCompletes = false;
  const emptyFinal = driver.runTurn({
    text: "empty final",
    assumeConnected: true,
    assumeSessionReady: true,
    requestTag: "empty-final",
  });
  await waitFor(
    () =>
      client.calls.some(
        (call) =>
          call.type === "prompt" && call.options.requestTag === "empty-final",
      ),
    "empty-final prompt was not submitted",
  );
  await client.emitUi({
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "empty-final",
    finalText: "",
    sessionId: client.sessionId,
    sessionFile: client.sessionFile,
  });
  await assert.rejects(
    within(emptyFinal, "empty-final"),
    /rin_turn_result_invariant_failed/,
  );

  client.promptFinal = "unused";
  const failed = driver.runTurn({
    text: "provider failure",
    assumeConnected: true,
    assumeSessionReady: true,
    requestTag: "failed-turn",
  });
  await waitFor(
    () =>
      client.calls.some(
        (call) =>
          call.type === "prompt" && call.options.requestTag === "failed-turn",
      ),
    "failed turn prompt was not submitted",
  );
  await client.emitUi({
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "stale-turn",
    finalText: "stale",
  });
  assert.equal(driver.hasActiveTurn(), true);
  await client.emitUi({
    type: "rpc_turn_event",
    event: "error",
    requestTag: "failed-turn",
    error: "provider exploded",
    sessionId: client.sessionId,
    sessionFile: client.sessionFile,
  });
  await assert.rejects(within(failed, "provider-failure"), /provider exploded/);

  client.turnActive = true;
  client.isStreaming = true;
  await client.emitUi({ type: "agent_start" });
  const aborted = driver.runCommand("/abort", {
    assumeConnected: true,
    assumeSessionReady: true,
  });
  const abortResult = await aborted;
  assert.equal(abortResult.text, "Owner abort");
  assert.equal(driver.frontendPhase, "idle");

  driver.dispose();
});

test("frontend turn owner resolves restored submissions and reports caller errors", async () => {
  const session = await temporarySession();
  try {
    const { driver, client } = createDriver();
    client.sessionFile = session.sessionFile;
    await driver.connect({ restoreSessionFile: session.sessionFile });

    client.resolveSubmittedTurn = () => ({
      finalText: "restored final",
      result: { restored: true },
      sessionFile: session.sessionFile,
      sessionId: "restored-id",
    });
    const restored = await driver.runTurn({
      text: "restored prompt",
      sessionFile: session.sessionFile,
      promptContext: { sentAt: Date.now() },
      assumeConnected: true,
    });
    assert.equal(restored.finalText, "restored final");
    assert.equal(restored.sessionId, "restored-id");
    assert.equal(
      client.calls.filter((call) => call.type === "prompt").length,
      0,
    );

    client.resolveSubmittedTurn = () => ({
      superseded: true,
      sessionFile: session.sessionFile,
    });
    const superseded = await driver.runTurn({
      text: "older prompt",
      sessionFile: session.sessionFile,
      promptContext: { sentAt: Date.now() },
      assumeConnected: true,
    });
    assert.equal(superseded.superseded, true);

    client.resolveSubmittedTurn = () => ({
      error: "persisted provider error",
      sessionFile: session.sessionFile,
      sessionId: "failed-id",
    });
    await assert.rejects(
      driver.runTurn({
        text: "failed prompt",
        sessionFile: session.sessionFile,
        promptContext: { sentAt: Date.now() },
        assumeConnected: true,
      }),
      (error: any) =>
        error.message === "persisted provider error" &&
        error.sessionId === "failed-id" &&
        error.rinTurnTerminal === true,
    );

    client.resolveSubmittedTurn = () => null;
    await assert.rejects(
      driver.runTurn({
        text: "missing target",
        sessionFile: path.join(session.directory, "missing.jsonl"),
        assumeConnected: true,
      }),
      /session.*not found|missing/i,
    );
    await assert.rejects(
      driver.runTurn({
        text: "bad model",
        sessionFile: session.sessionFile,
        model: "owner/absent",
        assumeConnected: true,
      }),
      /frontend_model_not_found/,
    );
    driver.dispose();

    const disconnected = createDriver();
    await assert.rejects(
      disconnected.driver.runTurn({ text: "no client", assumeConnected: true }),
      /frontend_session_not_connected/,
    );
    await assert.rejects(
      disconnected.driver.runCommand("/usage", { assumeConnected: true }),
      /frontend_session_not_connected/,
    );
    disconnected.driver.interruptActiveTurnLikeTui();
  } finally {
    await session.cleanup();
  }
});

test("frontend turn owner integrates fallback session creation and unscoped model options", async () => {
  const fallback = createDriver();
  (fallback.client as any).ensureSessionReady = undefined;
  const managed = await fallback.driver.runTurn({
    text: "fallback managed",
    managedSessionLeaf: "owner/fallback",
    tools: undefined,
    excludeTools: ["edit"],
    piStartupOptions: { noBuiltinTools: false } as any,
    disabledRinCapabilities: [],
  });
  assert.equal(managed.finalText, "owner final");
  assert.ok(fallback.client.calls.some((call) => call.type === "newSession"));
  assert.ok(
    fallback.client.calls.some(
      (call) =>
        call.type === "request" && call.command.type === "get_active_tools",
    ),
  );

  const unscoped = createDriver();
  await unscoped.driver.connect();
  const result = await unscoped.driver.runTurn({
    text: "unscoped options",
    assumeConnected: true,
    assumeSessionReady: true,
    model: "owner/small",
    thinkingLevel: "minimal",
    resetModelOptionsFromSettings: true,
  });
  assert.equal(result.finalText, "owner final");
  assert.ok(unscoped.client.calls.some((call) => call.type === "setModel"));
  assert.ok(
    unscoped.client.calls.some((call) => call.type === "setThinkingLevel"),
  );
  assert.ok(
    unscoped.client.calls.some(
      (call) => call.type === "resetModelOptionsFromSettings",
    ),
  );

  const cancelled = createDriver();
  (cancelled.client as any).ensureSessionReady = undefined;
  cancelled.client.newSession = async (options: any) => {
    cancelled.client.record("newSession", { options });
    return { cancelled: true };
  };
  await assert.rejects(
    cancelled.driver.runTurn({
      text: "cancel",
      managedSessionLeaf: "owner/cancel",
    }),
    /rin_new_session_cancelled/,
  );
});

test("frontend turn owner rejoins, recovers, and resolves an accepted restored submission", async () => {
  const rejoin = createDriver();
  await rejoin.driver.connect();
  rejoin.client.turnActive = true;
  rejoin.client.isStreaming = true;
  await rejoin.client.emitUi({ type: "agent_start" });
  rejoin.client.promptAdmission = { acceptedAs: "rejoin" };
  rejoin.client.promptCompletes = false;
  const followed = rejoin.driver.runTurn({
    text: "join active",
    assumeConnected: true,
    assumeSessionReady: true,
    requestTag: "owner-rejoin",
  });
  await waitFor(
    () =>
      rejoin.client.calls.some(
        (call) =>
          call.type === "prompt" && call.options.requestTag === "owner-rejoin",
      ),
    "rejoin prompt was not admitted",
  );
  rejoin.client.turnActive = false;
  rejoin.client.isStreaming = false;
  await rejoin.client.emitUi({
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "owner-rejoin",
    finalText: "rejoined final",
    sessionId: rejoin.client.sessionId,
  });
  assert.equal((await within(followed, "rejoin")).finalText, "rejoined final");

  const recovered = createDriver();
  recovered.client.sessionFile = "/tmp/owner-recovery.jsonl";
  await recovered.driver.connect();
  recovered.client.promptError = new Error("rin_disconnected");
  recovered.client.replayEvent = {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "owner-recovery",
    finalText: "replayed final",
    sessionId: recovered.client.sessionId,
  };
  const replayed = await within(
    recovered.driver.runTurn({
      text: "recover me",
      assumeConnected: true,
      assumeSessionReady: true,
      requestTag: "owner-recovery",
    }),
    "recover-live-turn",
  );
  assert.equal(replayed.finalText, "replayed final");
  assert.ok(
    recovered.client.calls.some(
      (call) =>
        call.type === "request" &&
        call.command.type === "replay_pending_terminal_turn_event",
    ),
  );

  const existing = createDriver();
  let resolutions = 0;
  existing.client.resolveSubmittedTurn = () => {
    resolutions += 1;
    return resolutions === 1
      ? { submitted: true }
      : {
          finalText: "accepted restored final",
          sessionId: "accepted-restored",
        };
  };
  const restored = await existing.driver.runTurn({
    text: "accepted before restart",
    promptContext: { sentAt: Date.now() },
  });
  assert.equal(restored.finalText, "accepted restored final");
  assert.equal(restored.sessionId, "accepted-restored");
  assert.equal(resolutions, 2);
  assert.equal(
    existing.client.calls.filter((call) => call.type === "prompt").length,
    0,
  );
});

test("frontend turn owner covers command and prompt boundary alternatives without changing defaults", async () => {
  const session = await temporarySession();
  try {
    const directClient = new IntegratedFrontendClient();
    const direct = new frontend.RinFrontendTurnDriver({
      clientFactory: () => directClient as any,
      promptSource: " ",
    });
    await direct.connect();
    const directCommand = await direct.runCommand("/usage", {
      assumeConnected: true,
      assumeSessionReady: true,
    });
    assert.equal(directCommand.text, "ran:/usage");

    (directClient as any).ensureSessionReady = undefined;
    const restoredCommand = await direct.runCommand("/usage", {
      restoreSessionFile: session.sessionFile,
      assumeConnected: true,
    });
    assert.equal(restoredCommand.sessionFile, session.sessionFile);

    directClient.newSession = async (options: any) => {
      directClient.record("newSession", { options });
      return { cancelled: true };
    };
    const cancelledNew = await direct.runCommand("/new", {
      managedSessionLeaf: "owner/cancelled-new",
      assumeConnected: true,
    });
    assert.equal(cancelledNew.cancelled, true);
    assert.equal(cancelledNew.text, "Session switch cancelled.");

    const named = createDriver();
    const firstNamed = await named.driver.runTurn({
      text: "first named",
      sessionName: "Stable Name",
    });
    assert.equal(firstNamed.finalText, "owner final");
    const setNameCount = named.client.calls.filter(
      (call) =>
        call.type === "request" && call.command.type === "set_session_name",
    ).length;
    const secondNamed = await named.driver.runTurn({
      text: "second named",
      sessionName: "Stable Name",
      assumeConnected: true,
    });
    assert.equal(secondNamed.finalText, "owner final");
    assert.equal(
      named.client.calls.filter(
        (call) =>
          call.type === "request" && call.command.type === "set_session_name",
      ).length,
      setNameCount,
    );

    const active = createDriver();
    await active.driver.connect();
    active.client.promptCompletes = false;
    const interrupted = active.driver.runTurn({
      text: "long turn",
      assumeConnected: true,
      assumeSessionReady: true,
      requestTag: "long-owner-turn",
    });
    await waitFor(
      () =>
        active.client.calls.some(
          (call) =>
            call.type === "prompt" &&
            call.options.requestTag === "long-owner-turn",
        ),
      "long turn was not submitted",
    );
    const replacement = await active.driver.runCommand("/new", {
      assumeConnected: true,
      managedSessionLeaf: "owner/replacement",
    });
    assert.equal(replacement.handled, true);
    await assert.rejects(interrupted, /chat_turn_aborted/);
    assert.ok(active.client.calls.some((call) => call.type === "abort"));

    const createdMissing = createDriver();
    const missingPath = path.join(session.directory, "created-later.jsonl");
    const createdResult = await createdMissing.driver.runTurn({
      text: "allow missing",
      sessionFile: missingPath,
      createSessionFileIfMissing: true,
    });
    assert.equal(createdResult.finalText, "owner final");

    const submitted = createDriver();
    const submittedResult = await submitted.driver.submitTurn({
      text: "native submission",
      managedSessionLeaf: "owner/submitted",
      resetModelOptionsFromSettings: true,
      excludeTools: ["edit"],
      model: "owner/small",
      thinkingLevel: "high",
    });
    assert.equal(submittedResult.sessionId, submitted.client.sessionId);
    assert.ok(
      submitted.client.calls.some(
        (call) =>
          call.type === "prompt" &&
          /^frontend_turn_/.test(call.options.requestTag),
      ),
    );

    const disconnectedSubmit = createDriver();
    await assert.rejects(
      disconnectedSubmit.driver.submitTurn({
        text: "not connected",
        assumeSessionReady: true,
      }),
      /frontend_session_not_connected/,
    );
  } finally {
    await session.cleanup();
  }
});

test("frontend turn owner covers terminal and event alternatives with observable outcomes", async () => {
  const nonError = createDriver();
  await nonError.driver.connect();
  nonError.client.promptError = "plain prompt failure";
  let nonErrorReason: unknown;
  try {
    await nonError.driver.runTurn({
      text: "plain failure",
      assumeConnected: true,
      assumeSessionReady: true,
    });
  } catch (error) {
    nonErrorReason = error;
  }
  assert.equal(nonErrorReason, "plain prompt failure");

  const ordinaryError = createDriver();
  await ordinaryError.driver.connect();
  ordinaryError.client.promptError = new Error("ordinary prompt failure");
  await assert.rejects(
    ordinaryError.driver.runTurn({
      text: "ordinary failure",
      assumeConnected: true,
      assumeSessionReady: true,
    }),
    /ordinary prompt failure/,
  );

  const terminalFirst = createDriver();
  await terminalFirst.driver.connect();
  terminalFirst.client.prompt = async function prompt(
    text: string,
    options: any,
  ) {
    this.record("prompt", { text, options });
    await new Promise(() => undefined);
    return { acceptedAs: "prompt" };
  };
  const terminalFailure = terminalFirst.driver.runTurn({
    text: "terminal first",
    assumeConnected: true,
    assumeSessionReady: true,
    requestTag: "terminal-first",
  });
  await waitFor(
    () => terminalFirst.client.calls.some((call) => call.type === "prompt"),
    "terminal-first prompt was not submitted",
  );
  await terminalFirst.client.emitBackend({
    type: "turn_error",
    requestTag: "terminal-first",
    error: "terminal first failure",
  });
  await assert.rejects(
    within(terminalFailure, "terminal-first"),
    /terminal first failure/,
  );

  const freshSteer = createDriver();
  await freshSteer.driver.connect();
  freshSteer.client.promptAdmission = { acceptedAs: "steer" };
  freshSteer.client.promptCompletes = false;
  const steered = await freshSteer.driver.runTurn({
    text: "fresh steer admission",
    assumeConnected: true,
    assumeSessionReady: true,
  });
  assert.equal(steered.steered, true);

  const events = createDriver();
  const seen: any[] = [];
  events.driver.subscribe((event) => seen.push(event));
  await events.driver.connect();
  await events.client.emitBackend({ type: "status", phase: "idle" });
  await events.client.emitBackend({
    type: "user_message_start",
    text: "no id",
  });
  await events.client.emitBackend({
    type: "user_message_persisted",
    sessionLeafId: "leaf-no-id",
  });
  await events.client.emitBackend({
    type: "passive_notice",
    text: "rich notice",
    level: "warning",
    noticeKind: "todo",
    todoItems: [{ text: "owner task", done: false }],
    todoError: "snapshot stale",
  });
  await events.client.emitBackend({ type: "external_working_start" });
  await events.client.emitBackend({
    type: "status",
    phase: "working",
    turnActive: false,
    isStreaming: true,
  });
  await events.client.emitBackend({ type: "external_working_end" });
  assert.equal(events.driver.frontendPhase, "working");
  await events.client.emitBackend({
    type: "status",
    phase: "idle",
    turnActive: false,
    isStreaming: false,
  });
  await events.client.emitBackend({
    type: "turn_complete",
    requestTag: "nobody",
    finalText: "ignored",
  });
  await events.client.emitBackend({
    type: "turn_error",
    requestTag: "nobody",
    error: "ignored",
  });
  await events.driver.handleClientEvent({
    type: "ui",
    name: "connection_lost",
  });
  assert.ok(
    seen.some(
      (event) =>
        event.type === "passive_notice" &&
        event.noticeKind === "todo" &&
        event.todoItems[0].text === "owner task" &&
        event.todoError === "snapshot stale",
    ),
  );
  assert.deepEqual(
    seen.find((event) => event.type === "user_message_start"),
    { type: "user_message_start", text: "no id" },
  );
});

test("frontend turn owner handles connection races, mismatches, and empty lifecycle calls", async () => {
  const idle = createDriver();
  await idle.driver.shutdownSession();
  await idle.driver.terminateSession();
  await idle.driver.detachForDaemonShutdown();
  idle.driver.dispose();

  const failed = createDriver();
  failed.client.connect = async () => {
    failed.client.record("connect");
    throw new Error("connect failed");
  };
  await assert.rejects(failed.driver.connect(), /connect failed/);

  let releaseConnect!: () => void;
  const late = createDriver();
  late.client.connect = async () => {
    late.client.record("connect");
    await new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    late.client.connected = true;
  };
  const connecting = late.driver.connect();
  await waitFor(() => Boolean(releaseConnect), "late connect did not start");
  const detached = late.driver.detachForDaemonShutdown();
  releaseConnect();
  await detached;
  assert.equal(await connecting, false);
  assert.ok(late.client.calls.some((call) => call.type === "disconnect"));

  let rejectConnect!: (error: Error) => void;
  const lateFailure = createDriver();
  lateFailure.client.connect = async () =>
    await new Promise<void>((_, reject) => {
      rejectConnect = reject;
    });
  const failingConnect = lateFailure.driver.connect();
  await waitFor(
    () => Boolean(rejectConnect),
    "late failed connect did not start",
  );
  const detachFailure = lateFailure.driver.detachForDaemonShutdown();
  rejectConnect(new Error("late connect failure"));
  await detachFailure;
  assert.equal(await failingConnect, false);

  const session = await temporarySession();
  try {
    const mismatch = createDriver();
    mismatch.client.ensureSessionReady = async () => ({
      sessionFile: path.join(session.directory, "wrong.jsonl"),
      sessionId: "wrong",
    });
    await assert.rejects(
      mismatch.driver.runTurn({
        text: "mismatch",
        sessionFile: session.sessionFile,
      }),
      /frontend_session_restore_mismatch/,
    );

    const emptyReady = createDriver();
    emptyReady.client.ensureSessionReady = async () => null as any;
    const emptyReadyResult = await emptyReady.driver.runTurn({
      text: "empty ready",
    });
    assert.equal(emptyReadyResult.finalText, "owner final");
  } finally {
    await session.cleanup();
  }
});

test("frontend turn owner covers resolution and completion fallback branches", async () => {
  const resolved = createDriver();
  await resolved.driver.connect();
  resolved.client.resolveSubmittedTurn = () => ({});
  const blankResolution = await resolved.driver.runTurn({
    text: "resolution without terminal",
    promptContext: { sentAt: Date.now() },
    assumeConnected: true,
  });
  assert.equal(blankResolution.finalText, "owner final");

  resolved.client.resolveSubmittedTurn = () => {
    throw new Error("resolution lookup unavailable");
  };
  const lookupFailure = await resolved.driver.runTurn({
    text: "resolution lookup failure",
    promptContext: { sentAt: Date.now() },
    assumeConnected: true,
  });
  assert.equal(lookupFailure.finalText, "owner final");

  resolved.client.resolveSubmittedTurn = () => ({
    superseded: true,
    sessionId: "",
    sessionFile: "",
  });
  const superseded = await resolved.driver.runTurn({
    text: "superseded fallback",
    promptContext: { sentAt: Date.now() },
    assumeConnected: true,
  });
  assert.equal(superseded.superseded, true);
  assert.equal(superseded.sessionId, resolved.client.sessionId);

  resolved.client.resolveSubmittedTurn = () => ({ error: "owner error" });
  await assert.rejects(
    resolved.driver.runTurn({
      text: "error fallback",
      promptContext: { sentAt: Date.now() },
      assumeConnected: true,
    }),
    (error: any) =>
      error.message === "owner error" &&
      error.sessionId === undefined &&
      error.sessionFile === undefined,
  );

  resolved.client.resolveSubmittedTurn = () => null;
  const blankText = await resolved.driver.runTurn({
    text: " ",
    promptContext: { sentAt: Date.now() },
    assumeConnected: true,
    streamingBehavior: "steer",
    images: null as any,
  });
  assert.equal(blankText.finalText, "owner final");

  const completeFirst = createDriver();
  await completeFirst.driver.connect();
  completeFirst.client.prompt = async function prompt(
    text: string,
    options: any,
  ) {
    this.record("prompt", { text, options });
    await this.emitBackend({
      type: "turn_complete",
      requestTag: options.requestTag,
      finalText: "terminal won race",
      result: { source: "terminal" },
    });
    await new Promise(() => undefined);
    return { acceptedAs: "prompt" };
  };
  const won = await within(
    completeFirst.driver.runTurn({
      text: "terminal race",
      assumeConnected: true,
      assumeSessionReady: true,
    }),
    "terminal-completion-race",
  );
  assert.equal(won.finalText, "terminal won race");
  assert.deepEqual(won.result, { source: "terminal" });

  const unknownAdmission = createDriver();
  await unknownAdmission.driver.connect();
  unknownAdmission.client.promptAdmission = { acceptedAs: "unexpected" };
  const unknown = await unknownAdmission.driver.runTurn({
    text: "unknown admission",
    assumeConnected: true,
    assumeSessionReady: true,
  });
  assert.equal(unknown.finalText, "owner final");

  const noSessionCommand = createDriver();
  await noSessionCommand.driver.connect();
  noSessionCommand.client.runCommand = async (commandLine: string) => {
    noSessionCommand.client.record("runCommand", { commandLine });
    return {};
  };
  const emptyCommand = await noSessionCommand.driver.runCommand("/owner", {
    assumeConnected: true,
    assumeSessionReady: true,
  });
  assert.equal(emptyCommand.sessionFile, undefined);
  assert.equal(emptyCommand.sessionId, noSessionCommand.client.sessionId);
  const compactDefault = await noSessionCommand.driver.runCommand("/compact", {
    assumeConnected: true,
    assumeSessionReady: true,
  });
  assert.equal(compactDefault.handled, true);
  const abortIdle = await noSessionCommand.driver.runCommand("/abort", {
    assumeConnected: true,
    assumeSessionReady: true,
  });
  assert.equal(abortIdle.handled, undefined);
});

test("frontend turn owner keeps session and terminal fallbacks deterministic", async () => {
  const noState = createDriver();
  noState.client.sessionId = "";
  noState.client.sessionFile = "";
  noState.client.getState = async () => ({}) as any;
  noState.client.request = async function request(command: any) {
    this.record("request", { command });
    if (command.type === "get_state") return {};
    if (command.type === "run_command") return {};
    return {};
  };
  noState.client.newSession = async () => ({ cancelled: true });
  await noState.driver.connect();
  const newWithoutLeaf = await noState.driver.runCommand("/new", {
    assumeConnected: true,
  });
  assert.equal(newWithoutLeaf.sessionId, undefined);
  assert.equal(newWithoutLeaf.sessionFile, undefined);
  const commandWithoutState = await noState.driver.runCommand("/owner", {
    assumeConnected: true,
    assumeSessionReady: true,
  });
  assert.equal(commandWithoutState.sessionId, undefined);
  assert.equal(commandWithoutState.sessionFile, undefined);

  const interrupt = createDriver();
  await interrupt.driver.connect();
  interrupt.client.promptCompletes = false;
  interrupt.client.abort = (() => {
    interrupt.client.record("abort");
    throw new Error("abort transport closed");
  }) as any;
  const pending = interrupt.driver.runTurn({
    text: "interrupt fallback",
    assumeConnected: true,
    assumeSessionReady: true,
    requestTag: "interrupt-fallback",
  });
  await waitFor(
    () => interrupt.client.calls.some((call) => call.type === "prompt"),
    "interrupt fallback prompt was not submitted",
  );
  const interrupted = interrupt.driver.interruptActiveTurnLikeTui();
  assert.equal(interrupted.sessionId, interrupt.client.sessionId);
  await assert.rejects(
    within(pending, "interrupt-fallback"),
    /chat_turn_aborted/,
  );

  const terminal = createDriver();
  await terminal.driver.connect();
  terminal.client.promptCompletes = false;
  const pendingComplete = terminal.driver.runTurn({
    text: "terminal without tag",
    assumeConnected: true,
    assumeSessionReady: true,
    requestTag: "terminal-owned",
  });
  await waitFor(
    () => terminal.client.calls.some((call) => call.type === "prompt"),
    "terminal-owned prompt was not submitted",
  );
  await terminal.client.emitUi({ type: "session_recovering" });
  await terminal.client.emitUi({ type: "session_recovered" });
  await terminal.client.emitBackend({
    type: "turn_complete",
    requestTag: "terminal-owned",
    finalText: "owned final",
  });
  assert.equal(
    (await within(pendingComplete, "owned-complete")).finalText,
    "owned final",
  );

  const terminalError = createDriver();
  await terminalError.driver.connect();
  terminalError.client.promptCompletes = false;
  const pendingError = terminalError.driver.runTurn({
    text: "terminal error without tag",
    assumeConnected: true,
    assumeSessionReady: true,
    requestTag: "terminal-error-owned",
  });
  await waitFor(
    () => terminalError.client.calls.some((call) => call.type === "prompt"),
    "terminal-error prompt was not submitted",
  );
  await terminalError.client.emitBackend({
    type: "turn_error",
    requestTag: "terminal-error-owned",
    error: "owned terminal error",
  });
  await assert.rejects(
    within(pendingError, "owned-error"),
    /owned terminal error/,
  );

  let releaseResume!: () => void;
  const lateRestore = createDriver();
  lateRestore.client.resumeSession = async () => {
    await new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
  };
  const restoring = lateRestore.driver.connect({
    restoreSessionFile: "/tmp/late-restore.jsonl",
  });
  await waitFor(() => Boolean(releaseResume), "late restore did not start");
  const detachRestore = lateRestore.driver.detachForDaemonShutdown();
  releaseResume();
  await detachRestore;
  assert.equal(await restoring, false);
});

test("passive notice deferral follows visible turn state", () => {
  assert.equal(frontend.shouldDeferPassiveNoticeForTurnState({}), false);
  assert.equal(
    frontend.shouldDeferPassiveNoticeForTurnState({
      liveTurn: {},
      isStreaming: false,
    }),
    true,
  );
  assert.equal(
    frontend.shouldDeferPassiveNoticeForTurnState({ isStreaming: true }),
    true,
  );
  assert.equal(
    frontend.shouldDeferPassiveNoticeForTurnState({ turnActive: true }),
    true,
  );
});
