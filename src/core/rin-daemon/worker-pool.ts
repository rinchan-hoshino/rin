import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RpcSocketLike } from "../platform/rpc-socket.js";
import {
  beginDaemonTurn,
  daemonTurnTerminalEvent,
  interruptDaemonTurn,
  listActiveDaemonTurns,
  readDaemonTurn,
  recordDaemonTurnTerminal,
  type DaemonTurnInvocationContext,
} from "./turn-ledger.js";
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
  inputSubmission?: {
    requestTag: string;
    chatDeliveryContext?: {
      turnId: string;
      chatKey: string;
      messageId: string;
    };
    invocationContext?: DaemonTurnInvocationContext;
  };
  stateEpoch: number;
  connection?: ConnectionState;
  resolve?: (payload: any) => void;
  reject?: (error: Error) => void;
  finalize?: () => void;
};

type TerminalTurnWaiter = {
  connection?: ConnectionState;
  requestTag: string;
  resolve: (payload: any) => void;
  reject: (error: Error) => void;
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
  terminalPending: boolean;
  activeRequestTag?: string;
  activeTurnGeneration?: number;
  activeLifecycleRequestTag?: string;
  activeLifecycleSelector?: SessionSelector;
  activeLifecycleOwnerCommandId?: string;
  activeLifecycleFrontendOwner: boolean;
  activeLifecycleRecoveryProbeCommandId?: string;
  lifecycleEpoch: number;
  stateEpoch: number;
  activeLifecycleEpoch?: number;
  activeLifecycleRecoveryProbeEpoch?: number;
  lastTurnGeneration: number;
  isStreaming: boolean;
  isCompacting: boolean;
  publishedWorking: boolean;
  lastUsedAt: number;
  idleSince: number | null;
  gracefulShutdownRequested: boolean;
  recoveryStopRequested: boolean;
  recoveryStopTimer?: NodeJS.Timeout;
};

function writeLine(socket: RpcSocketLike, payload: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
}

