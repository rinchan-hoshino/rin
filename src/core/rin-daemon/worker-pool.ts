import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleep } from "../platform/process.js";
import type { RpcSocketLike } from "../platform/rpc-socket.js";
import {
  clearPendingTerminalTurnEvent,
  rememberPendingTerminalTurnEvent,
  takePendingTerminalTurnEvent,
} from "./pending-turn-events.js";
import { setRunningWorkerSession } from "./running-workers.js";
import { parseJsonl } from "../rin-lib/common.js";
import { isSessionScopedCommand } from "../rin-lib/rpc.js";
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
  connection?: ConnectionState;
  resolve?: (payload: any) => void;
  reject?: (error: Error) => void;
  finalize?: () => void;
};

export type WorkerHandle = {
  id: string;
  child: ReturnType<typeof spawn>;
  stdoutBuffer: { buffer: string };
  stderrBuffer: { buffer: string };
  connections: Set<ConnectionState>;
  pendingResponses: Map<string, PendingResponse>;
  ignoredResponseIds: Set<string>;
  sessionFile?: string;
  sessionId?: string;
  turnActive: boolean;
  rpcTurnActive: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  rinWorking: boolean;
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

function createSwitchSessionCommand(sessionFile: string) {
  return {
    type: "switch_session",
    sessionPath: sessionFile,
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

function hasResumableWorkerActivity(worker: WorkerHandle) {
  if (
    worker.turnActive ||
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
  private workerSeq = 0;
  private internalRequestSeq = 0;
  private shuttingDown = false;
  private readonly gcIdleMs: number;
  private readonly internalCommandTimeoutMs: number;
  private readonly switchSessionCommandTimeoutMs: number;
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

  detachWorker(
    connection: ConnectionState,
    options: { clearSelection?: boolean } = {},
  ) {
    const worker = connection.attachedWorker;
    if (worker) {
      worker.connections.delete(connection);
      connection.attachedWorker = undefined;
      worker.lastUsedAt = Date.now();
      this.maybeReleaseWorker(worker);
    }
    if (options.clearSelection) {
      this.rememberSessionSelection(connection, {});
    }
  }

  terminateWorkerGracefully(worker: WorkerHandle) {
    if (!this.workers.has(worker) || worker.gracefulShutdownRequested) return;
    worker.gracefulShutdownRequested = true;
    this.writeWorkerStdin(worker, { type: "shutdown_session" }, () => {
      this.destroyWorker(worker);
    });
  }

  sleepWorkerGracefully(worker: WorkerHandle) {
    if (!this.workers.has(worker) || worker.gracefulShutdownRequested) return;
    worker.gracefulShutdownRequested = true;
    this.writeWorkerStdin(worker, { type: "sleep_session" }, () => {
      this.destroyWorker(worker, { signal: "SIGKILL" });
    });
  }

  destroyWorker(
    worker: WorkerHandle,
    options: { signal?: NodeJS.Signals } = {},
  ) {
    if (!this.workers.has(worker)) return;
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
    if (attach) this.attachWorker(connection, worker);
    const selector = this.getSessionSelector(command);
    if (hasSessionSelector(selector)) {
      this.rememberSessionSelection(connection, selector);
    }
    worker.lastUsedAt = Date.now();
    worker.idleSince = null;
    if (command?.id) {
      worker.pendingResponses.set(String(command.id), {
        id: String(command.id),
        commandType: String(command?.type || "unknown"),
        connection,
      });
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

  hasSelectedSession(connection: ConnectionState) {
    return hasSessionSelector(this.getConnectionSelector(connection));
  }

  async selectSession(connection: ConnectionState, selector: SessionSelector) {
    const wanted = sessionSelectorFromState(selector);
    if (
      connection.attachedWorker &&
      !this.workerMatchesSelector(connection.attachedWorker, wanted)
    ) {
      this.detachWorker(connection);
    }
    this.rememberSessionSelection(connection, wanted);
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
      this.workerMatchesSelector(connection.attachedWorker, wanted)
    ) {
      return connection.attachedWorker;
    }
    const existing = this.findWorkerBySelector(wanted);
    if (existing) {
      this.attachWorker(connection, existing);
      return existing;
    }
    if (!wanted.sessionFile) return undefined;

    const claimed = await this.withSessionClaim(wanted, async () => {
      const worker = this.createWorker(connection, connection.resourceOptions);
      try {
        await this.sendInternalCommand(
          worker,
          createSwitchSessionCommand(wanted.sessionFile),
        );
        const existing = this.findWorkerBySelector(wanted);
        if (existing && existing !== worker) {
          this.destroyWorker(worker);
          return existing;
        }
        this.setWorkerSessionRefs(worker, wanted);
        return worker;
      } catch (error) {
        this.destroyWorker(worker);
        throw error;
      }
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
      return this.createWorker(connection, connection.resourceOptions);
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
          : worker.turnActive || worker.isStreaming || worker.rinWorking
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
  }) {
    const selector = sessionSelectorFromState(item);
    if (!selector.sessionFile) return;
    void this.restoreWorkerForSession(
      selector,
      true,
      item.source || "daemon-restart",
    );
  }

  private restoreWorkerForSession(
    selector: SessionSelector,
    resumeTurn: boolean,
    source = "daemon-restart",
  ) {
    if (!selector.sessionFile) return;
    const existing = this.findWorkerBySelector(selector);
    if (existing) return existing;
    const key = this.sessionClaimKey(selector);
    if (key && this.pendingSessionClaims.has(key)) return undefined;

    const worker = this.createWorker();
    void this.withSessionClaim(selector, async () => {
      try {
        await this.sendInternalCommand(
          worker,
          createSwitchSessionCommand(selector.sessionFile!),
        );
        const existingAfterSwitch = this.findWorkerBySelector(selector);
        if (existingAfterSwitch && existingAfterSwitch !== worker) {
          this.destroyWorker(worker);
          return existingAfterSwitch;
        }
        this.setWorkerSessionRefs(worker, selector);
        if (resumeTurn) {
          await this.sendInternalCommand(worker, {
            type: "resume_interrupted_turn",
            source,
          });
        }
        return worker;
      } catch {
        this.destroyWorker(worker);
        return undefined;
      }
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

  private updateWorkerMetadata(worker: WorkerHandle, payload: any) {
    if (!payload || typeof payload !== "object") return;
    worker.lastUsedAt = Date.now();

    if (payload.type === "response" && payload.success === true) {
      const data = payload.data || {};
      if (
        typeof data.sessionFile === "string" ||
        typeof data.sessionId === "string"
      ) {
        this.setWorkerSessionRefs(worker, sessionSelectorFromState(data));
      }
      if (payload.command === "get_state") {
        worker.turnActive = Boolean(data.turnActive ?? data.isStreaming);
        worker.isStreaming = Boolean(data.isStreaming);
        worker.isCompacting = Boolean(data.isCompacting);
        worker.rinWorking = false;
        this.maybeReleaseWorker(worker);
        return;
      }
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
        this.setWorkerSessionRefs(worker, selector, { syncConnections: false });
      }
      worker.rpcTurnActive = true;
      worker.turnActive = true;
      this.syncRunningWorkerRecord(worker);
    }
    if (
      payload.type === "rpc_turn_event" &&
      (payload.event === "complete" || payload.event === "error")
    ) {
      worker.rpcTurnActive = false;
      worker.turnActive = false;
      worker.isStreaming = false;
      this.syncRunningWorkerRecord(worker);
      this.maybeReleaseWorker(worker);
    }
    if (payload.type === "rpc_turn_event" && payload.event === "complete") {
      this.setWorkerSessionRefs(worker, sessionSelectorFromState(payload), {
        syncConnections: false,
      });
    }
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
    const child = spawn(process.execPath, workerArgs, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const worker: WorkerHandle = {
      id: `worker_${++this.workerSeq}`,
      child,
      stdoutBuffer: { buffer: "" },
      stderrBuffer: { buffer: "" },
      connections: new Set(),
      pendingResponses: new Map(),
      ignoredResponseIds: new Set(),
      turnActive: false,
      rpcTurnActive: false,
      isStreaming: false,
      isCompacting: false,
      rinWorking: false,
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

        this.updateWorkerMetadata(worker, payload);

        if (
          payload?.type === "response" &&
          payload.id &&
          worker.pendingResponses.has(String(payload.id))
        ) {
          const pending = worker.pendingResponses.get(String(payload.id))!;
          worker.pendingResponses.delete(String(payload.id));
          this.syncRunningWorkerRecord(worker);
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

        let forwarded = 0;
        for (const connection of worker.connections) {
          if (this.shouldForwardWorkerPayload(connection, worker, payload)) {
            writeLine(connection.socket, payload);
            forwarded += 1;
          }
        }
        if (isTerminalRpcTurnEvent(payload)) {
          if (forwarded === 0) {
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

    child.on("exit", (code, signal) => {
      const liveConnections = new Set<ConnectionState>(worker.connections);
      for (const pending of worker.pendingResponses.values()) {
        pending.finalize?.();
        if (pending.connection) liveConnections.add(pending.connection);
      }
      const selector = this.getWorkerSelector(worker);
      const shouldRecover = this.shouldRecoverWorker(worker, liveConnections);
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
      if (shouldRecover) {
        this.recoverWorker(selector, worker, liveConnections, pending);
        return;
      }
      for (const connection of liveConnections) {
        writeLine(connection.socket, {
          type: "worker_exit",
          code: code ?? null,
          signal: signal ?? null,
        });
      }
      for (const entry of pending) {
        if (entry.reject) {
          entry.reject(new Error("rin_worker_exit"));
          continue;
        }
        if (entry.connection) {
          writeLine(
            entry.connection.socket,
            responseError(entry.id, entry.commandType, "rin_worker_exit"),
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
    const pendingTerminalEvent = takePendingTerminalTurnEvent(
      this.options.agentDir,
      effectiveSelector,
    );
    if (!pendingTerminalEvent) return false;
    writeLine(connection.socket, pendingTerminalEvent);
    return true;
  }

  private maybeReleaseWorker(worker: WorkerHandle) {
    if (!this.workers.has(worker)) return;
    if (worker.gracefulShutdownRequested) return;
    if (
      worker.pendingResponses.size > 0 ||
      worker.turnActive ||
      worker.isStreaming ||
      worker.isCompacting ||
      worker.rinWorking
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

  private findWorkerBySelector(selector: SessionSelector) {
    if (
      selector.sessionFile &&
      this.workersBySessionFile.has(selector.sessionFile)
    ) {
      return this.workersBySessionFile.get(selector.sessionFile);
    }
    if (selector.sessionId && this.workersBySessionId.has(selector.sessionId)) {
      return this.workersBySessionId.get(selector.sessionId);
    }
    return undefined;
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
    options: { syncConnections?: boolean } = {},
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
    this.syncRunningWorkerRecord(worker);
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
      worker.isStreaming ||
      worker.isCompacting ||
      worker.rinWorking ||
      Array.from(worker.pendingResponses.values()).some((pending) =>
        RESUMABLE_COMMAND_TYPES.has(pending.commandType),
      ),
    );
  }

  private syncRunningWorkerRecord(worker: WorkerHandle) {
    const sessionFile = this.getWorkerSelector(worker).sessionFile;
    if (!sessionFile) return;
    setRunningWorkerSession(
      this.options.agentDir,
      sessionFile,
      this.isWorkerRunning(worker),
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
  ) {
    const resumeTurn = hasResumableWorkerActivity(worker);
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

      const replacement = this.createWorker();
      try {
        await this.sendInternalCommand(
          replacement,
          createSwitchSessionCommand(sessionFile),
        );
        const existingAfterSwitch = this.findWorkerBySelector(selector);
        if (existingAfterSwitch && existingAfterSwitch !== replacement) {
          this.destroyWorker(replacement);
          return existingAfterSwitch;
        }
        this.setWorkerSessionRefs(replacement, selector);
        return replacement;
      } catch {
        this.destroyWorker(replacement);
        return undefined;
      }
    })
      .then(async (recovered) => {
        if (!recovered) return;
        for (const connection of liveConnections) {
          this.attachWorker(connection, recovered);
        }
        if (resumeTurn && !this.isWorkerRunning(recovered)) {
          await this.sendInternalCommand(recovered, {
            type: "resume_interrupted_turn",
            source: "worker-exit",
          });
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

  private handleWorkerStdinFailure(worker: WorkerHandle, error: Error) {
    if (!this.workers.has(worker)) return;
    for (const pending of Array.from(worker.pendingResponses.values())) {
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
    worker.pendingResponses.delete(id);
    worker.ignoredResponseIds.add(id);
    finalize();
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    reject(normalized);
    this.destroyWorker(worker);
  }

  private sendInternalCommand(worker: WorkerHandle, command: any) {
    const id = `rin_internal_${++this.internalRequestSeq}`;
    const commandType = String(command?.type || "unknown");
    let resolveCommand!: (value: any) => void;
    let rejectCommand!: (error: Error) => void;
    const pendingCommand = new Promise<any>((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    });
    pendingCommand.catch(() => {});

    const timeout = setTimeout(() => {
      worker.pendingResponses.delete(id);
      worker.ignoredResponseIds.add(id);
      this.syncRunningWorkerRecord(worker);
      this.maybeReleaseWorker(worker);
      rejectCommand(new Error(`rin_internal_timeout:${commandType}`));
    }, this.getInternalCommandTimeoutMs(command));
    timeout.unref?.();

    const finalize = () => clearTimeout(timeout);
    worker.pendingResponses.set(id, {
      id,
      commandType,
      resolve: resolveCommand,
      reject: rejectCommand,
      finalize,
    });

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
