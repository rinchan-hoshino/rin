import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleep } from "../platform/process.js";
import type { RpcSocketLike } from "../platform/rpc-socket.js";
import { listStagedChatTerminalWal } from "./chat-terminal-wal.js";
import {
  clearPendingTerminalTurnEvent,
  rememberPendingTerminalTurnEvent,
  takePendingTerminalTurnEvent,
} from "./pending-turn-events.js";
import { setRunningWorkerSession } from "./running-workers.js";
import {
  WORKER_CGROUP_DELEGATION_ENV,
  type WorkerCgroupIsolation,
  type WorkerCgroupLease,
} from "./worker-cgroup-isolation.js";
import { parseJsonl } from "../rin-lib/common.js";
import { isSessionScopedCommand } from "../rin-lib/rpc.js";
import { RIN_DAEMON_WORKER_OWNER_ENV } from "../rin-lib/profile.js";
import {
  hasSessionRef as hasSessionSelector,
  normalizeSessionRef as normalizeSessionSelector,
  resolveSessionRef as resolveSessionSelector,
  sessionRefMatches as sessionMatchesSelector,
  type SessionRef as SessionSelector,
} from "../session/ref.js";

const sessionSelectorFromCommand = normalizeSessionSelector;
const sessionSelectorFromState = normalizeSessionSelector;

export type ConnectionState = {
  socket: RpcSocketLike;
  clientBuffer: string;
  attachedWorker?: WorkerHandle;
  sessionFile?: string;
  sessionId?: string;
  resourceOptions?: Record<string, unknown>;
};

type PendingResponse = {
  id: string;
  commandType: string;
  selector?: SessionSelector;
  expectsTerminalTurnEvent?: boolean;
  workingVisibilityEpoch: number;
  connection?: ConnectionState;
  resolve?: (payload: any) => void;
  reject?: (error: Error) => void;
  finalize?: () => void;
};

type TerminalTurnWaiter = {
  worker: WorkerHandle;
  selector: SessionSelector;
  requestTag?: string;
  resolve: (payload: any) => void;
  reject: (error: Error) => void;
};

type StagedChatTerminal = ReturnType<typeof listStagedChatTerminalWal>[number];

type TerminalRedelivery = {
  payloadHash: string;
  timer: NodeJS.Timeout;
};

type InterruptedTurnRecoveryIntent = {
  selector: SessionSelector;
  source: string;
  requestTag?: string;
  frontendOwner?: boolean;
  workingVisible?: true;
  promise?: Promise<void>;
  retryAttempt?: number;
  retryTimer?: NodeJS.Timeout;
};

type InitialWorkerSession =
  | { kind: "new"; parentSession?: unknown }
  | { kind: "managed"; managedSessionLeaf: string; parentSession?: unknown }
  | { kind: "open"; sessionFile: string };

export type WorkerHandle = {
  id: string;
  child: ReturnType<typeof spawn>;
  cgroupLease?: WorkerCgroupLease;
  stdoutBuffer: { buffer: string };
  stderrBuffer: { buffer: string };
  connections: Set<ConnectionState>;
  pendingResponses: Map<string, PendingResponse>;
  ignoredResponseIds: Set<string>;
  sessionFile?: string;
  sessionId?: string;
  turnActive: boolean;
  rpcTurnActive: boolean;
  turnRecoveryPending: boolean;
  activeRequestTag?: string;
  activeTurnGeneration?: number;
  activeLifecycleRequestTag?: string;
  activeLifecycleSelector?: SessionSelector;
  activeLifecycleOwnerCommandId?: string;
  activeLifecycleFrontendOwner: boolean;
  activeLifecycleRecoveryProbeCommandId?: string;
  lifecycleEpoch: number;
  activeLifecycleEpoch?: number;
  activeLifecycleRecoveryProbeEpoch?: number;
  lastTurnGeneration: number;
  versionedLifecycleSeen: boolean;
  legacyTurnActive: boolean;
  legacyTurnSettled: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  rinWorking: boolean;
  frontendWorkingVisible: boolean;
  restoredFrontendWorkingVisible: boolean;
  frontendWorkingVisibilityEpoch: number;
  lastUsedAt: number;
  idleSince: number | null;
  gracefulShutdownRequested: boolean;
};

function writeLine(socket: RpcSocketLike, payload: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
}

function responseError(commandId: string, commandType: string, error: string) {
  return {
    id: commandId,
    type: "response",
    command: commandType,
    success: false,
    error,
  };
}

function isTerminalRpcTurnEvent(payload: any) {
  return (
    payload?.type === "rpc_turn_event" &&
    (payload.event === "complete" || payload.event === "error")
  );
}

const RESUMABLE_COMMAND_TYPES = new Set([
  "prompt",
  "resume_interrupted_turn",
  "steer",
  "follow_up",
  "compact",
  "send_user_message",
  "run_command",
]);

const TURN_RECOVERY_COMMAND_TYPES = new Set([
  "prompt",
  "resume_interrupted_turn",
  "send_user_message",
]);

const INTERRUPTED_TURN_RECOVERY_RETRY_MIN_MS = 100;
const INTERRUPTED_TURN_RECOVERY_RETRY_MAX_MS = 2_000;
const INTERRUPTED_TURN_RECOVERY_RETRY_LIMIT = 6;

