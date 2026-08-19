import "../support/require-test-sandbox.ts";
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
    if (this.promptAdmission?.acceptedAs === "unexpected") {
      return this.promptAdmission;
    }
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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

test("frontend turn owner translates backend events and preserves terminal ownership", async () => {
  const { driver, client } = createDriver();
  const seen: any[] = [];
  const badListener = () => {
    throw new Error("listener failure is isolated");
  };
  const unsubscribeBad = driver.subscribe(badListener);
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
  assert.ok(seen.some((event) => event.type === "user_message_start"));
  assert.ok(!seen.some((event) => event.type === "user_message_persisted"));
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
  assert.equal(driver.frontendPhase, "idle");
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

  unsubscribeBad();
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
    /Agent returned an empty response/,
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
  const failedRejection = assert.rejects(failed, /provider exploded/);
  await client.emitBackend({
    type: "turn_error",
    requestTag: "failed-turn",
    error: "provider exploded",
    sessionId: client.sessionId,
    sessionFile: client.sessionFile,
  });
  await failedRejection;

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
    let interruptedSettled = false;
    void interrupted.then(
      () => {
        interruptedSettled = true;
      },
      () => {
        interruptedSettled = true;
      },
    );
    const replacement = await active.driver.runCommand("/new", {
      assumeConnected: true,
      managedSessionLeaf: "owner/replacement",
    });
    assert.equal(replacement.handled, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(interruptedSettled, false);
    assert.ok(active.client.calls.some((call) => call.type === "newSession"));
    await (active.driver as any).handleClientEvent({
      type: "rpc_turn_event",
      event: "error",
      requestTag: "long-owner-turn",
      error: "Request was aborted",
      terminalRecord: {
        terminalId: "terminal-long-owner-turn-aborted",
        state: "error",
        terminalAt: "2026-08-07T00:00:00.000Z",
      },
    });
    const interruptedResult = await within(
      interrupted,
      "long-owner-turn-terminal",
    );
    assert.equal(interruptedResult.superseded, true);
    assert.equal(interruptedResult.outcome, "terminalOwner");
    assert.equal(
      interruptedResult.terminalRecord?.terminalId,
      "terminal-long-owner-turn-aborted",
    );

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
  (noState.client as any).ensureSessionReady = undefined;
  await noState.driver.connect();
  const readyWithoutState = await (noState.driver as any).ensureSessionReady();
  assert.deepEqual(readyWithoutState, {
    sessionId: undefined,
    sessionFile: undefined,
  });
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
  let pendingSettled = false;
  void pending.then(
    () => {
      pendingSettled = true;
    },
    () => {
      pendingSettled = true;
    },
  );
  const commandError = await interrupt.driver
    .runCommand("/abort", { assumeConnected: true })
    .then(
      () => null,
      (error: Error) => error,
    );
  assert.match(commandError?.message || "", /abort transport closed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingSettled, false);
  await (interrupt.driver as any).handleClientEvent({
    type: "rpc_turn_event",
    event: "error",
    requestTag: "interrupt-fallback",
    error: "Request was aborted",
    terminalRecord: {
      terminalId: "terminal-interrupt-fallback-aborted",
      state: "error",
      terminalAt: "2026-08-07T00:00:01.000Z",
    },
  });
  await assert.rejects(
    within(pending, "interrupt-fallback-terminal"),
    /Request was aborted/,
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

test("frontend turn owner covers listener error reporting and client fallback boundaries", async () => {
  const reported: any[] = [];
  const client = new IntegratedFrontendClient() as any;
  client.shutdownSession = undefined;
  client.terminateSession = undefined;
  client.request = async (command: any) => {
    client.record("request", { command });
    return { success: true };
  };
  const driver = new frontend.RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "owner-errors",
    onEventHandlingError: async (failure: any) => {
      reported.push(failure);
      if (failure.error?.message === "reject-reporter") {
        throw new Error("reporter rejected");
      }
      if (failure.error?.message === "throw-reporter") {
        throw new Error("reporter threw");
      }
    },
  }) as any;
  const originalConsoleError = console.error;
  const logs: any[] = [];
  console.error = (...args: any[]) => logs.push(args);
  try {
    const removeSync = driver.subscribe(() => {
      throw new Error("throw-reporter");
    });
    driver.emit({ type: "frontend_status", phase: "ready" });
    removeSync();

    const removeAsync = driver.subscribe(async () => {
      throw new Error("reject-reporter");
    });
    driver.emit({ type: "frontend_status", phase: "ready" });
    await new Promise((resolve) => setImmediate(resolve));
    removeAsync();

    const noReporter = createDriver();
    const removeNoReporter = (noReporter.driver as any).subscribe(() => {
      throw new Error("no reporter");
    });
    (noReporter.driver as any).emit({
      type: "frontend_status",
      phase: "ready",
    });
    removeNoReporter();

    const waited: string[] = [];
    const removeWaited = driver.subscribe(async () => {
      waited.push("waited");
    });
    await driver.emitAndWait({ type: "frontend_status", phase: "ready" });
    removeWaited();
    assert.deepEqual(waited, ["waited"]);
    assert.ok(reported.length >= 2);
    assert.ok(logs.length >= 2);

    const syncReporter = new frontend.RinFrontendTurnDriver({
      clientFactory: () => new IntegratedFrontendClient() as any,
      onEventHandlingError: () => {
        throw new Error("sync reporter failed");
      },
    }) as any;
    const removeSyncReporter = syncReporter.subscribe(() => {
      throw new Error("sync listener failed");
    });
    syncReporter.emit({ type: "frontend_status", phase: "ready" });
    removeSyncReporter();

    await driver.connect();
    assert.equal(driver.hasClient(), true);
    client.turnActive = true;
    await (driver as any).refreshFrontendState();
    assert.equal(driver.hasWorkerActiveTurn(), true);
    await driver.shutdownSession();
    assert.equal(driver.hasClient(), false);
    assert.ok(
      client.calls.some(
        (call: any) => call.command?.type === "shutdown_session",
      ),
    );

    await driver.connect();
    await driver.terminateSession();
    assert.ok(
      client.calls.some(
        (call: any) => call.command?.type === "terminate_session",
      ),
    );
    assert.equal(
      await driver.disconnectSupersededClient((driver as any).client),
      false,
    );
    (driver as any).daemonShutdownDetached = true;
    assert.equal(
      await driver.disconnectSupersededClient((driver as any).client),
      true,
    );
    (driver as any).daemonShutdownDetached = false;
    (driver as any).frontendState = {
      sessionRecovering: true,
      working: true,
      turnActive: false,
      isStreaming: false,
    };
    assert.equal(driver.isSessionRecovering(), true);
    assert.equal(driver.isBackendWorking(), true);
    const lifecycleGate = driver.inputSubmissionGate("", undefined);
    assert.equal(typeof lifecycleGate.isAborted, "function");
    assert.equal(lifecycleGate.isAborted(), false);
    const currentInterruptionSeq = (driver as any).turnInterruptionSeq;
    assert.equal(
      driver.inputSubmissionGate("", currentInterruptionSeq).isAborted(),
      false,
    );
    assert.equal(
      driver.inputSubmissionGate("", currentInterruptionSeq - 1).isAborted(),
      true,
    );
    assert.doesNotThrow(() =>
      driver.throwIfTurnInterrupted(currentInterruptionSeq),
    );
    assert.throws(
      () => driver.throwIfTurnInterrupted(currentInterruptionSeq - 1),
      /rin_frontend_turn_cancelled/,
    );
    (driver as any).frontendState.isStreaming = false;
    (driver as any).frontendState.turnActive = false;
    assert.equal(driver.isStreaming(), false);
    (driver as any).frontendState.isStreaming = true;
    assert.equal(driver.isStreaming(), true);
    (driver as any).frontendState.isStreaming = false;
    (driver as any).frontendState.turnActive = true;
    assert.equal(driver.isStreaming(), true);
    assert.equal(
      driver.terminalRpcTurnPayloadMatchesCurrentSession(null),
      true,
    );
    assert.equal(
      driver.terminalRpcTurnPayloadMatchesCurrentSession({ type: "other" }),
      true,
    );
    assert.equal(
      driver.terminalRpcTurnPayloadMatchesCurrentSession({
        type: "rpc_turn_event",
        event: "delta",
      }),
      true,
    );
    (driver as any).liveTurn = {
      requestTag: "owner-active",
      chatDeliveryContext: { turnId: "owner-turn" },
    };
    assert.equal(
      driver.terminalRpcTurnPayloadMatchesCurrentSession({
        type: "rpc_turn_event",
        event: "complete",
        requestTag: "owner-active",
        chatDeliveryContext: { turnId: "other-turn" },
      }),
      false,
    );
    (driver as any).liveTurn = null;
    (driver as any).frontendState.isCompacting = false;
    assert.equal(driver.inputSubmissionGate("").isCompacting(), false);
    (driver as any).frontendState.isCompacting = true;
    assert.equal(driver.inputSubmissionGate("").isCompacting(), true);
    (driver as any).frontendState.sessionRecovering = false;
    (driver as any).frontendState.working = false;
    assert.equal(driver.isSessionRecovering(), false);
    assert.equal(driver.isBackendWorking(), false);
    await driver.inputSubmissionGate("").refresh();
    await driver.inputSubmissionGate("/owner/session.jsonl").refresh();
    client.turnActive = false;
    await (driver as any).refreshFrontendState();
    await driver.shutdownSession();
    await driver.terminateSession();
    assert.equal(driver.hasWorkerActiveTurn(), false);
    (driver as any).client = undefined;
    assert.equal(driver.hasClient(), false);
    assert.equal(driver.hasWorkerActiveTurn(), false);
    await driver.shutdownSession();
    await driver.terminateSession();
  } finally {
    console.error = originalConsoleError;
  }
});