function responseSuccess(
  commandId: string,
  commandType: string,
  data: Record<string, unknown>,
) {
  return {
    id: commandId,
    type: "response",
    command: commandType,
    success: true,
    data,
  };
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

const ACTIVE_COMMAND_TYPES = new Set([
  "prompt",
  "compact",
  "send_user_message",
  "run_command",
]);

const TURN_TERMINAL_COMMAND_TYPES = new Set(["prompt", "send_user_message"]);

function lifecycleRequestTag(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function turnInvocationContext(command: any): DaemonTurnInvocationContext {
  return {
    source: command?.source,
    frontendIdentity: command?.frontendIdentity,
    promptContext: command?.promptContext,
  };
}

function nativeInputOutcome(data: any) {
  const outcome = typeof data?.outcome === "string" ? data.outcome.trim() : "";
  if (
    ![
      "terminalOwner",
      "nonterminal",
      "rejected",
      "indeterminate",
      "rejoined",
    ].includes(outcome)
  ) {
    return undefined;
  }
  const originalOutcome = [
    "terminalOwner",
    "nonterminal",
    "rejected",
    "indeterminate",
  ].includes(data?.originalOutcome)
    ? data.originalOutcome
    : undefined;
  if (outcome === "rejoined" && !originalOutcome) return undefined;
  return { outcome, originalOutcome } as const;
}

function expectsTerminalTurnEvent(commandType: string, command: any) {
  const requestTag = lifecycleRequestTag(command?.requestTag);
  return requestTag !== undefined && requestTag.length > 0;
}

export class WorkerPool {
  private workers = new Set<WorkerHandle>();
  private workersBySessionFile = new Map<string, WorkerHandle>();
  private workersBySessionId = new Map<string, WorkerHandle>();
  private pendingSessionClaims = new Map<
    string,
    Promise<WorkerHandle | undefined>
  >();
  private terminalTurnWaiters = new Set<TerminalTurnWaiter>();
  private activeTurnRecoveryScanTimer?: NodeJS.Timeout;
  private activeTurnRecoveryTimers = new Map<string, NodeJS.Timeout>();
  private activeTurnRecoveryAttempts = new Map<string, number>();
  private activeTurnRecoveryInFlight = new Map<string, Promise<boolean>>();
  private workerSeq = 0;
  private internalRequestSeq = 0;
  private shuttingDown = false;
  private readonly gcIdleMs: number;
  private readonly internalCommandTimeoutMs: number;
  private readonly switchSessionCommandTimeoutMs: number;
  private readonly frontendConnections = new Set<ConnectionState>();
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
    const sweepIntervalMs = Math.max(
      250,
      Number(options.sweepIntervalMs ?? Math.min(this.gcIdleMs || 250, 5_000)),
    );
    this.reaper = setInterval(() => {
      this.evictDetachedWorkers();
    }, sweepIntervalMs);
    this.reaper.unref?.();
  }

  registerConnection(connection: ConnectionState) {
    this.frontendConnections.add(connection);
  }

  unregisterConnection(connection: ConnectionState) {
    this.frontendConnections.delete(connection);
    for (const waiter of Array.from(this.terminalTurnWaiters)) {
      if (waiter.connection !== connection) continue;
      this.terminalTurnWaiters.delete(waiter);
      waiter.reject(new Error("Frontend connection closed"));
    }
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
    if (!this.workers.has(worker)) return true;
    if (
      lifecycleRequestTag(
        worker.activeLifecycleRequestTag || worker.activeRequestTag,
      )
    ) {
      this.stopWorkerForRecovery(worker);
      return false;
    }
    worker.gracefulShutdownRequested = true;
    this.workers.delete(worker);
    if (!this.shuttingDown || !this.isWorkerRunning(worker)) {
      this.clearRunningWorkerRecord(worker);
    }
    const workerExitConnections = Array.from(
      this.getWorkerEventConnections(worker),
    ).filter((connection) =>
      this.shouldForwardWorkerPayload(connection, worker, {}),
    );
    this.deleteWorkerSessionRefs(worker);
    for (const connection of Array.from(worker.connections)) {
      if (connection.attachedWorker === worker) {
        connection.attachedWorker = undefined;
      }
      worker.connections.delete(connection);
    }
    for (const connection of workerExitConnections) {
      writeLine(connection.socket, {
        type: "worker_exit",
        working: false,
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
        writeLine(pending.connection.socket, {
          ...responseError(pending.id, pending.commandType, "rin_worker_exit"),
          working: false,
        });
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
    return true;
  }

  private stopWorkerForRecovery(worker: WorkerHandle) {
    if (!this.workers.has(worker)) return;
    worker.recoveryStopRequested = true;
    try {
      worker.child.kill("SIGKILL");
    } catch {}
    if (worker.recoveryStopTimer) return;
    worker.recoveryStopTimer = setTimeout(() => {
      worker.recoveryStopTimer = undefined;
      this.stopWorkerForRecovery(worker);
    }, 500);
    worker.recoveryStopTimer.unref?.();
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
      !this.isActiveTurnRecoveryConverged() &&
      ACTIVE_COMMAND_TYPES.has(commandType)
    ) {
      if (commandId) {
        writeLine(
          connection.socket,
          responseError(commandId, commandType, "rin_daemon_recovering"),
        );
      }
      return;
    }
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
    const inputSubmissionCommand = commandType === "prompt";
    const keepUntilTerminalTurnEvent =
      !inputSubmissionCommand && expectsTerminalTurnEvent(commandType, command);
    const commandRequestTag = lifecycleRequestTag(command?.requestTag);
    const requiresLifecycleRequestTag =
      TURN_TERMINAL_COMMAND_TYPES.has(commandType);
    const terminalLifecycleCommand =
      requiresLifecycleRequestTag && !inputSubmissionCommand;
    if (inputSubmissionCommand && commandRequestTag) {
      const inFlight = [...worker.pendingResponses.values()].some(
        (pending) => pending.inputSubmission?.requestTag === commandRequestTag,
      );
      if (inFlight) {
        writeLine(
          connection.socket,
          responseError(commandId, commandType, "rin_turn_admission_pending"),
        );
        return;
      }
      const existing = readDaemonTurn(
        this.daemonLedgerAgentDir(),
        commandRequestTag,
      );
      if (existing) {
        writeLine(
          connection.socket,
          responseSuccess(commandId, commandType, {
            outcome: "rejoined",
            originalOutcome: "terminalOwner",
            requestTag: commandRequestTag,
            duplicate: true,
            ledgerState: existing.state,
          }),
        );
        return;
      }
    }
    let lifecycleAdmissionError = "";
    if (
      requiresLifecycleRequestTag &&
      (commandRequestTag === undefined || commandRequestTag.length === 0)
    ) {
      lifecycleAdmissionError = "rin_turn_request_tag_required";
    } else if (
      terminalLifecycleCommand &&
      worker.activeLifecycleRequestTag !== undefined
    ) {
      lifecycleAdmissionError = "rin_turn_in_progress";
    } else if (
      terminalLifecycleCommand &&
      worker.activeLifecycleRequestTag === undefined &&
      wasRunning
    ) {
      lifecycleAdmissionError = "rin_turn_in_progress";
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
    if (terminalLifecycleCommand && commandRequestTag !== undefined) {
      try {
        const admission = beginDaemonTurn(this.daemonLedgerAgentDir(), {
          requestTag: commandRequestTag,
          sessionFile: recoverySelector.sessionFile,
          sessionId: recoverySelector.sessionId,
          chatDeliveryContext: command.chatDeliveryContext,
          invocationContext: turnInvocationContext(command),
        });
        if (!admission.created) {
          if (commandId !== undefined) {
            writeLine(
              connection.socket,
              responseSuccess(commandId, commandType, {
                accepted: true,
                duplicate: true,
                requestTag: commandRequestTag,
                state: admission.record.state,
              }),
            );
          }
          return;
        }
      } catch (error: any) {
        if (commandId !== undefined) {
          writeLine(
            connection.socket,
            responseError(
              commandId,
              commandType,
              String(error?.message || error),
            ),
          );
        }
        return;
      }
    }
    if (commandId !== undefined) {
      worker.pendingResponses.set(commandId, {
        id: commandId,
        commandType,
        selector: recoverySelector,
        expectsTerminalTurnEvent: keepUntilTerminalTurnEvent,
        ...(inputSubmissionCommand && commandRequestTag
          ? {
              inputSubmission: {
                requestTag: commandRequestTag,
                chatDeliveryContext: command.chatDeliveryContext as
                  | {
                      turnId: string;
                      chatKey: string;
                      messageId: string;
                    }
                  | undefined,
                invocationContext: turnInvocationContext(command),
              },
            }
          : {}),
        stateEpoch: worker.stateEpoch,
        connection,
      });
    }
    if (TURN_TERMINAL_COMMAND_TYPES.has(commandType)) {
      const installsLifecycleOwner = Boolean(
        keepUntilTerminalTurnEvent &&
        commandRequestTag !== undefined &&
        !wasRunning &&
        worker.activeLifecycleRequestTag === undefined,
      );
      if (installsLifecycleOwner && commandRequestTag !== undefined) {
        worker.terminalPending = true;
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
      );
    }
    this.syncRunningWorkerRecord(worker);
    this.publishWorkerWorkingState(worker);
    const workerCommand = requiresLifecycleRequestTag
      ? Object.fromEntries(
          Object.entries(command).filter(
            ([key]) => key !== "chatDeliveryContext",
          ),
        )
      : command;
    this.writeWorkerStdin(worker, workerCommand, (error) => {
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
    if (this.findTrackedWorkerBySelector(wanted)?.recoveryStopRequested) {
      return undefined;
    }
    if (!wanted.sessionFile || !this.isActiveTurnRecoveryConverged()) {
      return undefined;
    }

    const claimed = await this.withSessionClaim(wanted, async () => {
      const tracked = this.findTrackedWorkerBySelector(wanted);
      if (tracked?.recoveryStopRequested) return undefined;
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
          : this.isWorkerWorking(worker)
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
        working: this.isWorkerWorking(worker),
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
    this.beginShutdown();
    clearInterval(this.reaper);
    if (this.activeTurnRecoveryScanTimer) {
      clearTimeout(this.activeTurnRecoveryScanTimer);
      this.activeTurnRecoveryScanTimer = undefined;
    }
    this.frontendConnections.clear();
    for (const worker of Array.from(this.workers)) {
      this.destroyWorker(worker);
    }
  }

  beginShutdown() {
    this.shuttingDown = true;
    if (this.activeTurnRecoveryScanTimer) {
      clearTimeout(this.activeTurnRecoveryScanTimer);
      this.activeTurnRecoveryScanTimer = undefined;
    }
    for (const timer of this.activeTurnRecoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTurnRecoveryTimers.clear();
    this.activeTurnRecoveryAttempts.clear();
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
    if (!selector.sessionFile || !this.isActiveTurnRecoveryConverged()) return;
    return this.restoreWorkerForSession(selector);
  }

  async recoverActiveDaemonTurns() {
    let records;
    try {
      records = listActiveDaemonTurns(this.daemonLedgerAgentDir());
    } catch (error) {
      console.error(
        `[rin-daemon] active turn recovery scan failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.scheduleActiveDaemonTurnRecoveryScan();
      return [];
    }
    const results = [];
    for (const record of records) {
      results.push(await this.recoverActiveDaemonTurn(record.requestTag));
    }
    return results;
  }

  private scheduleActiveDaemonTurnRecoveryScan() {
    if (this.shuttingDown || this.activeTurnRecoveryScanTimer) return;
    this.activeTurnRecoveryScanTimer = setTimeout(() => {
      this.activeTurnRecoveryScanTimer = undefined;
      void this.recoverActiveDaemonTurns();
    }, 1_000);
    this.activeTurnRecoveryScanTimer.unref?.();
  }

  private scheduleActiveDaemonTurnRecovery(requestTag: string) {
    if (this.shuttingDown || this.activeTurnRecoveryTimers.has(requestTag)) {
      return;
    }
    const attempt = (this.activeTurnRecoveryAttempts.get(requestTag) || 0) + 1;
    this.activeTurnRecoveryAttempts.set(requestTag, attempt);
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6));
    const timer = setTimeout(() => {
      this.activeTurnRecoveryTimers.delete(requestTag);
      void this.recoverActiveDaemonTurn(requestTag).catch((error) => {
        console.error(
          `[rin-daemon] recovery retry for turn ${requestTag}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.scheduleActiveDaemonTurnRecovery(requestTag);
      });
    }, delayMs);
    timer.unref?.();
    this.activeTurnRecoveryTimers.set(requestTag, timer);
  }

  private recoverActiveDaemonTurn(requestTag: string) {
    const existing = this.activeTurnRecoveryInFlight.get(requestTag);
    if (existing) return existing;
    const recovery = this.recoverActiveDaemonTurnOnce(requestTag).finally(
      () => {
        if (this.activeTurnRecoveryInFlight.get(requestTag) === recovery) {
          this.activeTurnRecoveryInFlight.delete(requestTag);
        }
      },
    );
    this.activeTurnRecoveryInFlight.set(requestTag, recovery);
    return recovery;
  }

  private async recoverActiveDaemonTurnOnce(requestTag: string) {
    if (this.shuttingDown) return false;
    let record;
    try {
      record = readDaemonTurn(this.daemonLedgerAgentDir(), requestTag);
    } catch (error) {
      console.error(
        `[rin-daemon] recovery retry for turn ${requestTag}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.scheduleActiveDaemonTurnRecovery(requestTag);
      return false;
    }
    if (!record || record.state !== "active") return false;
    const selector = sessionSelectorFromState(record);
    if (!selector.sessionFile) {
      if (
        !this.interruptDaemonTurnByRequestTag(
          requestTag,
          "rin_turn_recovery_session_missing",
          false,
        )
      ) {
        this.scheduleActiveDaemonTurnRecovery(requestTag);
      }
      return false;
    }
    const recoveredWorker = this.findTrackedWorkerBySelector(selector);
    if (
      recoveredWorker &&
      !recoveredWorker.recoveryStopRequested &&
      recoveredWorker.activeLifecycleRequestTag === requestTag &&
      (recoveredWorker.turnActive ||
        recoveredWorker.terminalPending ||
        recoveredWorker.isStreaming)
    ) {
      return true;
    }
    let worker: WorkerHandle | undefined;
    try {
      worker = await this.ensureWorkerForSession(selector, {
        recovery: true,
      });
      if (
        worker.activeLifecycleRequestTag &&
        worker.activeLifecycleRequestTag !== requestTag
      ) {
        throw new Error("rin_turn_recovery_session_busy");
      }
      this.setLifecycleOwner(worker, requestTag, selector, undefined, false);
      worker.activeRequestTag = requestTag;
      this.publishWorkerWorkingState(worker);
      const response = await this.sendInternalCommand(worker, {
        type: "resume_interrupted_turn",
        requestTag,
        ...record.invocationContext,
      });
      if (response?.data?.resumed !== true) {
        throw new Error("rin_turn_recovery_not_started");
      }
      worker.terminalPending = true;
      this.publishWorkerWorkingState(worker);
      return true;
    } catch (error) {
      let turnRemainsActive = true;
      try {
        turnRemainsActive =
          readDaemonTurn(this.daemonLedgerAgentDir(), requestTag)?.state ===
          "active";
      } catch {}
      if (!turnRemainsActive) {
        this.activeTurnRecoveryAttempts.delete(requestTag);
        return true;
      }
      console.error(
        `[rin-daemon] recovery retry for turn ${requestTag}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (
        worker?.activeLifecycleRequestTag === requestTag &&
        worker.child.exitCode === null
      ) {
        this.stopWorkerForRecovery(worker);
      }
      this.scheduleActiveDaemonTurnRecovery(requestTag);
      return false;
    }
  }

  private restoreWorkerForSession(selector: SessionSelector) {
    if (!selector.sessionFile) return;
    const tracked = this.findTrackedWorkerBySelector(selector);
    if (tracked?.recoveryStopRequested) return undefined;
    const existing = this.findWorkerBySelector(selector);
    if (existing) return existing;
    const key = this.sessionClaimKey(selector);
    if (key && this.pendingSessionClaims.has(key)) return undefined;

    const worker = this.createWorkerForSession(selector);
    void this.withSessionClaim(selector, async () => {
      const trackedAfterCreate = this.findTrackedWorkerBySelector(selector);
      if (trackedAfterCreate && trackedAfterCreate !== worker) {
        this.destroyWorker(worker);
        return trackedAfterCreate.recoveryStopRequested
          ? undefined
          : trackedAfterCreate;
      }
      return worker;
    }).catch(() => {});
    return worker;
  }

  private establishPiPromptLifecycle(
    worker: WorkerHandle,
    pending: PendingResponse,
    selector: SessionSelector,
  ) {
    const requestTag = pending.inputSubmission?.requestTag;
    if (!requestTag) return;
    if (
      worker.activeLifecycleRequestTag &&
      worker.activeLifecycleRequestTag !== requestTag
    ) {
      throw new Error("rin_turn_admission_pending");
    }
    pending.expectsTerminalTurnEvent = true;
    const admission = beginDaemonTurn(this.daemonLedgerAgentDir(), {
      requestTag,
      sessionFile: selector.sessionFile,
      sessionId: selector.sessionId,
      chatDeliveryContext: pending.inputSubmission?.chatDeliveryContext,
      invocationContext: pending.inputSubmission?.invocationContext,
    });
    if (admission.record.state !== "active") return;
    worker.terminalPending = true;
    this.setLifecycleOwner(
      worker,
      requestTag,
      selector,
      pending.id,
      pending.connection !== undefined,
    );
    worker.activeRequestTag = requestTag;
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
    worker.stateEpoch += 1;
    worker.activeLifecycleEpoch = worker.lifecycleEpoch;
  }

  private clearLifecycleOwner(worker: WorkerHandle) {
    const hadLifecycleOwner =
      worker.activeLifecycleRequestTag !== undefined ||
      worker.activeLifecycleEpoch !== undefined;
    worker.activeLifecycleRequestTag = undefined;
    worker.activeLifecycleSelector = undefined;
    worker.activeLifecycleOwnerCommandId = undefined;
    worker.activeLifecycleFrontendOwner = false;
    worker.activeLifecycleRecoveryProbeCommandId = undefined;
    worker.activeLifecycleEpoch = undefined;
    worker.activeLifecycleRecoveryProbeEpoch = undefined;
    if (hadLifecycleOwner) {
      worker.lifecycleEpoch += 1;
      worker.stateEpoch += 1;
    }
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
    return true;
  }

  private acceptsRpcTurnEvent(worker: WorkerHandle, payload: any) {
    if (payload?.type !== "rpc_turn_event") return true;
    const event = String(payload.event || "");
    const isTerminal = event === "complete" || event === "error";
    const isLifecycle =
      event === "start" || event === "heartbeat" || isTerminal;
    if (!isLifecycle) return true;
    const pendingInputSubmission =
      event === "start" && !worker.activeLifecycleRequestTag
        ? [...worker.pendingResponses.values()].some(
            (pending) =>
              pending.inputSubmission?.requestTag ===
              lifecycleRequestTag(payload.requestTag),
          )
        : false;
    if (
      !pendingInputSubmission &&
      !this.rpcTurnEventMatchesLifecycleOwner(worker, payload)
    ) {
      return false;
    }

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

    if (!hasGeneration) return false;

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
      if (generation > worker.lastTurnGeneration) {
        worker.lastTurnGeneration = generation;
        worker.activeTurnGeneration = generation;
      }
      return true;
    }

    if (event === "heartbeat") {
      return (
        generation === worker.lastTurnGeneration &&
        worker.activeTurnGeneration === generation
      );
    }
    if (
      generation === worker.lastTurnGeneration &&
      worker.activeTurnGeneration === generation
    ) {
      worker.activeTurnGeneration = undefined;
      return true;
    }
    if (
      generation > worker.lastTurnGeneration &&
      worker.activeTurnGeneration === undefined &&
      (worker.terminalPending || worker.turnActive || worker.isStreaming)
    ) {
      worker.lastTurnGeneration = generation;
      return true;
    }
    return false;
  }

  private updateWorkerMetadata(worker: WorkerHandle, payload: any) {
    if (!payload || typeof payload !== "object") return false;
    if (!this.acceptsRpcTurnEvent(worker, payload)) return false;
    worker.lastUsedAt = Date.now();
    if (
      payload.type === "agent_start" ||
      payload.type === "agent_end" ||
      payload.type === "compaction_start" ||
      payload.type === "compaction_end" ||
      payload.type === "rpc_turn_event"
    ) {
      worker.stateEpoch += 1;
    }
    let settledPendingId: string | undefined;
    const pendingResponse = payload.id
      ? worker.pendingResponses.get(String(payload.id))
      : undefined;

    if (payload.type === "response" && payload.success === true) {
      const data = payload.data || {};
      if (pendingResponse?.inputSubmission) {
        const observed = nativeInputOutcome(data);
        if (!observed) {
          pendingResponse.expectsTerminalTurnEvent = false;
          payload.success = false;
          payload.error = "rin_prompt_outcome_invalid";
          return true;
        }
        const ownsTerminal =
          observed.outcome === "terminalOwner" ||
          (observed.outcome === "rejoined" &&
            observed.originalOutcome === "terminalOwner");
        if (
          ownsTerminal &&
          worker.activeLifecycleRequestTag &&
          worker.activeLifecycleRequestTag !==
            pendingResponse.inputSubmission.requestTag
        ) {
          pendingResponse.expectsTerminalTurnEvent = false;
          payload.success = false;
          payload.error = "rin_turn_admission_pending";
          return true;
        }
        pendingResponse.expectsTerminalTurnEvent = ownsTerminal;
        if (ownsTerminal && !worker.activeLifecycleRequestTag) {
          this.establishPiPromptLifecycle(
            worker,
            pendingResponse,
            resolveSessionSelector(
              pendingResponse.selector ?? {},
              normalizeSessionSelector({
                sessionFile: data.sessionFile,
                sessionId: data.sessionId,
              }),
            ),
          );
        }
      }
      if (
        typeof data.sessionFile === "string" ||
        typeof data.sessionId === "string"
      ) {
        this.setWorkerSessionRefs(worker, sessionSelectorFromState(data));
      }
      if (payload.command === "get_state") {
        const reportedTurnActive = Boolean(data.turnActive ?? data.isStreaming);
        const hasLifecycleOwner =
          worker.activeLifecycleRequestTag !== undefined;
        const stateSnapshotIsCurrent = Boolean(
          pendingResponse && pendingResponse.stateEpoch === worker.stateEpoch,
        );
        const isMatchingRecoveryProbe = Boolean(
          stateSnapshotIsCurrent &&
          worker.activeLifecycleEpoch !== undefined &&
          worker.activeLifecycleRecoveryProbeCommandId ===
            pendingResponse?.id &&
          worker.activeLifecycleRecoveryProbeEpoch ===
            worker.activeLifecycleEpoch,
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
        if (
          stateSnapshotIsCurrent &&
          (!hasLifecycleOwner ||
            (isMatchingRecoveryProbe && reportedSelectorMatchesLifecycle))
        ) {
          worker.turnActive = reportedTurnActive;
          worker.isStreaming = Boolean(data.isStreaming);
        }
        if (
          stateSnapshotIsCurrent &&
          !reportedTurnActive &&
          !isMatchingRecoveryProbe &&
          !hasLifecycleOwner
        ) {
          worker.terminalPending = false;
          worker.activeRequestTag = undefined;
          worker.activeTurnGeneration = undefined;
          this.clearLifecycleOwner(worker);
        } else if (isMatchingRecoveryProbe) {
          worker.activeLifecycleRecoveryProbeCommandId = undefined;
          worker.activeLifecycleRecoveryProbeEpoch = undefined;
        }
        if (stateSnapshotIsCurrent) {
          worker.isCompacting = Boolean(data.isCompacting);
        }
        data.working = this.isWorkerWorking(worker, pendingResponse?.id);
        this.maybeReleaseWorker(worker);
        return true;
      }
    }

    if (
      payload.type === "response" &&
      payload.success !== true &&
      TURN_TERMINAL_COMMAND_TYPES.has(String(payload.command || "")) &&
      pendingResponse &&
      worker.activeLifecycleOwnerCommandId === pendingResponse.id
    ) {
      const rejectedRequestTag = worker.activeLifecycleRequestTag;
      const rejectionReason = String(
        payload.error || "rin_worker_command_rejected",
      );
      const workingAfterInterruption =
        this.isWorkerWorkingAfterLifecycleSettlement(
          worker,
          pendingResponse.id,
        );
      if (
        !rejectedRequestTag ||
        !this.interruptDaemonTurnByRequestTag(
          rejectedRequestTag,
          rejectionReason,
          workingAfterInterruption,
          worker,
        )
      ) {
        throw new Error("rin_turn_ledger_interrupt_failed");
      }
      worker.terminalPending = false;
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
      if (payload.event === "start") {
        const requestTag = lifecycleRequestTag(payload.requestTag);
        const inputSubmission = requestTag
          ? [...worker.pendingResponses.values()].find(
              (candidate) =>
                candidate.inputSubmission?.requestTag === requestTag,
            )
          : undefined;
        if (requestTag && inputSubmission?.inputSubmission) {
          this.establishPiPromptLifecycle(
            worker,
            inputSubmission,
            resolveSessionSelector(inputSubmission.selector ?? {}, selector),
          );
        }
      }
      worker.terminalPending = Boolean(worker.activeLifecycleRequestTag);
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
      const requestTag = lifecycleRequestTag(payload.requestTag);
      if (!requestTag) throw new Error("rin_turn_ledger_request_tag_required");
      settledPendingId = worker.activeLifecycleOwnerCommandId;
      let terminalRecord;
      try {
        terminalRecord = recordDaemonTurnTerminal(this.daemonLedgerAgentDir(), {
          requestTag,
          terminalKind: payload.event,
          terminalEvent: payload,
        });
      } catch (error: any) {
        throw new Error(
          `rin_turn_ledger_terminal_record_failed:${String(
            error?.message || error,
          )}`,
        );
      }
      worker.terminalPending = false;
      worker.rpcTurnActive = false;
      worker.activeRequestTag = undefined;
      worker.activeTurnGeneration = undefined;
      this.clearLifecycleOwner(worker);
      worker.turnActive = false;
      worker.isStreaming = false;
      this.activeTurnRecoveryAttempts.delete(requestTag);
      Object.assign(payload, daemonTurnTerminalEvent(terminalRecord));
      try {
        this.syncRunningWorkerRecordForSelector(
          sessionSelectorFromState(payload),
          false,
        );
        this.syncRunningWorkerRecord(worker);
        this.maybeReleaseWorker(worker);
      } catch (error) {
        console.error(
          `[rin-daemon] terminal running-state projection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (payload.type === "rpc_turn_event" && payload.event === "complete") {
      this.setWorkerSessionRefs(worker, sessionSelectorFromState(payload), {
        syncConnections: false,
        syncRunningWorkerRecord: false,
      });
    }
    payload.working = Boolean(
      this.isWorkerWorking(
        worker,
        payload.type === "response" ? pendingResponse?.id : settledPendingId,
      ) ||
      (isTerminalRpcTurnEvent(payload) &&
        this.currentBackendWorking(sessionSelectorFromState(payload), worker)),
    );
    if (payload.type !== "response" && !isTerminalRpcTurnEvent(payload)) {
      worker.publishedWorking = payload.working;
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
    const workerResourceOptionsArgs = this.writeWorkerResourceOptionsFile(
      workerResourceOptions,
    );
    const workerResourceOptionsFile = workerResourceOptionsArgs[1];
    const workerArgs = [this.options.workerPath, ...workerResourceOptionsArgs];
    const workerId = `worker_${++this.workerSeq}`;
    const workerEnv = {
      ...process.env,
      [RIN_DAEMON_WORKER_OWNER_ENV]: os.userInfo().username,
    };
    delete workerEnv[WORKER_CGROUP_DELEGATION_ENV];
    const cleanupWorkerResourceOptions = () => {
      if (!workerResourceOptionsFile) return;
      try {
        fs.rmSync(workerResourceOptionsFile, { force: true });
      } catch {}
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, workerArgs, {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: workerEnv,
        windowsHide: true,
      });
    } catch (error) {
      cleanupWorkerResourceOptions();
      throw error;
    }
    child.once("error", cleanupWorkerResourceOptions);
    child.once("close", cleanupWorkerResourceOptions);
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
      terminalPending: false,
      activeRequestTag: undefined,
      activeTurnGeneration: undefined,
      activeLifecycleRequestTag: undefined,
      activeLifecycleSelector: undefined,
      activeLifecycleOwnerCommandId: undefined,
      activeLifecycleFrontendOwner: false,
      activeLifecycleRecoveryProbeCommandId: undefined,
      lifecycleEpoch: 0,
      stateEpoch: 0,
      activeLifecycleEpoch: undefined,
      activeLifecycleRecoveryProbeEpoch: undefined,
      lastTurnGeneration: 0,
      isStreaming: false,
      isCompacting: false,
      publishedWorking: false,
      lastUsedAt: Date.now(),
      idleSince: null,
      gracefulShutdownRequested: false,
      recoveryStopRequested: false,
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

        try {
          if (!this.updateWorkerMetadata(worker, payload)) return;
        } catch (error: any) {
          const detail = String(error?.message || error);
          const terminalPersistenceFailed = detail.startsWith(
            "rin_turn_ledger_terminal_record_failed:",
          );
          for (const connection of this.getWorkerEventConnections(worker)) {
            writeLine(connection.socket, {
              type: "rpc_protocol_error",
              error: terminalPersistenceFailed
                ? detail
                : `rin_turn_ledger_terminal_record_failed:${detail}`,
            });
          }
          if (
            terminalPersistenceFailed &&
            worker.activeLifecycleRequestTag !== undefined
          ) {
            // Preserve ledger ownership; the normal exit path resumes it.
            this.stopWorkerForRecovery(worker);
            return;
          }
          this.destroyWorker(worker);
          return;
        }

        if (
          payload?.type === "response" &&
          payload.id &&
          worker.pendingResponses.has(String(payload.id))
        ) {
          const pending = worker.pendingResponses.get(String(payload.id))!;
          worker.pendingResponses.delete(String(payload.id));
          const keepTerminalRecord =
            payload.success === true &&
            pending.expectsTerminalTurnEvent === true;
          if (!keepTerminalRecord) this.syncRunningWorkerRecord(worker);
          if (pending.connection) {
            this.rememberSessionSelection(
              pending.connection,
              this.getWorkerSelector(worker),
            );
          }
          pending.finalize?.();
          this.publishWorkerWorkingState(worker);
          if (pending.resolve) pending.resolve(payload);
          if (pending.connection) writeLine(pending.connection.socket, payload);
          this.maybeReleaseWorker(worker);
          return;
        }

        if (isTerminalRpcTurnEvent(payload)) {
          this.publishWorkerWorkingState(worker, payload.working === true);
          this.resolveTerminalTurnWaiters(payload);
          return;
        }
        for (const connection of this.getWorkerEventConnections(worker)) {
          if (this.shouldForwardWorkerPayload(connection, worker, payload)) {
            writeLine(connection.socket, payload);
          }
        }
      });
    });

    child.stderr.on("data", (chunk) => {
      parseJsonl(String(chunk), worker.stderrBuffer, (line) => {
        for (const connection of this.getWorkerEventConnections(worker)) {
          if (this.shouldForwardWorkerPayload(connection, worker, {})) {
            writeLine(connection.socket, { type: "stderr", line });
          }
        }
      });
    });

    child.stdin.on("error", (error) => {
      this.handleWorkerStdinFailure(worker, error);
    });

    child.on("close", async (code, signal) => {
      const activeRequestTag = lifecycleRequestTag(
        worker.activeLifecycleRequestTag || worker.activeRequestTag,
      );
      let activeRecord;
      let ledgerReadFailed = false;
      try {
        activeRecord = activeRequestTag
          ? readDaemonTurn(this.daemonLedgerAgentDir(), activeRequestTag)
          : undefined;
      } catch {
        ledgerReadFailed = true;
      }
      const preserveActiveTurn = Boolean(
        activeRecord?.state === "active" ||
        (ledgerReadFailed && activeRequestTag),
      );
      if (worker.recoveryStopTimer) {
        clearTimeout(worker.recoveryStopTimer);
        worker.recoveryStopTimer = undefined;
      }
      const liveConnections = new Set<ConnectionState>(worker.connections);
      for (const pending of worker.pendingResponses.values()) {
        pending.finalize?.();
        if (pending.connection) liveConnections.add(pending.connection);
      }
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
      const exitError = !cleanupComplete
        ? "rin_worker_cleanup_failed"
        : oomKilled
          ? "rin_worker_oom"
          : "rin_worker_exit";
      const recoverActiveTurn = preserveActiveTurn && !this.shuttingDown;
      const workingAfterExit = preserveActiveTurn;
      if (oomKilled && !recoverActiveTurn) {
        for (const connection of liveConnections) {
          writeLine(connection.socket, {
            type: "worker_oom",
            working: workingAfterExit,
            code: code ?? null,
            signal: signal ?? null,
          });
        }
      }
      if (!oomKilled && !recoverActiveTurn && !this.shuttingDown) {
        for (const connection of liveConnections) {
          writeLine(connection.socket, {
            type: "worker_exit",
            working: workingAfterExit,
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
          writeLine(entry.connection.socket, {
            ...responseError(entry.id, entry.commandType, exitError),
            working: workingAfterExit,
          });
        }
      }
      if (recoverActiveTurn && activeRequestTag) {
        this.scheduleActiveDaemonTurnRecovery(activeRequestTag);
      } else if (preserveActiveTurn && !this.shuttingDown) {
        this.scheduleActiveDaemonTurnRecoveryScan();
      }
    });

    return worker;
  }

  private getWorkerEventConnections(worker: WorkerHandle) {
    return new Set([...this.frontendConnections, ...worker.connections]);
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

  private maybeReleaseWorker(worker: WorkerHandle) {
    if (!this.workers.has(worker)) return;
    if (worker.gracefulShutdownRequested) return;
    if (
      worker.pendingResponses.size > 0 ||
      worker.turnActive ||
      worker.terminalPending ||
      worker.isStreaming ||
      worker.isCompacting
    ) {
      worker.idleSince = null;
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

  private daemonLedgerAgentDir() {
    const agentDir = String(
      this.options.agentDir || this.options.cwd || "",
    ).trim();
    if (!agentDir) throw new Error("rin_turn_ledger_agent_dir_required");
    return agentDir;
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

  private async ensureWorkerForSession(
    selector: SessionSelector,
    options: { recovery?: boolean } = {},
  ) {
    if (options.recovery !== true && !this.isActiveTurnRecoveryConverged()) {
      throw new Error("rin_daemon_recovering");
    }
    const wanted = sessionSelectorFromState(selector);
    const tracked = this.findTrackedWorkerBySelector(wanted);
    if (tracked?.recoveryStopRequested) {
      throw new Error("rin_session_worker_unavailable");
    }
    const existing = this.findWorkerBySelector(wanted);
    if (existing) return existing;
    if (!wanted.sessionFile) throw new Error("rin_session_file_required");

    const claimed = await this.withSessionClaim(wanted, async () => {
      const tracked = this.findTrackedWorkerBySelector(wanted);
      if (tracked?.recoveryStopRequested) {
        throw new Error("rin_session_worker_unavailable");
      }
      const existing = this.findWorkerBySelector(wanted);
      if (existing) return existing;
      return this.createWorkerForSession(wanted);
    });
    if (!claimed) throw new Error("rin_session_worker_unavailable");
    return claimed;
  }

  private isActiveTurnRecoveryConverged() {
    let records;
    try {
      records = listActiveDaemonTurns(this.daemonLedgerAgentDir());
    } catch {
      this.scheduleActiveDaemonTurnRecoveryScan();
      return false;
    }
    return records.every((record) => {
      const worker = this.findTrackedWorkerBySelector(
        sessionSelectorFromState(record),
      );
      return Boolean(
        worker &&
        !worker.recoveryStopRequested &&
        worker.activeLifecycleRequestTag === record.requestTag &&
        (worker.turnActive || worker.terminalPending || worker.isStreaming),
      );
    });
  }

  private currentBackendWorking(
    selector: SessionSelector,
    excludedWorker?: WorkerHandle,
  ) {
    const normalized = sessionSelectorFromState(selector);
    if (!hasSessionSelector(normalized)) return false;
    const worker = this.findWorkerBySelector(normalized);
    if (worker && worker !== excludedWorker && this.isWorkerWorking(worker)) {
      return true;
    }
    try {
      return listActiveDaemonTurns(this.daemonLedgerAgentDir()).some((record) =>
        sessionMatchesSelector(sessionSelectorFromState(record), normalized),
      );
    } catch {
      this.scheduleActiveDaemonTurnRecoveryScan();
      return true;
    }
  }

  private terminalEventForDelivery(
    record: any,
    workingOverride?: boolean,
    excludedWorker?: WorkerHandle,
  ) {
    const terminalEvent = daemonTurnTerminalEvent(record);
    return {
      ...terminalEvent,
      // Working is current daemon state, not immutable terminal history.
      working: Boolean(
        workingOverride || this.currentBackendWorking(record, excludedWorker),
      ),
    };
  }

  private waitForTerminalTurnEvent(
    requestTag: string,
    connection?: ConnectionState,
  ) {
    let waiter!: TerminalTurnWaiter;
    const promise = new Promise<any>((resolve, reject) => {
      waiter = {
        connection,
        requestTag,
        resolve,
        reject,
      };
      this.terminalTurnWaiters.add(waiter);
    });
    return { promise, waiter };
  }

  async awaitTerminalTurnEvent(
    connection: ConnectionState,
    _selector: SessionSelector,
    requestTag?: string,
  ) {
    const normalizedRequestTag = String(requestTag || "").trim();
    if (!normalizedRequestTag) {
      throw new Error("await_turn_terminal requires requestTag");
    }

    while (true) {
      let existing;
      try {
        existing = readDaemonTurn(
          this.daemonLedgerAgentDir(),
          normalizedRequestTag,
        );
      } catch {
        this.scheduleActiveDaemonTurnRecoveryScan();
        if (connection.socket.destroyed) throw new Error("rin_disconnected");
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (!existing) throw new Error("rin_turn_ledger_record_missing");
      if (existing.state !== "active") {
        return this.terminalEventForDelivery(existing);
      }

      const selected = sessionSelectorFromState(existing);
      if (!this.findWorkerBySelector(selected)) {
        this.scheduleActiveDaemonTurnRecovery(normalizedRequestTag);
      }

      const { promise, waiter } = this.waitForTerminalTurnEvent(
        normalizedRequestTag,
        connection,
      );
      let afterRegistration;
      try {
        afterRegistration = readDaemonTurn(
          this.daemonLedgerAgentDir(),
          normalizedRequestTag,
        );
      } catch {
        this.terminalTurnWaiters.delete(waiter);
        this.scheduleActiveDaemonTurnRecoveryScan();
        if (connection.socket.destroyed) throw new Error("rin_disconnected");
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (!afterRegistration) {
        this.terminalTurnWaiters.delete(waiter);
        this.scheduleActiveDaemonTurnRecoveryScan();
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (afterRegistration.state !== "active") {
        this.resolveTerminalTurnWaiters(
          this.terminalEventForDelivery(afterRegistration),
        );
      }
      try {
        return await promise;
      } finally {
        this.terminalTurnWaiters.delete(waiter);
      }
    }
  }

  private resolveTerminalTurnWaiters(payload: any) {
    const requestTag = lifecycleRequestTag(payload?.requestTag);
    for (const waiter of Array.from(this.terminalTurnWaiters)) {
      if (!requestTag || waiter.requestTag !== requestTag) continue;
      this.terminalTurnWaiters.delete(waiter);
      waiter.resolve(payload);
    }
  }

  private interruptDaemonTurnByRequestTag(
    requestTagValue: string,
    reason: string,
    workingOverride?: boolean,
    excludedWorker?: WorkerHandle,
  ) {
    const requestTag = lifecycleRequestTag(requestTagValue);
    if (!requestTag) return false;
    try {
      const terminal = interruptDaemonTurn(
        this.daemonLedgerAgentDir(),
        requestTag,
        reason,
      );
      if (terminal.state === "active") return false;
      const timer = this.activeTurnRecoveryTimers.get(requestTag);
      if (timer) clearTimeout(timer);
      this.activeTurnRecoveryTimers.delete(requestTag);
      this.activeTurnRecoveryAttempts.delete(requestTag);
      this.resolveTerminalTurnWaiters(
        this.terminalEventForDelivery(
          terminal,
          workingOverride,
          excludedWorker,
        ),
      );
      return true;
    } catch {
      // A missing or unavailable ledger cannot be replaced with inferred
      // lifecycle truth. Remaining waiters are rejected by the caller.
      return false;
    }
  }

  private findTrackedWorkerBySelector(selector: SessionSelector) {
    if (selector.sessionFile) {
      const worker = this.workersBySessionFile.get(selector.sessionFile);
      if (worker && this.workers.has(worker)) return worker;
    }
    if (selector.sessionId) {
      const worker = this.workersBySessionId.get(selector.sessionId);
      if (worker && this.workers.has(worker)) return worker;
    }
    return undefined;
  }

  private findWorkerBySelector(selector: SessionSelector) {
    const worker = this.findTrackedWorkerBySelector(selector);
    return worker && this.isWorkerRoutable(worker) ? worker : undefined;
  }

  private isWorkerRoutable(worker: WorkerHandle) {
    return (
      this.workers.has(worker) &&
      !worker.gracefulShutdownRequested &&
      !worker.recoveryStopRequested
    );
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

  private isWorkerLifecycleActive(
    worker: WorkerHandle,
    excludedPendingId?: string,
  ) {
    return Boolean(
      worker.activeLifecycleRequestTag !== undefined ||
      worker.turnActive ||
      worker.terminalPending ||
      worker.isStreaming ||
      worker.isCompacting ||
      Array.from(worker.pendingResponses.values()).some(
        (pending) =>
          pending.id !== excludedPendingId &&
          ACTIVE_COMMAND_TYPES.has(pending.commandType),
      ),
    );
  }

  private isWorkerWorking(worker: WorkerHandle, excludedPendingId?: string) {
    return this.isWorkerLifecycleActive(worker, excludedPendingId);
  }

  private isWorkerWorkingAfterLifecycleSettlement(
    worker: WorkerHandle,
    settledPendingId?: string,
  ) {
    return Boolean(
      worker.isStreaming ||
      worker.isCompacting ||
      Array.from(worker.pendingResponses.values()).some(
        (pending) =>
          pending.id !== settledPendingId &&
          ACTIVE_COMMAND_TYPES.has(pending.commandType),
      ),
    );
  }

  private publishWorkerWorkingState(worker: WorkerHandle, override?: boolean) {
    const working = override ?? this.isWorkerWorking(worker);
    if (worker.publishedWorking === working) return;
    worker.publishedWorking = working;
    worker.stateEpoch += 1;
    const payload = { type: "backend_working_state", working };
    for (const connection of this.getWorkerEventConnections(worker)) {
      if (this.shouldForwardWorkerPayload(connection, worker, payload)) {
        writeLine(connection.socket, payload);
      }
    }
  }

  private isWorkerRunning(worker: WorkerHandle) {
    return this.isWorkerLifecycleActive(worker);
  }

  private syncRunningWorkerRecordForSelector(
    selector: SessionSelector | undefined,
    running: boolean,
    requestTag?: string,
    frontendOwner = false,
  ) {
    const sessionFile = sessionSelectorFromState(selector).sessionFile;
    if (!sessionFile) return;
    setRunningWorkerSession(
      this.options.agentDir,
      sessionFile,
      running,
      requestTag,
      frontendOwner,
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
    );
  }

  private clearRunningWorkerRecord(worker: WorkerHandle) {
    const sessionFile = this.getWorkerSelector(worker).sessionFile;
    if (!sessionFile) return;
    setRunningWorkerSession(this.options.agentDir, sessionFile, false);
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
    const pendingResponses = Array.from(worker.pendingResponses.values());
    worker.pendingResponses.clear();
    const lifecycleSettled = this.destroyWorker(worker);
    const working =
      !lifecycleSettled && worker.activeLifecycleRequestTag !== undefined;
    for (const pending of pendingResponses) {
      pending.finalize?.();
      if (pending.reject) {
        pending.reject(error);
      } else if (pending.connection) {
        writeLine(pending.connection.socket, {
          ...responseError(pending.id, pending.commandType, "rin_worker_exit"),
          working,
        });
      }
    }
    worker.ignoredResponseIds.clear();
  }

  private rejectInternalCommandWrite(
    worker: WorkerHandle,
    id: string,
    finalize: () => void,
    reject: (error: Error) => void,
    error: unknown,
  ) {
    worker.pendingResponses.delete(id);
    worker.ignoredResponseIds.add(id);
    this.publishWorkerWorkingState(worker);
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
      this.publishWorkerWorkingState(worker);
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
      stateEpoch: worker.stateEpoch,
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
    if (TURN_TERMINAL_COMMAND_TYPES.has(commandType)) {
      const requestTag = lifecycleRequestTag(command?.requestTag);
      if (keepUntilTerminalTurnEvent && requestTag !== undefined) {
        worker.terminalPending = true;
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
      );
    }
    this.publishWorkerWorkingState(worker);

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