function lifecycleRequestTag(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function expectsTerminalTurnEvent(commandType: string, command: any) {
  if (commandType === "resume_interrupted_turn") return true;
  const requestTag = lifecycleRequestTag(command?.requestTag);
  return requestTag !== undefined && requestTag.length > 0;
}

function hasResumableWorkerActivity(worker: WorkerHandle) {
  if (
    worker.turnActive ||
    worker.turnRecoveryPending ||
    worker.isStreaming ||
    worker.isCompacting ||
    worker.rinWorking
  ) {
    return true;
  }
  for (const pending of worker.pendingResponses.values()) {
    if (RESUMABLE_COMMAND_TYPES.has(pending.commandType)) return true;
  }
  return false;
}

export class WorkerPool {
  private workers = new Set<WorkerHandle>();
  private workersBySessionFile = new Map<string, WorkerHandle>();
  private workersBySessionId = new Map<string, WorkerHandle>();
  private pendingSessionClaims = new Map<
    string,
    Promise<WorkerHandle | undefined>
  >();
  private interruptedTurnRecoveryIntents = new Map<
    string,
    InterruptedTurnRecoveryIntent
  >();
  private terminalTurnWaiters = new Set<TerminalTurnWaiter>();
  private workerSeq = 0;
  private internalRequestSeq = 0;
  private shuttingDown = false;
  private readonly gcIdleMs: number;
  private readonly internalCommandTimeoutMs: number;
  private readonly switchSessionCommandTimeoutMs: number;
  private readonly terminalRedeliveryMs: number;
  private readonly terminalRedeliveries = new Map<
    ConnectionState,
    Map<string, TerminalRedelivery>
  >();
  private readonly reaper: NodeJS.Timeout;

  constructor(
    private options: {
      workerPath: string;
      cwd: string;
      onWorkerSpawn?: (
        requester: ConnectionState | undefined,
        worker: WorkerHandle,
      ) => void;
      gcIdleMs?: number;
      sweepIntervalMs?: number;
      internalCommandTimeoutMs?: number;
      switchSessionCommandTimeoutMs?: number;
      terminalRedeliveryMs?: number;
      resourceOptions?: Record<string, unknown>;
      resourceOptionsDir?: string;
      agentDir?: string;
      workerCgroupIsolation?: WorkerCgroupIsolation;
    },
  ) {
    this.gcIdleMs = Math.max(0, Number(options.gcIdleMs ?? 30_000));
    this.internalCommandTimeoutMs = Math.max(
      1,
      Number(options.internalCommandTimeoutMs ?? 10_000),
    );
    const switchSessionTimeoutDefault =
      options.switchSessionCommandTimeoutMs != null
        ? Number(options.switchSessionCommandTimeoutMs)
        : options.internalCommandTimeoutMs != null
          ? this.internalCommandTimeoutMs
          : 120_000;
    this.switchSessionCommandTimeoutMs = Math.max(
      this.internalCommandTimeoutMs,
      switchSessionTimeoutDefault,
    );
    this.terminalRedeliveryMs = Math.max(
      10,
      Number(options.terminalRedeliveryMs ?? 1_000),
    );
    const sweepIntervalMs = Math.max(
      250,
      Number(options.sweepIntervalMs ?? Math.min(this.gcIdleMs || 250, 5_000)),
    );
    this.reaper = setInterval(() => {
      this.evictDetachedWorkers();
    }, sweepIntervalMs);
    this.reaper.unref?.();
  }

  detachWorker(
    connection: ConnectionState,
    options: { clearSelection?: boolean; release?: boolean } = {},
  ) {
    const worker = connection.attachedWorker;
    if (worker) {
      worker.connections.delete(connection);
      connection.attachedWorker = undefined;
      worker.lastUsedAt = Date.now();
      if (options.release !== false) this.maybeReleaseWorker(worker);
    }
    if (options.clearSelection) {
      this.rememberSessionSelection(connection, {});
    }
    return worker;
  }

  terminateWorkerGracefully(worker: WorkerHandle) {
    void this.requestWorkerExitGracefully(worker, { type: "shutdown_session" });
  }

  sleepWorkerGracefully(worker: WorkerHandle) {
    void this.requestWorkerExitGracefully(worker, { type: "sleep_session" });
  }

  async terminateWorkerGracefullyIfUnattached(worker: WorkerHandle) {
    if (worker.connections.size > 0) return;
    await this.terminateWorkerGracefullyAndFlush(worker);
  }

  private async terminateWorkerGracefullyAndFlush(worker: WorkerHandle) {
    await this.requestWorkerExitGracefully(worker, {
      type: "shutdown_session",
    });
  }

  private async requestWorkerExitGracefully(
    worker: WorkerHandle,
    command: { type: "shutdown_session" | "sleep_session" },
  ) {
    if (!this.workers.has(worker) || worker.gracefulShutdownRequested) return;
    worker.gracefulShutdownRequested = true;
    const exitPromise = this.waitForWorkerExit(worker);
    const written = await this.writeWorkerStdinAndWait(worker, command);
    if (!written) {
      this.destroyWorker(worker);
      return;
    }
    await exitPromise;
  }

  private async waitForWorkerExit(worker: WorkerHandle) {
    if (!this.workers.has(worker)) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      function onExit() {
        finish(true);
      }
      const timeout = setTimeout(() => {
        this.destroyWorker(worker, { signal: "SIGKILL" });
        finish(false);
      }, this.internalCommandTimeoutMs);
      function finish(result: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.child.off("exit", onExit);
        resolve(result);
      }
      timeout.unref?.();
      worker.child.once("exit", onExit);
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        finish(true);
      }
    });
  }

  destroyWorker(
    worker: WorkerHandle,
    options: { signal?: NodeJS.Signals } = {},
  ) {
    if (!this.workers.has(worker)) return;
    this.rejectTerminalTurnWaiters(worker, new Error("rin_worker_exit"));
    worker.gracefulShutdownRequested = true;
    this.workers.delete(worker);
    if (!this.shuttingDown || !this.isWorkerRunning(worker)) {
      this.clearRunningWorkerRecord(worker);
    }
    this.deleteWorkerSessionRefs(worker);
    for (const connection of Array.from(worker.connections)) {
      if (connection.attachedWorker === worker) {
        connection.attachedWorker = undefined;
      }
      worker.connections.delete(connection);
      writeLine(connection.socket, {
        type: "worker_exit",
        code: null,
        signal: "SIGTERM",
      });
    }
    for (const pending of Array.from(worker.pendingResponses.values())) {
      pending.finalize?.();
      if (pending.reject) {
        pending.reject(new Error("rin_worker_exit"));
        continue;
      }
      if (pending.connection) {
        writeLine(
          pending.connection.socket,
          responseError(pending.id, pending.commandType, "rin_worker_exit"),
        );
      }
    }
    worker.pendingResponses.clear();
    worker.ignoredResponseIds.clear();
    try {
      worker.child.stdin.end();
    } catch {}
    try {
      worker.child.stdout.destroy();
    } catch {}
    try {
      worker.child.stderr.destroy();
    } catch {}
    try {
      worker.child.kill(options.signal || "SIGTERM");
    } catch {}
  }

  evictDetachedWorkers() {
    for (const worker of Array.from(this.workers)) {
      this.maybeReleaseWorker(worker);
    }
  }

  requestWorker(
    worker: WorkerHandle,
    connection: ConnectionState,
    command: any,
    attach: boolean,
  ) {
    const commandType = String(command?.type || "unknown");
    const commandId = command?.id ? String(command.id) : undefined;
    if (
      commandId !== undefined &&
      (worker.pendingResponses.has(commandId) ||
        worker.activeLifecycleOwnerCommandId === commandId)
    ) {
      writeLine(
        connection.socket,
        responseError(commandId, commandType, "rin_duplicate_command_id"),
      );
      return;
    }
    if (attach) this.attachWorker(connection, worker);
    const selector = this.getSessionSelector(command);
    if (hasSessionSelector(selector)) {
      this.rememberSessionSelection(connection, selector);
    }
    worker.lastUsedAt = Date.now();
    worker.idleSince = null;
    const wasRunning = this.isWorkerRunning(worker);
    const recoverySelector = resolveSessionSelector(
      selector,
      resolveSessionSelector(
        this.getConnectionSelector(connection),
        this.getWorkerSelector(worker),
      ),
    );
    const keepUntilTerminalTurnEvent = expectsTerminalTurnEvent(
      commandType,
      command,
    );
    const commandRequestTag = lifecycleRequestTag(command?.requestTag);
    const terminalLifecycleCommand =
      TURN_RECOVERY_COMMAND_TYPES.has(commandType);
    const workerHasLiveTurn = Boolean(
      worker.turnActive ||
      worker.rpcTurnActive ||
      worker.isStreaming ||
      worker.isCompacting ||
      worker.rinWorking,
    );
    const canRejoinPendingFrontendTurn = Boolean(
      worker.activeLifecycleFrontendOwner &&
      commandRequestTag === worker.activeLifecycleRequestTag &&
      worker.turnRecoveryPending,
    );
    const canSubmitPromptToOwnedLifecycle = Boolean(
      commandType === "prompt" &&
      worker.activeLifecycleFrontendOwner &&
      (workerHasLiveTurn || canRejoinPendingFrontendTurn),
    );
    let lifecycleAdmissionError = "";
    if (
      terminalLifecycleCommand &&
      (commandRequestTag === undefined ||
        (commandType !== "resume_interrupted_turn" &&
          commandRequestTag.length === 0))
    ) {
      lifecycleAdmissionError = "rin_turn_request_tag_required";
    } else if (
      terminalLifecycleCommand &&
      worker.activeLifecycleRequestTag !== undefined &&
      !canSubmitPromptToOwnedLifecycle
    ) {
      lifecycleAdmissionError = "rin_turn_recovery_in_progress";
    } else if (
      terminalLifecycleCommand &&
      worker.activeLifecycleRequestTag === undefined &&
      wasRunning
    ) {
      lifecycleAdmissionError = "rin_turn_recovery_in_progress";
    }
    if (lifecycleAdmissionError) {
      if (commandId !== undefined) {
        writeLine(
          connection.socket,
          responseError(commandId, commandType, lifecycleAdmissionError),
        );
      }
      return;
    }
    if (commandId !== undefined) {
      worker.pendingResponses.set(commandId, {
        id: commandId,
        commandType,
        selector: recoverySelector,
        expectsTerminalTurnEvent: keepUntilTerminalTurnEvent,
        workingVisibilityEpoch: worker.frontendWorkingVisibilityEpoch,
        connection,
      });
    }
    if (TURN_RECOVERY_COMMAND_TYPES.has(commandType)) {
      const installsLifecycleOwner = Boolean(
        keepUntilTerminalTurnEvent &&
        commandRequestTag !== undefined &&
        !wasRunning &&
        worker.activeLifecycleRequestTag === undefined,
      );
      if (installsLifecycleOwner && commandRequestTag !== undefined) {
        worker.turnRecoveryPending = true;
        this.setLifecycleOwner(
          worker,
          commandRequestTag,
          recoverySelector,
          commandId,
          true,
        );
        if (commandRequestTag) worker.activeRequestTag = commandRequestTag;
      }
      this.syncRunningWorkerRecordForSelector(
        recoverySelector,
        true,
        worker.activeLifecycleRequestTag ?? worker.activeRequestTag,
        worker.activeLifecycleFrontendOwner,
        worker.frontendWorkingVisible,
      );
    }
    this.syncRunningWorkerRecord(worker);
    this.writeWorkerStdin(worker, command, (error) => {
      this.handleWorkerStdinFailure(worker, error);
    });
  }

  forwardToWorker(
    connection: ConnectionState,
    worker: WorkerHandle,
    command: any,
  ) {
    this.requestWorker(worker, connection, command, true);
  }

  attachWorkerToConnection(connection: ConnectionState, worker: WorkerHandle) {
    this.attachWorker(connection, worker);
  }

  async readWorkerState(
    worker: WorkerHandle,
    options: { lifecycleRecoveryProbe?: boolean } = {},
  ) {
    const payload = await this.sendInternalCommand(
      worker,
      { type: "get_state" },
      options,
    );
    if (payload?.success !== true) {
      throw new Error(String(payload?.error || "rin_worker_state_unavailable"));
    }
    return payload.data || {};
  }

  hasSelectedSession(connection: ConnectionState) {
    return hasSessionSelector(this.getConnectionSelector(connection));
  }

  async selectSession(connection: ConnectionState, selector: SessionSelector) {
    const wanted = sessionSelectorFromState(selector);
    let previousWorker: WorkerHandle | undefined;
    if (
      connection.attachedWorker &&
      !this.workerMatchesSelector(connection.attachedWorker, wanted)
    ) {
      previousWorker = this.detachWorker(connection, { release: false });
    }
    this.rememberSessionSelection(connection, wanted);
    const existing = this.findWorkerBySelector(wanted);
    if (existing) {
      this.attachWorker(connection, existing);
      if (previousWorker)
        void this.terminateWorkerGracefullyIfUnattached(previousWorker);
      return existing;
    }
    if (previousWorker)
      await this.terminateWorkerGracefullyIfUnattached(previousWorker);
    return await this.ensureSelectedWorker(connection);
  }

  async ensureSelectedWorker(
    connection: ConnectionState,
    selector?: SessionSelector,
  ) {
    if (selector) {
      this.rememberSessionSelection(
        connection,
        sessionSelectorFromState(selector),
      );
    }
    const wanted = this.getConnectionSelector(connection);
    if (!hasSessionSelector(wanted)) {
      return connection.attachedWorker;
    }
    if (
      connection.attachedWorker &&
      this.isWorkerRoutable(connection.attachedWorker) &&
      this.workerMatchesSelector(connection.attachedWorker, wanted)
    ) {
      return connection.attachedWorker;
    }
    if (
      connection.attachedWorker &&
      !this.isWorkerRoutable(connection.attachedWorker)
    ) {
      this.detachWorker(connection, { release: false });
    }
    const existing = this.findWorkerBySelector(wanted);
    if (existing) {
      this.attachWorker(connection, existing);
      return existing;
    }
    if (!wanted.sessionFile) return undefined;

    const claimed = await this.withSessionClaim(wanted, async () => {
      const existing = this.findWorkerBySelector(wanted);
      if (existing) return existing;
      return this.createWorkerForSession(wanted, connection);
    });
    if (claimed) this.attachWorker(connection, claimed);
    return claimed;
  }
  resolveCurrentWorkerForCommand(connection: ConnectionState, command: any) {
    const selector = this.resolveSelector(connection, command);
    const selectedWorker = this.findWorkerBySelector(selector);
    if (selectedWorker) return selectedWorker;
    if (
      connection.attachedWorker &&
      this.isWorkerRoutable(connection.attachedWorker) &&
      (!hasSessionSelector(selector)
        ? true
        : this.workerMatchesSelector(connection.attachedWorker, selector))
    ) {
      return connection.attachedWorker;
    }
    return undefined;
  }

  resolveWorkerForCommand(connection: ConnectionState, command: any) {
    const type = String(command?.type || "unknown");

    if (type === "new_session") {
      if (command.resourceOptions)
        connection.resourceOptions = command.resourceOptions;
      const managedSessionLeaf = String(
        command.managedSessionLeaf || "",
      ).trim();
      return this.createWorker(
        connection,
        this.resourceOptionsWithInitialSession(
          connection.resourceOptions,
          managedSessionLeaf
            ? {
                kind: "managed",
                managedSessionLeaf,
                parentSession: command.parentSession,
              }
            : { kind: "new", parentSession: command.parentSession },
        ),
      );
    }

    const currentWorker = this.resolveCurrentWorkerForCommand(
      connection,
      command,
    );
    if (currentWorker) return currentWorker;
    if (isSessionScopedCommand(type)) return undefined;
    return undefined;
  }

  async abortWorker(worker: WorkerHandle) {
    if (!this.workers.has(worker) || worker.gracefulShutdownRequested) return;
    await this.sendInternalCommand(worker, { type: "abort" });
  }

  getStatusSnapshot() {
    const workers = Array.from(this.workers).map((worker) => {
      const state = worker.gracefulShutdownRequested
        ? "stopping"
        : worker.isCompacting
          ? "compacting"
          : worker.turnActive ||
              worker.turnRecoveryPending ||
              worker.isStreaming ||
              worker.rinWorking
            ? "working"
            : worker.idleSince
              ? "idle"
              : "attached";
      return {
        id: worker.id,
        pid: worker.child.pid ?? null,
        sessionFile: worker.sessionFile,
        sessionId: worker.sessionId,
        attachedConnections: worker.connections.size,
        pendingResponses: worker.pendingResponses.size,
        turnActive: worker.turnActive,
        isStreaming: worker.isStreaming,
        isCompacting: worker.isCompacting,
        rinWorking: worker.rinWorking,
        state,
        lastUsedAt: worker.lastUsedAt,
        idleSince: worker.idleSince,
        gracefulShutdownRequested: worker.gracefulShutdownRequested,
        role: "session",
      };
    });
    return {
      workerCount: workers.length,
      activeWorkerCount: workers.filter(
        (worker) => worker.state === "working" || worker.state === "compacting",
      ).length,
      workers,
    };
  }

  destroyAll() {
    clearInterval(this.reaper);
    for (const redeliveries of this.terminalRedeliveries.values()) {
      for (const redelivery of redeliveries.values()) {
        clearTimeout(redelivery.timer);
      }
    }
    this.terminalRedeliveries.clear();
    for (const intent of this.interruptedTurnRecoveryIntents.values()) {
      if (intent.retryTimer) clearTimeout(intent.retryTimer);
    }
    this.interruptedTurnRecoveryIntents.clear();
    for (const worker of Array.from(this.workers)) {
      this.destroyWorker(worker);
    }
  }

  beginShutdown() {
    this.shuttingDown = true;
    for (const worker of Array.from(this.workers)) {
      for (const connection of Array.from(worker.connections)) {
        if (connection.attachedWorker === worker) {
          connection.attachedWorker = undefined;
        }
        worker.connections.delete(connection);
      }
      this.maybeReleaseWorker(worker);
    }
  }

  getRestorableSessionSelectors() {
    const restorable = new Map<
      string,
      { sessionFile: string; resumeTurn: boolean }
    >();
    for (const worker of this.workers) {
      if (worker.gracefulShutdownRequested) continue;
      const selector = this.getWorkerSelector(worker);
      if (!selector.sessionFile) continue;
      const resumeTurn = this.isWorkerRunning(worker);
      const existing = restorable.get(selector.sessionFile);
      if (existing) {
        existing.resumeTurn ||= resumeTurn;
        continue;
      }
      restorable.set(selector.sessionFile, {
        sessionFile: selector.sessionFile,
        resumeTurn,
      });
    }
    return Array.from(restorable.values());
  }

  restoreSessionWorker(item: { sessionFile?: string }) {
    const selector = sessionSelectorFromState(item);
    if (!selector.sessionFile) return;
    return this.restoreWorkerForSession(selector, false);
  }

  continueInterruptedTurnSessionWorker(item: {
    sessionFile?: string;
    source?: string;
    requestTag?: string;
    frontendOwner?: boolean;
    workingVisible?: true;
  }) {
    const selector = sessionSelectorFromState(item);
    if (!selector.sessionFile) return;
    const key = this.sessionClaimKey(selector);
    if (!key) return;
    const existing = this.interruptedTurnRecoveryIntents.get(key);
    const owningWorker = this.findWorkerBySelector(selector);
    const requestedTag = lifecycleRequestTag(item.requestTag);
    const requestedWorkingVisible = Boolean(
      item.frontendOwner === true &&
      (owningWorker && owningWorker.frontendWorkingVisibilityEpoch > 0
        ? owningWorker.frontendWorkingVisible
        : item.workingVisible === true),
    );
    const intent = existing || {
      selector,
      source: item.source || "daemon-restart",
      requestTag:
        requestedTag !== undefined && requestedTag.length > 0
          ? requestedTag
          : undefined,
      frontendOwner: item.frontendOwner === true,
      ...(requestedWorkingVisible ? { workingVisible: true as const } : {}),
    };
    intent.source = item.source || intent.source || "daemon-restart";
    if (requestedTag !== undefined && requestedTag.length > 0) {
      intent.requestTag = requestedTag;
    }
    intent.frontendOwner = item.frontendOwner === true;
    if (requestedWorkingVisible) {
      intent.workingVisible = true;
    } else {
      delete intent.workingVisible;
    }
    this.interruptedTurnRecoveryIntents.set(key, intent);
    const expectedTag = intent.requestTag ?? "";
    if (
      owningWorker?.activeLifecycleRequestTag === expectedTag &&
      (!owningWorker.activeLifecycleSelector ||
        sessionMatchesSelector(
          intent.selector,
          owningWorker.activeLifecycleSelector,
        ))
    ) {
      owningWorker.activeLifecycleFrontendOwner = intent.frontendOwner === true;
      if (intent.workingVisible !== true) {
        owningWorker.frontendWorkingVisible = false;
        owningWorker.restoredFrontendWorkingVisible = false;
        owningWorker.frontendWorkingVisibilityEpoch += 1;
      }
      this.syncRunningWorkerRecord(owningWorker);
    }
    return this.runInterruptedTurnRecoveryIntent(key, intent);
  }

  private async runInterruptedTurnRecoveryIntent(
    key: string,
    intent: InterruptedTurnRecoveryIntent,
  ) {
    if (intent.promise) return await intent.promise;
    if (intent.retryTimer) {
      clearTimeout(intent.retryTimer);
      intent.retryTimer = undefined;
    }
    intent.promise = (async () => {
      const worker = await this.ensureWorkerForSession(intent.selector);
      if (!this.isWorkerRoutable(worker)) return false;
      const expectedTag = intent.requestTag ?? "";
      const ownsLifecycle =
        worker.activeLifecycleRequestTag === expectedTag &&
        (!worker.activeLifecycleSelector ||
          sessionMatchesSelector(
            intent.selector,
            worker.activeLifecycleSelector,
          ));
      const liveTurnActivity = Boolean(
        worker.turnActive ||
        worker.rpcTurnActive ||
        worker.isStreaming ||
        worker.isCompacting ||
        worker.rinWorking,
      );
      const hasPendingRecovery = this.hasPendingInterruptedTurnRecovery(worker);
      const hasConfirmedOwnedLiveTurn = Boolean(
        liveTurnActivity &&
        worker.versionedLifecycleSeen &&
        worker.activeTurnGeneration !== undefined,
      );
      if (worker.activeLifecycleRequestTag !== undefined) {
        if (!ownsLifecycle) return false;
        worker.activeLifecycleFrontendOwner = intent.frontendOwner === true;
        if (hasPendingRecovery || hasConfirmedOwnedLiveTurn) {
          this.syncRunningWorkerRecordForSelector(
            intent.selector,
            true,
            intent.requestTag,
            intent.frontendOwner === true,
            intent.workingVisible === true,
          );
          return true;
        }
      } else {
        if (liveTurnActivity) return false;
        if (hasPendingRecovery) return true;
      }
      worker.lastUsedAt = Date.now();
      worker.idleSince = null;
      worker.turnRecoveryPending = true;
      if (!ownsLifecycle) {
        this.setLifecycleOwner(
          worker,
          expectedTag,
          intent.selector,
          undefined,
          intent.frontendOwner === true,
        );
      }
      if (intent.requestTag) worker.activeRequestTag = intent.requestTag;
      if (
        intent.workingVisible === true &&
        intent.frontendOwner === true &&
        worker.frontendWorkingVisible &&
        worker.frontendWorkingVisibilityEpoch > 0
      ) {
        worker.restoredFrontendWorkingVisible = true;
      }
      this.syncRunningWorkerRecordForSelector(
        intent.selector,
        true,
        intent.requestTag,
        intent.frontendOwner === true,
        intent.workingVisible === true,
      );
      const probeLifecycleEpoch = worker.activeLifecycleEpoch;
      const probeWorkingVisibilityEpoch = worker.frontendWorkingVisibilityEpoch;
      let state: any;
      try {
        state = await this.readWorkerState(worker, {
          lifecycleRecoveryProbe: true,
        });
      } catch (error) {
        this.syncRunningWorkerRecordForSelector(
          intent.selector,
          true,
          intent.requestTag,
          intent.frontendOwner === true,
          intent.workingVisible === true,
        );
        throw error;
      }
      const probeStillOwnsLifecycle = Boolean(
        this.interruptedTurnRecoveryIntents.get(key) === intent &&
        worker.activeLifecycleEpoch === probeLifecycleEpoch &&
        worker.activeLifecycleRequestTag === expectedTag &&
        (!worker.activeLifecycleSelector ||
          sessionMatchesSelector(
            intent.selector,
            worker.activeLifecycleSelector,
          )),
      );
      if (!probeStillOwnsLifecycle) return true;
      const probeWorkingVisibilityIsCurrent =
        worker.frontendWorkingVisibilityEpoch === probeWorkingVisibilityEpoch;
      if (!probeWorkingVisibilityIsCurrent) {
        this.syncRunningWorkerRecord(worker);
        return false;
      }
      const reportedGeneration = Number(state.turnGeneration);
      const reportedSelector = sessionSelectorFromState(state);
      const ownsReportedRpcTurn = Boolean(
        state.turnActive === true &&
        lifecycleRequestTag(state.requestTag) === expectedTag &&
        worker.activeTurnGeneration !== undefined &&
        Number.isSafeInteger(reportedGeneration) &&
        reportedGeneration === worker.activeTurnGeneration &&
        hasSessionSelector(reportedSelector) &&
        sessionMatchesSelector(reportedSelector, intent.selector),
      );
      if (ownsReportedRpcTurn) {
        worker.turnActive = true;
        worker.rpcTurnActive = true;
        worker.turnRecoveryPending = true;
        worker.versionedLifecycleSeen = true;
        worker.lastTurnGeneration = Math.max(
          worker.lastTurnGeneration,
          reportedGeneration,
        );
        worker.activeTurnGeneration = reportedGeneration;
        worker.isStreaming = Boolean(state.isStreaming);
        if (
          probeWorkingVisibilityIsCurrent &&
          intent.workingVisible === true &&
          intent.frontendOwner === true
        ) {
          worker.frontendWorkingVisible = true;
          worker.restoredFrontendWorkingVisible = true;
        }
        this.syncRunningWorkerRecord(worker);
        return true;
      }
      if (state.turnActive || state.isStreaming || state.piActiveRun) {
        worker.turnActive = false;
        worker.isStreaming = false;
        if (probeWorkingVisibilityIsCurrent) {
          worker.frontendWorkingVisible = false;
          worker.restoredFrontendWorkingVisible = false;
          worker.frontendWorkingVisibilityEpoch += 1;
          delete intent.workingVisible;
        }
        this.syncRunningWorkerRecord(worker);
        return false;
      }
      const liveActivityAfterProbe = Boolean(
        worker.turnActive ||
        worker.rpcTurnActive ||
        worker.isStreaming ||
        worker.isCompacting ||
        worker.rinWorking,
      );
      if (liveActivityAfterProbe) {
        const ownsLateVersionedTurn = Boolean(
          worker.versionedLifecycleSeen &&
          worker.activeTurnGeneration !== undefined,
        );
        return ownsLateVersionedTurn;
      }
      if (state.interruptedTurnResumable === false) {
        if (probeWorkingVisibilityIsCurrent) {
          worker.frontendWorkingVisible = false;
          worker.restoredFrontendWorkingVisible = false;
          worker.frontendWorkingVisibilityEpoch += 1;
          delete intent.workingVisible;
        }
        worker.turnRecoveryPending = false;
        worker.activeRequestTag = undefined;
        worker.activeTurnGeneration = undefined;
        this.clearLifecycleOwner(worker);
        this.syncRunningWorkerRecordForSelector(intent.selector, false);
        this.maybeReleaseWorker(worker);
        return true;
      }
      const canRestoreInterruptedWorkingVisibility = Boolean(
        probeWorkingVisibilityIsCurrent &&
        intent.workingVisible === true &&
        intent.frontendOwner === true &&
        state.interruptedTurnResumable === true &&
        hasSessionSelector(reportedSelector) &&
        sessionMatchesSelector(reportedSelector, intent.selector),
      );
      if (canRestoreInterruptedWorkingVisibility) {
        worker.frontendWorkingVisible = true;
        worker.restoredFrontendWorkingVisible = true;
        this.syncRunningWorkerRecord(worker);
      }
      const response = this.sendInternalCommand(worker, {
        type: "resume_interrupted_turn",
        source: intent.source || "daemon-restart",
        requestTag: intent.requestTag ?? "",
      });
      this.syncRunningWorkerRecord(worker);
      await response;
      return true;
    })()
      .then((completed) => {
        if (this.interruptedTurnRecoveryIntents.get(key) !== intent) return;
        if (completed) {
          this.interruptedTurnRecoveryIntents.delete(key);
        } else {
          intent.promise = undefined;
          this.scheduleInterruptedTurnRecoveryRetry(key, intent);
        }
      })
      .catch(() => {
        if (this.interruptedTurnRecoveryIntents.get(key) === intent) {
          intent.promise = undefined;
          this.scheduleInterruptedTurnRecoveryRetry(key, intent);
        }
      });
    return await intent.promise;
  }

  private scheduleInterruptedTurnRecoveryRetry(
    key: string,
    intent: InterruptedTurnRecoveryIntent,
  ) {
    if (
      this.shuttingDown ||
      intent.retryTimer ||
      this.interruptedTurnRecoveryIntents.get(key) !== intent
    ) {
      return;
    }
    const attempt = Math.max(1, Number(intent.retryAttempt || 0) + 1);
    if (attempt > INTERRUPTED_TURN_RECOVERY_RETRY_LIMIT) {
      this.exhaustInterruptedTurnRecovery(key, intent);
      return;
    }
    intent.retryAttempt = attempt;
    const delayMs = Math.min(
      INTERRUPTED_TURN_RECOVERY_RETRY_MAX_MS,
      INTERRUPTED_TURN_RECOVERY_RETRY_MIN_MS * 2 ** (attempt - 1),
    );
    intent.retryTimer = setTimeout(() => {
      intent.retryTimer = undefined;
      if (
        !this.shuttingDown &&
        this.interruptedTurnRecoveryIntents.get(key) === intent
      ) {
        void this.runInterruptedTurnRecoveryIntent(key, intent);
      }
    }, delayMs);
    intent.retryTimer.unref?.();
  }

  private exhaustInterruptedTurnRecovery(
    key: string,
    intent: InterruptedTurnRecoveryIntent,
  ) {
    if (this.interruptedTurnRecoveryIntents.get(key) !== intent) return;
    if (intent.retryTimer) clearTimeout(intent.retryTimer);
    this.interruptedTurnRecoveryIntents.delete(key);
    const expectedTag = intent.requestTag ?? "";
    rememberPendingTerminalTurnEvent(this.options.agentDir, {
      type: "rpc_turn_event",
      event: "error",
      requestTag: expectedTag,
      ...intent.selector,
      error: "rin_turn_result_recovery_timeout",
    });
    const worker = this.findWorkerBySelector(intent.selector);
    if (!worker) {
      this.syncRunningWorkerRecordForSelector(intent.selector, false);
      return;
    }
    const ownsLifecycle =
      worker.activeLifecycleRequestTag === expectedTag &&
      (!worker.activeLifecycleSelector ||
        sessionMatchesSelector(
          intent.selector,
          worker.activeLifecycleSelector,
        ));
    if (!ownsLifecycle || worker.activeLifecycleFrontendOwner) return;
    worker.turnRecoveryPending = false;
    worker.frontendWorkingVisible = false;
    worker.restoredFrontendWorkingVisible = false;
    worker.frontendWorkingVisibilityEpoch += 1;
    if (worker.activeRequestTag === expectedTag) {
      worker.activeRequestTag = undefined;
    }
    this.clearLifecycleOwner(worker);
    this.syncRunningWorkerRecord(worker);
    this.maybeReleaseWorker(worker);
  }

  private hasPendingInterruptedTurnRecovery(worker: WorkerHandle) {
    for (const pending of worker.pendingResponses.values()) {
      if (pending.commandType === "resume_interrupted_turn") return true;
    }
    const probeId = worker.activeLifecycleRecoveryProbeCommandId;
    return Boolean(probeId && worker.pendingResponses.has(probeId));
  }

  private getInterruptedTurnRecoveryIntent(worker: WorkerHandle) {
    const key = this.sessionClaimKey(this.getWorkerSelector(worker));
    if (!key) return undefined;
    const intent = this.interruptedTurnRecoveryIntents.get(key);
    if (!intent) return undefined;
    return { key, intent };
  }

  private restoreWorkerForSession(
    selector: SessionSelector,
    resumeTurn: boolean,
    source = "daemon-restart",
  ) {
    if (!selector.sessionFile) return;
    if (resumeTurn) {
      this.continueInterruptedTurnSessionWorker({
        sessionFile: selector.sessionFile,
        source,
      });
      return this.findWorkerBySelector(selector);
    }
    const existing = this.findWorkerBySelector(selector);
    if (existing) return existing;
    const key = this.sessionClaimKey(selector);
    if (key && this.pendingSessionClaims.has(key)) return undefined;

    const worker = this.createWorkerForSession(selector);
    void this.withSessionClaim(selector, async () => {
      const existingAfterCreate = this.findWorkerBySelector(selector);
      if (existingAfterCreate && existingAfterCreate !== worker) {
        this.destroyWorker(worker);
        return existingAfterCreate;
      }
      return worker;
    }).catch(() => {});
    return worker;
  }

  async shutdown(graceMs: number) {
    this.beginShutdown();
    const deadline = Date.now() + Math.max(0, graceMs);
    while (this.workers.size > 0 && Date.now() < deadline) {
      await sleep(50);
      for (const worker of Array.from(this.workers)) {
        this.maybeReleaseWorker(worker);
      }
    }
    this.destroyAll();
  }

  private setLifecycleOwner(
    worker: WorkerHandle,
    requestTag: string,
    selector: SessionSelector,
    ownerCommandId?: string,
    frontendOwner = false,
  ) {
    const ownedSelector = resolveSessionSelector(
      this.getWorkerSelector(worker),
      selector,
    );
    worker.activeLifecycleRequestTag = requestTag;
    worker.activeLifecycleSelector = hasSessionSelector(ownedSelector)
      ? ownedSelector
      : undefined;
    worker.activeLifecycleOwnerCommandId = ownerCommandId;
    worker.activeLifecycleFrontendOwner = frontendOwner;
    worker.activeLifecycleRecoveryProbeCommandId = undefined;
    worker.activeLifecycleRecoveryProbeEpoch = undefined;
    worker.lifecycleEpoch += 1;
    worker.activeLifecycleEpoch = worker.lifecycleEpoch;
    worker.legacyTurnSettled = false;
  }

  private clearLifecycleOwner(worker: WorkerHandle) {
    worker.activeLifecycleRequestTag = undefined;
    worker.activeLifecycleSelector = undefined;
    worker.activeLifecycleOwnerCommandId = undefined;
    worker.activeLifecycleFrontendOwner = false;
    worker.activeLifecycleRecoveryProbeCommandId = undefined;
    worker.activeLifecycleEpoch = undefined;
    worker.activeLifecycleRecoveryProbeEpoch = undefined;
  }

  private extendLifecycleOwnerSelector(
    worker: WorkerHandle,
    selector: SessionSelector,
  ) {
    const incomingSelector = sessionSelectorFromState(selector);
    if (!hasSessionSelector(incomingSelector)) return;
    const currentSelector = worker.activeLifecycleSelector;
    if (
      currentSelector &&
      !sessionMatchesSelector(incomingSelector, currentSelector)
    ) {
      return;
    }
    worker.activeLifecycleSelector = resolveSessionSelector(
      currentSelector,
      incomingSelector,
    );
  }

  private rpcTurnEventMatchesLifecycleOwner(
    worker: WorkerHandle,
    payload: any,
  ) {
    if (worker.activeLifecycleRequestTag === undefined) return false;
    const incomingRequestTag = lifecycleRequestTag(payload?.requestTag);
    if (
      incomingRequestTag === undefined ||
      incomingRequestTag !== worker.activeLifecycleRequestTag
    ) {
      return false;
    }
    if (
      worker.activeLifecycleSelector &&
      !sessionMatchesSelector(
        sessionSelectorFromState(payload),
        worker.activeLifecycleSelector,
      )
    ) {
      return false;
    }
    return true;
  }

  private supersedeLegacyTurnForVersionedProtocol(worker: WorkerHandle) {
    const pendingRecovery = this.getInterruptedTurnRecoveryIntent(worker);
    if (pendingRecovery) {
      this.interruptedTurnRecoveryIntents.delete(pendingRecovery.key);
    }
    this.rejectTerminalTurnWaiters(worker, new Error("rin_turn_superseded"));
    worker.turnRecoveryPending = false;
    worker.rpcTurnActive = false;
    worker.turnActive = false;
    worker.activeRequestTag = undefined;
    worker.activeTurnGeneration = undefined;
    worker.isStreaming = false;
    worker.legacyTurnActive = false;
    worker.legacyTurnSettled = true;
    this.syncRunningWorkerRecord(worker);
  }

  private acceptsRpcTurnEvent(worker: WorkerHandle, payload: any) {
    if (payload?.type !== "rpc_turn_event") return true;
    const event = String(payload.event || "");
    const isTerminal = event === "complete" || event === "error";
    const isLifecycle =
      event === "start" || event === "heartbeat" || isTerminal;
    if (!isLifecycle) return true;
    if (!this.rpcTurnEventMatchesLifecycleOwner(worker, payload)) return false;

    const hasGeneration = Object.prototype.hasOwnProperty.call(
      payload,
      "turnGeneration",
    );
    const generation = payload.turnGeneration;
    if (
      hasGeneration &&
      (typeof generation !== "number" ||
        !Number.isSafeInteger(generation) ||
        generation <= 0)
    ) {
      return false;
    }

    if (!hasGeneration) {
      if (worker.versionedLifecycleSeen) return false;
      if (event === "start") {
        if (worker.legacyTurnSettled) return false;
        worker.legacyTurnActive = true;
        return true;
      }
      if (event === "heartbeat") return worker.legacyTurnActive;
      if (
        !worker.legacyTurnActive &&
        !worker.turnRecoveryPending &&
        !worker.turnActive &&
        !worker.isStreaming
      ) {
        return false;
      }
      worker.legacyTurnActive = false;
      worker.legacyTurnSettled = true;
      return true;
    }

    if (event === "start") {
      if (generation < worker.lastTurnGeneration) return false;
      if (
        worker.activeTurnGeneration !== undefined &&
        generation !== worker.activeTurnGeneration
      ) {
        return false;
      }
      if (
        worker.activeTurnGeneration === undefined &&
        generation === worker.lastTurnGeneration
      ) {
        return false;
      }
      if (worker.legacyTurnActive) {
        this.supersedeLegacyTurnForVersionedProtocol(worker);
      }
      worker.versionedLifecycleSeen = true;
      if (generation > worker.lastTurnGeneration) {
        worker.lastTurnGeneration = generation;
        worker.activeTurnGeneration = generation;
      }
      return true;
    }

    if (worker.legacyTurnActive) return false;
    if (event === "heartbeat") {
      return (
        worker.versionedLifecycleSeen &&
        generation === worker.lastTurnGeneration &&
        worker.activeTurnGeneration === generation
      );
    }
    if (
      generation === worker.lastTurnGeneration &&
      worker.activeTurnGeneration === generation
    ) {
      worker.versionedLifecycleSeen = true;
      worker.activeTurnGeneration = undefined;
      return true;
    }
    if (
      generation > worker.lastTurnGeneration &&
      worker.activeTurnGeneration === undefined &&
      (worker.turnRecoveryPending || worker.turnActive || worker.isStreaming)
    ) {
      worker.versionedLifecycleSeen = true;
      worker.lastTurnGeneration = generation;
      return true;
    }
    return false;
  }

  private updateWorkerMetadata(worker: WorkerHandle, payload: any) {
    if (!payload || typeof payload !== "object") return false;
    if (!this.acceptsRpcTurnEvent(worker, payload)) return false;
    worker.lastUsedAt = Date.now();
    const pendingResponse = payload.id
      ? worker.pendingResponses.get(String(payload.id))
      : undefined;

    if (payload.type === "response" && payload.success === true) {
      const data = payload.data || {};
      if (
        typeof data.sessionFile === "string" ||
        typeof data.sessionId === "string"
      ) {
        this.setWorkerSessionRefs(worker, sessionSelectorFromState(data));
      }
      if (
        payload.command === "resume_interrupted_turn" &&
        data.resumed === false &&
        pendingResponse &&
        worker.activeLifecycleOwnerCommandId === pendingResponse.id
      ) {
        const selector = resolveSessionSelector(
          sessionSelectorFromState(data),
          resolveSessionSelector(
            pendingResponse.selector,
            this.getWorkerSelector(worker),
          ),
        );
        worker.turnRecoveryPending = false;
        worker.rpcTurnActive = false;
        worker.turnActive = false;
        worker.isStreaming = false;
        worker.frontendWorkingVisible = false;
        worker.restoredFrontendWorkingVisible = false;
        worker.frontendWorkingVisibilityEpoch += 1;
        worker.activeRequestTag = undefined;
        worker.activeTurnGeneration = undefined;
        worker.legacyTurnActive = false;
        this.clearLifecycleOwner(worker);
        this.syncRunningWorkerRecordForSelector(selector, false);
        this.maybeReleaseWorker(worker);
        return true;
      }
      if (payload.command === "get_state") {
        const reportedTurnActive = Boolean(data.turnActive ?? data.isStreaming);
        const hasLifecycleOwner =
          worker.activeLifecycleRequestTag !== undefined;
        const isMatchingRecoveryProbe = Boolean(
          pendingResponse &&
          worker.activeLifecycleEpoch !== undefined &&
          worker.activeLifecycleRecoveryProbeCommandId === pendingResponse.id &&
          worker.activeLifecycleRecoveryProbeEpoch ===
            worker.activeLifecycleEpoch,
        );
        const workingVisibilitySnapshotIsCurrent = Boolean(
          pendingResponse &&
          pendingResponse.workingVisibilityEpoch ===
            worker.frontendWorkingVisibilityEpoch,
        );
        const reportedSelector = sessionSelectorFromState(data);
        const reportedSelectorMatchesLifecycle = Boolean(
          hasSessionSelector(reportedSelector) &&
          (!worker.activeLifecycleSelector ||
            sessionMatchesSelector(
              reportedSelector,
              worker.activeLifecycleSelector,
            )),
        );
        const appliesReportedTurnState = Boolean(
          workingVisibilitySnapshotIsCurrent &&
          (!hasLifecycleOwner ||
            (isMatchingRecoveryProbe && reportedSelectorMatchesLifecycle)),
        );
        const reportedActiveTurnMatchesLifecycle = Boolean(
          reportedSelectorMatchesLifecycle &&
          (reportedTurnActive
            ? lifecycleRequestTag(data.requestTag) ===
                worker.activeLifecycleRequestTag &&
              worker.activeTurnGeneration !== undefined &&
              Number.isSafeInteger(Number(data.turnGeneration)) &&
              Number(data.turnGeneration) === worker.activeTurnGeneration
            : data.interruptedTurnResumable === true),
        );
        const appliesReportedWorkingVisibility = Boolean(
          workingVisibilitySnapshotIsCurrent && data.workingVisible !== true,
        );
        const eventWorkingVisibleIsOwned = Boolean(
          worker.frontendWorkingVisible &&
          !worker.restoredFrontendWorkingVisible &&
          hasLifecycleOwner &&
          worker.activeLifecycleFrontendOwner &&
          reportedActiveTurnMatchesLifecycle,
        );
        const restoredWorkingVisibleIsOwned = Boolean(
          worker.restoredFrontendWorkingVisible &&
          hasLifecycleOwner &&
          worker.activeLifecycleFrontendOwner &&
          reportedActiveTurnMatchesLifecycle,
        );
        if (!workingVisibilitySnapshotIsCurrent) {
          data.workingVisible = worker.frontendWorkingVisible;
        } else if (eventWorkingVisibleIsOwned) {
          data.workingVisible = true;
        } else if (restoredWorkingVisibleIsOwned) {
          data.workingVisible = true;
        } else if (
          worker.restoredFrontendWorkingVisible &&
          hasLifecycleOwner &&
          (!worker.activeLifecycleFrontendOwner ||
            !reportedActiveTurnMatchesLifecycle)
        ) {
          worker.frontendWorkingVisible = false;
          worker.restoredFrontendWorkingVisible = false;
          data.workingVisible = false;
        } else if (
          hasLifecycleOwner &&
          (!worker.activeLifecycleFrontendOwner ||
            !reportedActiveTurnMatchesLifecycle)
        ) {
          worker.frontendWorkingVisible = false;
          worker.restoredFrontendWorkingVisible = false;
          data.workingVisible = false;
        } else if (appliesReportedWorkingVisibility) {
          worker.frontendWorkingVisible = data.workingVisible === true;
          worker.restoredFrontendWorkingVisible = false;
        } else if (data.workingVisible === true) {
          worker.frontendWorkingVisible = false;
          worker.restoredFrontendWorkingVisible = false;
          data.workingVisible = false;
        }
        if (appliesReportedTurnState) {
          worker.turnActive = reportedTurnActive;
          worker.isStreaming = Boolean(data.isStreaming);
          worker.rinWorking = false;
        }
        const clearsLifecycleOwner = Boolean(
          workingVisibilitySnapshotIsCurrent &&
          !reportedTurnActive &&
          !isMatchingRecoveryProbe &&
          !hasLifecycleOwner,
        );
        if (clearsLifecycleOwner) {
          worker.turnRecoveryPending = false;
          if (workingVisibilitySnapshotIsCurrent) {
            worker.frontendWorkingVisible = false;
            worker.restoredFrontendWorkingVisible = false;
            worker.frontendWorkingVisibilityEpoch += 1;
            data.workingVisible = false;
          }
          worker.activeRequestTag = undefined;
          worker.activeTurnGeneration = undefined;
          this.clearLifecycleOwner(worker);
          worker.legacyTurnActive = false;
        } else if (isMatchingRecoveryProbe) {
          worker.activeLifecycleRecoveryProbeCommandId = undefined;
          worker.activeLifecycleRecoveryProbeEpoch = undefined;
        }
        worker.isCompacting = Boolean(data.isCompacting);
        this.maybeReleaseWorker(worker);
        return true;
      }
    }

    if (
      payload.type === "response" &&
      payload.success !== true &&
      TURN_RECOVERY_COMMAND_TYPES.has(String(payload.command || "")) &&
      pendingResponse &&
      worker.activeLifecycleOwnerCommandId === pendingResponse.id
    ) {
      worker.turnRecoveryPending = false;
      worker.frontendWorkingVisible = false;
      worker.restoredFrontendWorkingVisible = false;
      worker.frontendWorkingVisibilityEpoch += 1;
      worker.activeRequestTag = undefined;
      this.clearLifecycleOwner(worker);
      this.syncRunningWorkerRecordForSelector(
        resolveSessionSelector(
          sessionSelectorFromState(payload),
          resolveSessionSelector(
            pendingResponse.selector,
            this.getWorkerSelector(worker),
          ),
        ),
        false,
      );
    }

    if (
      payload.type === "extension_ui_request" &&
      payload.method === "setWorkingVisible"
    ) {
      worker.frontendWorkingVisible = payload.visible === true;
      worker.restoredFrontendWorkingVisible = false;
      worker.frontendWorkingVisibilityEpoch += 1;
      const pendingRecovery = this.getInterruptedTurnRecoveryIntent(worker);
      if (pendingRecovery) {
        if (payload.visible === true) {
          pendingRecovery.intent.workingVisible = true;
        } else {
          delete pendingRecovery.intent.workingVisible;
        }
      }
      this.syncRunningWorkerRecord(worker);
    }
    if (payload.type === "agent_start") {
      if (!worker.rpcTurnActive) worker.turnActive = true;
      worker.isStreaming = true;
      this.syncRunningWorkerRecord(worker);
    }
    if (payload.type === "agent_end") {
      worker.isStreaming = false;
      if (!worker.rpcTurnActive) worker.turnActive = false;
      this.syncRunningWorkerRecord(worker);
      this.maybeReleaseWorker(worker);
    }
    if (payload.type === "rin_working_start") {
      worker.rinWorking = true;
      this.syncRunningWorkerRecord(worker);
    }
    if (payload.type === "rin_working_end") {
      worker.rinWorking = false;
      this.syncRunningWorkerRecord(worker);
      this.maybeReleaseWorker(worker);
    }
    if (payload.type === "compaction_start") {
      worker.isCompacting = true;
      this.syncRunningWorkerRecord(worker);
    }
    if (payload.type === "compaction_end") {
      worker.isCompacting = false;
      this.syncRunningWorkerRecord(worker);
      this.maybeReleaseWorker(worker);
    }
    if (
      payload.type === "rpc_turn_event" &&
      (payload.event === "start" || payload.event === "heartbeat")
    ) {
      const selector = sessionSelectorFromState(payload);
      if (hasSessionSelector(selector)) {
        this.extendLifecycleOwnerSelector(worker, selector);
        this.setWorkerSessionRefs(worker, selector, {
          syncConnections: false,
          syncRunningWorkerRecord: false,
        });
      }
      worker.turnRecoveryPending = false;
      worker.rpcTurnActive = true;
      worker.turnActive = true;
      if (payload.event === "start") {
        const requestTag = lifecycleRequestTag(payload.requestTag);
        worker.activeRequestTag = requestTag || undefined;
      }
      this.syncRunningWorkerRecord(worker);
    }
    if (
      payload.type === "rpc_turn_event" &&
      (payload.event === "complete" || payload.event === "error")
    ) {
      const pendingRecovery = this.getInterruptedTurnRecoveryIntent(worker);
      if (pendingRecovery) {
        this.interruptedTurnRecoveryIntents.delete(pendingRecovery.key);
      }
      this.syncRunningWorkerRecordForSelector(
        sessionSelectorFromState(payload),
        false,
      );
      worker.turnRecoveryPending = false;
      worker.rpcTurnActive = false;
      worker.activeRequestTag = undefined;
      worker.activeTurnGeneration = undefined;
      this.clearLifecycleOwner(worker);
      worker.turnActive = false;
      worker.isStreaming = false;
      worker.frontendWorkingVisible = false;
      worker.restoredFrontendWorkingVisible = false;
      worker.frontendWorkingVisibilityEpoch += 1;
      this.syncRunningWorkerRecord(worker);
      this.maybeReleaseWorker(worker);
    }
    if (payload.type === "rpc_turn_event" && payload.event === "complete") {
      this.setWorkerSessionRefs(worker, sessionSelectorFromState(payload), {
        syncConnections: false,
      });
    }
    return true;
  }

  private writeWorkerResourceOptionsFile(
    resourceOptions: Record<string, unknown> | undefined,
  ) {
    if (!resourceOptions) return [];
    const root =
      this.options.resourceOptionsDir ||
      path.join(os.tmpdir(), "rin-worker-options");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const filePath = path.join(
      root,
      `worker-options-${process.pid}-${crypto.randomBytes(8).toString("hex")}.json`,
    );
    fs.writeFileSync(filePath, `${JSON.stringify(resourceOptions)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return ["--resource-options-file", filePath];
  }

  private resourceOptionsWithInitialSession(
    resourceOptions: Record<string, unknown> | undefined,
    initialSession: InitialWorkerSession,
  ) {
    return {
      ...(resourceOptions || this.options.resourceOptions || {}),
      __rinInitialSession: initialSession,
    };
  }

  private createWorkerForSession(
    selector: SessionSelector,
    requester?: ConnectionState,
  ) {
    if (!selector.sessionFile) throw new Error("rin_session_file_required");
    const worker = this.createWorker(
      requester,
      this.resourceOptionsWithInitialSession(requester?.resourceOptions, {
        kind: "open",
        sessionFile: selector.sessionFile,
      }),
    );
    this.setWorkerSessionRefs(worker, selector);
    return worker;
  }

  private createWorker(
    requester?: ConnectionState,
    resourceOptions?: Record<string, unknown>,
  ) {
    if (this.shuttingDown) {
      throw new Error("rin_daemon_shutting_down");
    }

    const workerResourceOptions =
      resourceOptions || this.options.resourceOptions;
    const workerArgs = [
      this.options.workerPath,
      ...this.writeWorkerResourceOptionsFile(workerResourceOptions),
    ];
    const workerId = `worker_${++this.workerSeq}`;
    const workerEnv = {
      ...process.env,
      [RIN_DAEMON_WORKER_OWNER_ENV]: os.userInfo().username,
    };
    delete workerEnv[WORKER_CGROUP_DELEGATION_ENV];
    const child = spawn(process.execPath, workerArgs, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnv,
      windowsHide: true,
    });
    let cgroupLease: WorkerCgroupLease | undefined;
    if (this.options.workerCgroupIsolation) {
      if (!child.pid) {
        child.kill("SIGKILL");
        throw new Error("Rin worker process id is unavailable");
      }
      try {
        cgroupLease = this.options.workerCgroupIsolation.attachWorker(
          workerId,
          child.pid,
        );
      } catch (error) {
        child.kill("SIGKILL");
        throw error;
      }
    }
    const worker: WorkerHandle = {
      id: workerId,
      child,
      cgroupLease,
      stdoutBuffer: { buffer: "" },
      stderrBuffer: { buffer: "" },
      connections: new Set(),
      pendingResponses: new Map(),
      ignoredResponseIds: new Set(),
      turnActive: false,
      rpcTurnActive: false,
      turnRecoveryPending: false,
      activeRequestTag: undefined,
      activeTurnGeneration: undefined,
      activeLifecycleRequestTag: undefined,
      activeLifecycleSelector: undefined,
      activeLifecycleOwnerCommandId: undefined,
      activeLifecycleFrontendOwner: false,
      activeLifecycleRecoveryProbeCommandId: undefined,
      lifecycleEpoch: 0,
      activeLifecycleEpoch: undefined,
      activeLifecycleRecoveryProbeEpoch: undefined,
      lastTurnGeneration: 0,
      versionedLifecycleSeen: false,
      legacyTurnActive: false,
      legacyTurnSettled: false,
      isStreaming: false,
      isCompacting: false,
      rinWorking: false,
      frontendWorkingVisible: false,
      restoredFrontendWorkingVisible: false,
      frontendWorkingVisibilityEpoch: 0,
      lastUsedAt: Date.now(),
      idleSince: null,
      gracefulShutdownRequested: false,
    };
    this.workers.add(worker);

    child.on("spawn", () => {
      this.options.onWorkerSpawn?.(requester, worker);
    });

    child.stdout.on("data", (chunk) => {
      parseJsonl(String(chunk), worker.stdoutBuffer, (line) => {
        let payload: any;
        try {
          payload = JSON.parse(line);
        } catch {
          for (const connection of worker.connections) {
            if (this.shouldForwardWorkerPayload(connection, worker, {})) {
              connection.socket.write(`${line}\n`);
            }
          }
          return;
        }

        if (
          payload?.type === "response" &&
          payload.id &&
          worker.ignoredResponseIds.delete(String(payload.id))
        ) {
          return;
        }

        if (!this.updateWorkerMetadata(worker, payload)) return;

        if (
          payload?.type === "response" &&
          payload.id &&
          worker.pendingResponses.has(String(payload.id))
        ) {
          const pending = worker.pendingResponses.get(String(payload.id))!;
          worker.pendingResponses.delete(String(payload.id));
          const keepTurnRecoveryRecord =
            payload.success === true &&
            pending.expectsTerminalTurnEvent === true &&
            !(
              payload.command === "resume_interrupted_turn" &&
              payload.data?.resumed === false
            );
          if (!keepTurnRecoveryRecord) this.syncRunningWorkerRecord(worker);
          if (pending.connection) {
            this.rememberSessionSelection(
              pending.connection,
              this.getWorkerSelector(worker),
            );
          }
          pending.finalize?.();
          if (pending.resolve) pending.resolve(payload);
          if (pending.connection) writeLine(pending.connection.socket, payload);
          this.maybeReleaseWorker(worker);
          return;
        }

        const terminalTurnEvent = isTerminalRpcTurnEvent(payload);
        let forwarded = 0;
        for (const connection of worker.connections) {
          if (this.shouldForwardWorkerPayload(connection, worker, payload)) {
            writeLine(connection.socket, payload);
            if (terminalTurnEvent && payload?.terminalWal?.payloadHash) {
              const staged = listStagedChatTerminalWal(
                String(this.options.agentDir || "").trim(),
                sessionSelectorFromState(payload),
              ).find(
                (record) =>
                  record.payloadHash ===
                  String(payload.terminalWal.payloadHash),
              );
              if (staged) {
                this.scheduleStagedChatTerminalRedelivery(connection, staged);
              }
            }
            forwarded += 1;
          }
        }
        if (terminalTurnEvent) {
          this.resolveTerminalTurnWaiters(worker, payload);
          if (payload.chatRunContext) {
            // Canonical Chat terminal ownership lives in the producer WAL until
            // the Chat DB commits terminal + outbox. Socket forwarding is only
            // a wake-up signal and must not clear or duplicate that evidence.
          } else if (forwarded === 0) {
            rememberPendingTerminalTurnEvent(this.options.agentDir, payload);
          } else {
            clearPendingTerminalTurnEvent(this.options.agentDir, payload);
          }
        }
      });
    });

    child.stderr.on("data", (chunk) => {
      parseJsonl(String(chunk), worker.stderrBuffer, (line) => {
        for (const connection of worker.connections) {
          if (this.shouldForwardWorkerPayload(connection, worker, {})) {
            writeLine(connection.socket, { type: "stderr", line });
          }
        }
      });
    });

    child.stdin.on("error", (error) => {
      this.handleWorkerStdinFailure(worker, error);
    });

    child.on("exit", async (code, signal) => {
      const liveConnections = new Set<ConnectionState>(worker.connections);
      for (const pending of worker.pendingResponses.values()) {
        pending.finalize?.();
        if (pending.connection) liveConnections.add(pending.connection);
      }
      const selector = this.getWorkerSelector(worker);
      const recoveryEligible = this.shouldRecoverWorker(
        worker,
        liveConnections,
      );
      const oomKilled = worker.cgroupLease?.wasOomKilled() === true;
      this.deleteWorkerSessionRefs(worker);
      this.workers.delete(worker);
      for (const connection of Array.from(worker.connections)) {
        if (connection.attachedWorker === worker) {
          connection.attachedWorker = undefined;
        }
      }
      worker.connections.clear();
      const pending = Array.from(worker.pendingResponses.values());
      worker.pendingResponses.clear();
      worker.ignoredResponseIds.clear();

      let cleanupComplete = true;
      try {
        cleanupComplete = worker.cgroupLease
          ? await worker.cgroupLease.cleanup()
          : true;
      } catch {
        cleanupComplete = false;
      }
      const shouldRecover = cleanupComplete && recoveryEligible;
      const exitError = !cleanupComplete
        ? "rin_worker_cleanup_failed"
        : oomKilled
          ? "rin_worker_oom"
          : "rin_worker_exit";
      this.rejectTerminalTurnWaiters(
        worker,
        new Error(shouldRecover ? "rin_session_recovering" : exitError),
      );
      if (oomKilled) {
        for (const connection of liveConnections) {
          writeLine(connection.socket, {
            type: "worker_oom",
            code: code ?? null,
            signal: signal ?? null,
          });
        }
      }
      if (shouldRecover) {
        this.recoverWorker(
          selector,
          worker,
          liveConnections,
          pending,
          oomKilled ? "worker-oom" : "worker-exit",
        );
        return;
      }
      if (!oomKilled) {
        for (const connection of liveConnections) {
          writeLine(connection.socket, {
            type: "worker_exit",
            code: code ?? null,
            signal: signal ?? null,
          });
        }
      }
      for (const entry of pending) {
        if (entry.reject) {
          entry.reject(new Error(exitError));
          continue;
        }
        if (entry.connection) {
          writeLine(
            entry.connection.socket,
            responseError(entry.id, entry.commandType, exitError),
          );
        }
      }
    });

    return worker;
  }

  private shouldForwardWorkerPayload(
    connection: ConnectionState,
    worker: WorkerHandle,
    payload: any,
  ) {
    if (connection.socket.destroyed) return false;
    const connectionSelector = this.getConnectionSelector(connection);
    const payloadSelector = sessionSelectorFromState(payload);
    const expectedSelector = hasSessionSelector(payloadSelector)
      ? payloadSelector
      : this.getWorkerSelector(worker);
    if (!hasSessionSelector(expectedSelector)) return true;
    if (!hasSessionSelector(connectionSelector)) {
      return connection.attachedWorker === worker;
    }
    return sessionMatchesSelector(expectedSelector, connectionSelector);
  }

  private attachWorker(connection: ConnectionState, worker: WorkerHandle) {
    if (connection.attachedWorker === worker) return;
    this.detachWorker(connection);
    connection.attachedWorker = worker;
    worker.connections.add(connection);
    worker.lastUsedAt = Date.now();
    worker.idleSince = null;
    const selector = this.getWorkerSelector(worker);
    this.rememberSessionSelection(connection, selector);
  }

  replayPendingTerminalTurnEvent(
    connection: ConnectionState,
    selector: SessionSelector = {},
  ) {
    if (connection.socket.destroyed) return false;
    const effectiveSelector = hasSessionSelector(selector)
      ? selector
      : this.getConnectionSelector(connection);
    if (!hasSessionSelector(effectiveSelector)) return false;
    const stagedChatTerminals = listStagedChatTerminalWal(
      String(this.options.agentDir || "").trim(),
      effectiveSelector,
    );
    for (const record of stagedChatTerminals) {
      this.deliverStagedChatTerminal(connection, record);
    }
    if (stagedChatTerminals.length > 0) return true;
    const pendingTerminalEvent = takePendingTerminalTurnEvent(
      this.options.agentDir,
      effectiveSelector,
    );
    if (!pendingTerminalEvent) return false;
    writeLine(connection.socket, pendingTerminalEvent);
    return true;
  }

  private deliverStagedChatTerminal(
    connection: ConnectionState,
    record: StagedChatTerminal,
  ) {
    writeLine(connection.socket, {
      type: "rpc_turn_event",
      ...record.terminalPayload,
      chatRunContext: {
        runId: record.runId,
        ownerEpoch: record.ownerEpoch,
        producerIncarnation: record.producerIncarnation,
      },
      terminalWal: {
        payloadHash: record.payloadHash,
        stagedAt: record.stagedAt,
      },
    });
    this.scheduleStagedChatTerminalRedelivery(connection, record);
  }

  private scheduleStagedChatTerminalRedelivery(
    connection: ConnectionState,
    record: StagedChatTerminal,
  ) {
    let connectionRedeliveries = this.terminalRedeliveries.get(connection);
    if (!connectionRedeliveries) {
      connectionRedeliveries = new Map();
      this.terminalRedeliveries.set(connection, connectionRedeliveries);
    }
    if (connectionRedeliveries.has(record.payloadHash)) return;

    const stop = () => {
      const current = this.terminalRedeliveries.get(connection);
      const redelivery = current?.get(record.payloadHash);
      if (redelivery) clearTimeout(redelivery.timer);
      current?.delete(record.payloadHash);
      if (current?.size === 0) this.terminalRedeliveries.delete(connection);
    };
    const retry = () => {
      if (this.shuttingDown || connection.socket.destroyed) {
        stop();
        return;
      }
      const pending = listStagedChatTerminalWal(
        String(this.options.agentDir || "").trim(),
        {
          sessionFile: String(record.terminalPayload.sessionFile || ""),
          sessionId: String(record.terminalPayload.sessionId || ""),
        },
      ).find((candidate) => candidate.payloadHash === record.payloadHash);
      if (!pending) {
        stop();
        return;
      }
      writeLine(connection.socket, {
        type: "rpc_turn_event",
        ...pending.terminalPayload,
        chatRunContext: {
          runId: pending.runId,
          ownerEpoch: pending.ownerEpoch,
          producerIncarnation: pending.producerIncarnation,
        },
        terminalWal: {
          payloadHash: pending.payloadHash,
          stagedAt: pending.stagedAt,
        },
      });
      const timer = setTimeout(retry, this.terminalRedeliveryMs);
      timer.unref?.();
      connectionRedeliveries?.set(record.payloadHash, {
        payloadHash: record.payloadHash,
        timer,
      });
    };

    const timer = setTimeout(retry, this.terminalRedeliveryMs);
    timer.unref?.();
    connectionRedeliveries.set(record.payloadHash, {
      payloadHash: record.payloadHash,
      timer,
    });
  }

  private maybeReleaseWorker(worker: WorkerHandle) {
    if (!this.workers.has(worker)) return;
    if (worker.gracefulShutdownRequested) return;
    if (
      worker.pendingResponses.size > 0 ||
      worker.turnActive ||
      worker.turnRecoveryPending ||
      worker.isStreaming ||
      worker.isCompacting ||
      worker.rinWorking
    ) {
      worker.idleSince = null;
      return;
    }
    const pendingRecovery = this.getInterruptedTurnRecoveryIntent(worker);
    if (pendingRecovery) {
      void this.runInterruptedTurnRecoveryIntent(
        pendingRecovery.key,
        pendingRecovery.intent,
      );
      return;
    }
    if (this.shuttingDown || this.gcIdleMs === 0) {
      this.destroyWorker(worker);
      return;
    }
    worker.idleSince ??= Date.now();
    if (Date.now() - worker.idleSince < this.gcIdleMs) return;
    this.detachWorkerConnections(worker);
    this.sleepWorkerGracefully(worker);
  }

  private detachWorkerConnections(worker: WorkerHandle) {
    for (const connection of Array.from(worker.connections)) {
      if (connection.attachedWorker === worker) {
        connection.attachedWorker = undefined;
      }
      worker.connections.delete(connection);
    }
  }

  private getSessionSelector(command: any): SessionSelector {
    return sessionSelectorFromCommand(command);
  }

  private getConnectionSelector(connection: ConnectionState): SessionSelector {
    return sessionSelectorFromState(connection);
  }

  private getWorkerSelector(worker: WorkerHandle): SessionSelector {
    return sessionSelectorFromState(worker);
  }

  private resolveSelector(
    connection: ConnectionState,
    command: any,
  ): SessionSelector {
    return resolveSessionSelector(
      this.getSessionSelector(command),
      this.getConnectionSelector(connection),
    );
  }

  private rememberSessionSelection(
    connection: ConnectionState,
    selector: SessionSelector,
  ) {
    const next = sessionSelectorFromState(selector);
    connection.sessionFile = next.sessionFile;
    connection.sessionId = next.sessionId;
  }

  private async ensureWorkerForSession(selector: SessionSelector) {
    const wanted = sessionSelectorFromState(selector);
    const existing = this.findWorkerBySelector(wanted);
    if (existing) return existing;
    if (!wanted.sessionFile) throw new Error("rin_session_file_required");

    const claimed = await this.withSessionClaim(wanted, async () => {
      const existing = this.findWorkerBySelector(wanted);
      if (existing) return existing;
      return this.createWorkerForSession(wanted);
    });
    if (!claimed) throw new Error("rin_session_worker_unavailable");
    return claimed;
  }

  private waitForTerminalTurnEvent(
    worker: WorkerHandle,
    selector: SessionSelector,
    requestTag?: string,
  ) {
    let waiter!: TerminalTurnWaiter;
    const promise = new Promise<any>((resolve, reject) => {
      waiter = {
        worker,
        selector,
        requestTag,
        resolve,
        reject,
      };
      this.terminalTurnWaiters.add(waiter);
    });
    return { promise, waiter };
  }

  private resolveTerminalTurnWaiters(worker: WorkerHandle, payload: any) {
    for (const waiter of Array.from(this.terminalTurnWaiters)) {
      if (waiter.worker !== worker) continue;
      if (
        waiter.requestTag !== undefined &&
        lifecycleRequestTag(payload?.requestTag) !== waiter.requestTag
      ) {
        continue;
      }
      const payloadSelector = sessionSelectorFromState(payload);
      if (
        hasSessionSelector(payloadSelector) &&
        !sessionMatchesSelector(payloadSelector, waiter.selector)
      ) {
        continue;
      }
      this.terminalTurnWaiters.delete(waiter);
      waiter.resolve(payload);
    }
  }

  private rejectTerminalTurnWaiters(worker: WorkerHandle, error: Error) {
    for (const waiter of Array.from(this.terminalTurnWaiters)) {
      if (waiter.worker !== worker) continue;
      this.terminalTurnWaiters.delete(waiter);
      waiter.reject(error);
    }
  }

  private findWorkerBySelector(selector: SessionSelector) {
    if (selector.sessionFile) {
      const worker = this.workersBySessionFile.get(selector.sessionFile);
      if (worker && this.isWorkerRoutable(worker)) return worker;
    }
    if (selector.sessionId) {
      const worker = this.workersBySessionId.get(selector.sessionId);
      if (worker && this.isWorkerRoutable(worker)) return worker;
    }
    return undefined;
  }

  private isWorkerRoutable(worker: WorkerHandle) {
    return this.workers.has(worker) && !worker.gracefulShutdownRequested;
  }

  private sessionClaimKey(selector: SessionSelector) {
    const normalized = sessionSelectorFromState(selector);
    if (normalized.sessionFile) return `file:${normalized.sessionFile}`;
    if (normalized.sessionId) return `id:${normalized.sessionId}`;
    return undefined;
  }

  private async withSessionClaim(
    selector: SessionSelector,
    claim: () => Promise<WorkerHandle | undefined>,
  ) {
    const key = this.sessionClaimKey(selector);
    if (!key) return await claim();
    const existingClaim = this.pendingSessionClaims.get(key);
    if (existingClaim) return await existingClaim;
    const promise = claim();
    this.pendingSessionClaims.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.pendingSessionClaims.get(key) === promise) {
        this.pendingSessionClaims.delete(key);
      }
    }
  }

  private workerMatchesSelector(
    worker: WorkerHandle,
    selector: SessionSelector,
  ) {
    return sessionMatchesSelector(this.getWorkerSelector(worker), selector);
  }

  private deleteWorkerSessionRefs(worker: WorkerHandle) {
    if (
      worker.sessionFile &&
      this.workersBySessionFile.get(worker.sessionFile) === worker
    ) {
      this.workersBySessionFile.delete(worker.sessionFile);
    }
    if (
      worker.sessionId &&
      this.workersBySessionId.get(worker.sessionId) === worker
    ) {
      this.workersBySessionId.delete(worker.sessionId);
    }
    worker.sessionFile = undefined;
    worker.sessionId = undefined;
  }

  private setWorkerSessionRefs(
    worker: WorkerHandle,
    next: SessionSelector,
    options: {
      syncConnections?: boolean;
      syncRunningWorkerRecord?: boolean;
    } = {},
  ) {
    const selector = sessionSelectorFromState(next);
    if (
      worker.sessionFile &&
      this.workersBySessionFile.get(worker.sessionFile) === worker &&
      worker.sessionFile !== selector.sessionFile
    ) {
      this.workersBySessionFile.delete(worker.sessionFile);
    }
    if (
      worker.sessionId &&
      this.workersBySessionId.get(worker.sessionId) === worker &&
      worker.sessionId !== selector.sessionId
    ) {
      this.workersBySessionId.delete(worker.sessionId);
    }
    worker.sessionFile = selector.sessionFile;
    worker.sessionId = selector.sessionId;
    if (options.syncRunningWorkerRecord !== false) {
      this.syncRunningWorkerRecord(worker);
    }
    if (worker.sessionFile) {
      this.workersBySessionFile.set(worker.sessionFile, worker);
    }
    if (worker.sessionId) this.workersBySessionId.set(worker.sessionId, worker);
    if (options.syncConnections === false) return;
    for (const connection of worker.connections) {
      this.rememberSessionSelection(connection, selector);
    }
  }

  private isWorkerRunning(worker: WorkerHandle) {
    return Boolean(
      worker.turnActive ||
      worker.turnRecoveryPending ||
      worker.isStreaming ||
      worker.isCompacting ||
      worker.rinWorking ||
      Array.from(worker.pendingResponses.values()).some((pending) =>
        RESUMABLE_COMMAND_TYPES.has(pending.commandType),
      ),
    );
  }

  private syncRunningWorkerRecordForSelector(
    selector: SessionSelector | undefined,
    running: boolean,
    requestTag?: string,
    frontendOwner = false,
    workingVisible = false,
  ) {
    const sessionFile = sessionSelectorFromState(selector).sessionFile;
    if (!sessionFile) return;
    setRunningWorkerSession(
      this.options.agentDir,
      sessionFile,
      running,
      requestTag,
      frontendOwner,
      workingVisible,
    );
  }

  private syncRunningWorkerRecord(worker: WorkerHandle) {
    const sessionFile = this.getWorkerSelector(worker).sessionFile;
    if (!sessionFile) return;
    setRunningWorkerSession(
      this.options.agentDir,
      sessionFile,
      this.isWorkerRunning(worker),
      worker.activeLifecycleRequestTag ?? worker.activeRequestTag,
      worker.activeLifecycleFrontendOwner,
      worker.frontendWorkingVisible,
    );
  }

  private clearRunningWorkerRecord(worker: WorkerHandle) {
    const sessionFile = this.getWorkerSelector(worker).sessionFile;
    if (!sessionFile) return;
    setRunningWorkerSession(this.options.agentDir, sessionFile, false);
  }

  private shouldRecoverWorker(
    worker: WorkerHandle,
    liveConnections: Set<ConnectionState>,
  ) {
    if (this.shuttingDown || worker.gracefulShutdownRequested) return false;
    return Boolean(
      this.getWorkerSelector(worker).sessionFile && liveConnections.size > 0,
    );
  }

  private recoverWorker(
    selector: SessionSelector,
    worker: WorkerHandle,
    liveConnections: Set<ConnectionState>,
    pending: PendingResponse[],
    source = "worker-exit",
  ) {
    const resumeTurn = hasResumableWorkerActivity(worker);
    const recoveryRequestTag = worker.activeLifecycleRequestTag;
    const recoveryFrontendOwner = Boolean(
      recoveryRequestTag !== undefined && worker.activeLifecycleFrontendOwner,
    );
    const recoveryWorkingVisible = Boolean(
      worker.frontendWorkingVisible && recoveryFrontendOwner,
    );
    for (const connection of liveConnections) {
      this.rememberSessionSelection(connection, selector);
      writeLine(connection.socket, {
        type: "session_recovering",
        sessionFile: selector.sessionFile,
        sessionId: selector.sessionId,
        resumeTurn,
      });
    }
    for (const entry of pending) {
      entry.finalize?.();
      if (entry.reject) {
        entry.reject(new Error("rin_session_recovering"));
        continue;
      }
      if (entry.connection) {
        writeLine(
          entry.connection.socket,
          responseError(entry.id, entry.commandType, "rin_session_recovering"),
        );
      }
    }
    const sessionFile = selector.sessionFile;
    if (!sessionFile) return;

    void this.withSessionClaim(selector, async () => {
      const existing = this.findWorkerBySelector(selector);
      if (existing) return existing;
      return this.createWorkerForSession({ ...selector, sessionFile });
    })
      .then(async (recovered) => {
        if (!recovered) return;
        for (const connection of liveConnections) {
          this.attachWorker(connection, recovered);
        }
        if (resumeTurn && !this.isWorkerRunning(recovered)) {
          if (recoveryWorkingVisible) {
            await this.continueInterruptedTurnSessionWorker({
              sessionFile,
              source,
              ...(recoveryRequestTag !== undefined
                ? { requestTag: recoveryRequestTag }
                : {}),
              frontendOwner: recoveryFrontendOwner,
              ...(recovered.frontendWorkingVisibilityEpoch === 0 ||
              recovered.frontendWorkingVisible
                ? { workingVisible: true as const }
                : {}),
            });
          } else {
            await this.sendInternalCommand(
              recovered,
              {
                type: "resume_interrupted_turn",
                source,
                ...(recoveryRequestTag !== undefined
                  ? { requestTag: recoveryRequestTag }
                  : {}),
              },
              { frontendOwner: recoveryFrontendOwner },
            );
          }
        }
        for (const connection of liveConnections) {
          writeLine(connection.socket, {
            type: "session_recovered",
            sessionFile,
            sessionId: selector.sessionId,
            resumed: resumeTurn,
          });
        }
      })
      .catch(() => {});
  }

  private getInternalCommandTimeoutMs(command: any) {
    const commandType = String(command?.type || "unknown");
    if (commandType === "switch_session") {
      return this.switchSessionCommandTimeoutMs;
    }
    return this.internalCommandTimeoutMs;
  }

  private isWorkerStdinWritable(worker: WorkerHandle) {
    const stdin = worker.child.stdin;
    return (
      this.workers.has(worker) &&
      worker.child.exitCode === null &&
      worker.child.signalCode === null &&
      !stdin.destroyed &&
      !stdin.writableEnded &&
      !stdin.writableFinished &&
      stdin.writable !== false
    );
  }

  private writeWorkerStdin(
    worker: WorkerHandle,
    command: unknown,
    onError: (error: Error) => void,
  ) {
    if (!this.isWorkerStdinWritable(worker)) {
      onError(new Error("rin_worker_stdin_unavailable"));
      return false;
    }
    try {
      worker.child.stdin.write(
        `${JSON.stringify(command)}\n`,
        (error?: Error | null) => {
          if (error) onError(error);
        },
      );
      return true;
    } catch (error: any) {
      onError(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private async writeWorkerStdinAndWait(
    worker: WorkerHandle,
    command: unknown,
  ) {
    if (!this.isWorkerStdinWritable(worker)) {
      this.handleWorkerStdinFailure(
        worker,
        new Error("rin_worker_stdin_unavailable"),
      );
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      try {
        worker.child.stdin.write(
          `${JSON.stringify(command)}\n`,
          (error?: Error | null) => {
            if (error) {
              this.handleWorkerStdinFailure(worker, error);
              resolve(false);
            } else {
              resolve(true);
            }
          },
        );
      } catch (error: any) {
        this.handleWorkerStdinFailure(
          worker,
          error instanceof Error ? error : new Error(String(error)),
        );
        resolve(false);
      }
    });
  }

  private handleWorkerStdinFailure(worker: WorkerHandle, error: Error) {
    if (!this.workers.has(worker)) return;
    for (const pending of Array.from(worker.pendingResponses.values())) {
      if (TURN_RECOVERY_COMMAND_TYPES.has(pending.commandType)) {
        worker.turnRecoveryPending = false;
        this.syncRunningWorkerRecordForSelector(
          resolveSessionSelector(
            pending.selector,
            this.getWorkerSelector(worker),
          ),
          false,
        );
      }
      pending.finalize?.();
      if (pending.reject) {
        pending.reject(error);
      } else if (pending.connection) {
        writeLine(
          pending.connection.socket,
          responseError(pending.id, pending.commandType, "rin_worker_exit"),
        );
      }
    }
    worker.pendingResponses.clear();
    worker.ignoredResponseIds.clear();
    this.destroyWorker(worker);
  }

  private rejectInternalCommandWrite(
    worker: WorkerHandle,
    id: string,
    finalize: () => void,
    reject: (error: Error) => void,
    error: unknown,
  ) {
    const pending = worker.pendingResponses.get(id);
    if (pending && TURN_RECOVERY_COMMAND_TYPES.has(pending.commandType)) {
      worker.turnRecoveryPending = false;
      this.syncRunningWorkerRecordForSelector(
        resolveSessionSelector(
          pending.selector,
          this.getWorkerSelector(worker),
        ),
        false,
      );
    }
    worker.pendingResponses.delete(id);
    worker.ignoredResponseIds.add(id);
    finalize();
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    reject(normalized);
    this.destroyWorker(worker);
  }

  private sendInternalCommand(
    worker: WorkerHandle,
    command: any,
    options: {
      lifecycleRecoveryProbe?: boolean;
      frontendOwner?: boolean;
    } = {},
  ) {
    const id = `rin_internal_${++this.internalRequestSeq}`;
    const commandType = String(command?.type || "unknown");
    const selector = resolveSessionSelector(
      this.getSessionSelector(command),
      this.getWorkerSelector(worker),
    );
    const keepUntilTerminalTurnEvent = expectsTerminalTurnEvent(
      commandType,
      command,
    );
    let resolveCommand!: (value: any) => void;
    let rejectCommand!: (error: Error) => void;
    const pendingCommand = new Promise<any>((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    });
    pendingCommand.catch(() => {});

    const timeout = setTimeout(() => {
      const pending = worker.pendingResponses.get(id);
      worker.pendingResponses.delete(id);
      worker.ignoredResponseIds.add(id);
      if (!pending || pending.expectsTerminalTurnEvent !== true) {
        this.syncRunningWorkerRecord(worker);
      }
      this.maybeReleaseWorker(worker);
      rejectCommand(new Error(`rin_internal_timeout:${commandType}`));
    }, this.getInternalCommandTimeoutMs(command));
    timeout.unref?.();

    const finalize = () => clearTimeout(timeout);
    worker.pendingResponses.set(id, {
      id,
      commandType,
      selector,
      expectsTerminalTurnEvent: keepUntilTerminalTurnEvent,
      workingVisibilityEpoch: worker.frontendWorkingVisibilityEpoch,
      resolve: resolveCommand,
      reject: rejectCommand,
      finalize,
    });
    if (
      options.lifecycleRecoveryProbe === true &&
      worker.activeLifecycleRequestTag !== undefined
    ) {
      worker.activeLifecycleRecoveryProbeCommandId = id;
      worker.activeLifecycleRecoveryProbeEpoch = worker.activeLifecycleEpoch;
    }
    if (TURN_RECOVERY_COMMAND_TYPES.has(commandType)) {
      const requestTag = lifecycleRequestTag(command?.requestTag);
      if (keepUntilTerminalTurnEvent && requestTag !== undefined) {
        worker.turnRecoveryPending = true;
        if (worker.activeLifecycleRequestTag === undefined) {
          this.setLifecycleOwner(
            worker,
            requestTag,
            selector,
            id,
            options.frontendOwner === true,
          );
        } else if (
          worker.activeLifecycleOwnerCommandId === undefined &&
          worker.activeLifecycleRequestTag === requestTag
        ) {
          const commandSelector = resolveSessionSelector(
            this.getWorkerSelector(worker),
            selector,
          );
          if (
            !worker.activeLifecycleSelector ||
            sessionMatchesSelector(
              commandSelector,
              worker.activeLifecycleSelector,
            )
          ) {
            worker.activeLifecycleOwnerCommandId = id;
          }
        }
        if (requestTag) worker.activeRequestTag = requestTag;
      }
      this.syncRunningWorkerRecordForSelector(
        selector,
        true,
        worker.activeLifecycleRequestTag ?? worker.activeRequestTag,
        worker.activeLifecycleFrontendOwner,
        worker.frontendWorkingVisible,
      );
    }

    if (!this.isWorkerStdinWritable(worker)) {
      this.rejectInternalCommandWrite(
        worker,
        id,
        finalize,
        rejectCommand,
        new Error(`rin_worker_stdin_unavailable:${commandType}`),
      );
      return pendingCommand;
    }

    this.writeWorkerStdin(worker, { ...command, id }, (error) => {
      this.rejectInternalCommandWrite(
        worker,
        id,
        finalize,
        rejectCommand,
        error.message === "rin_worker_stdin_unavailable"
          ? new Error(`rin_worker_stdin_unavailable:${commandType}`)
          : error,
      );
    });
    return pendingCommand;
  }
}
