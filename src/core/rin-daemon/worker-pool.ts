import { spawn } from "node:child_process";

import type { RpcSocketLike } from "../platform/rpc-socket.js";
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
  isStreaming: boolean;
  isCompacting: boolean;
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

export class WorkerPool {
  private workers = new Set<WorkerHandle>();
  private workersBySessionFile = new Map<string, WorkerHandle>();
  private workersBySessionId = new Map<string, WorkerHandle>();
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
    try {
      worker.child.stdin.write(
        `${JSON.stringify({ type: "shutdown_session" })}\n`,
      );
    } catch {
      this.destroyWorker(worker);
    }
  }

  destroyWorker(worker: WorkerHandle) {
    if (!this.workers.has(worker)) return;
    worker.gracefulShutdownRequested = true;
    this.workers.delete(worker);
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
      worker.child.kill("SIGTERM");
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
    worker.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  forwardToWorker(
    connection: ConnectionState,
    worker: WorkerHandle,
    command: any,
  ) {
    this.requestWorker(worker, connection, command, true);
  }

  ensureAttachedWorker(connection: ConnectionState) {
    if (connection.attachedWorker) return connection.attachedWorker;
    const worker = this.createWorker(connection);
    this.attachWorker(connection, worker);
    return worker;
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

    const worker = this.createWorker(connection);
    this.setWorkerSessionRefs(worker, wanted);
    this.attachWorker(connection, worker);
    try {
      await this.sendInternalCommand(
        worker,
        createSwitchSessionCommand(wanted.sessionFile),
      );
      return worker;
    } catch (error) {
      this.destroyWorker(worker);
      throw error;
    }
  }

  resolveWorkerForCommand(connection: ConnectionState, command: any) {
    const type = String(command?.type || "unknown");
    const selector = this.resolveSelector(connection, command);

    if (type === "new_session") {
      return this.createWorker(connection);
    }

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
    if (isSessionScopedCommand(type)) return undefined;
    return undefined;
  }

  getStatusSnapshot() {
    return {
      workerCount: this.workers.size,
      workers: Array.from(this.workers).map((worker) => ({
        id: worker.id,
        pid: worker.child.pid ?? null,
        sessionFile: worker.sessionFile,
        sessionId: worker.sessionId,
        attachedConnections: worker.connections.size,
        pendingResponses: worker.pendingResponses.size,
        turnActive: worker.turnActive,
        isStreaming: worker.isStreaming,
        isCompacting: worker.isCompacting,
        lastUsedAt: worker.lastUsedAt,
        idleSince: worker.idleSince,
        gracefulShutdownRequested: worker.gracefulShutdownRequested,
        role: "session",
      })),
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
      const resumeTurn = Boolean(worker.turnActive || worker.isCompacting);
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
    const worker = this.createWorker();
    this.setWorkerSessionRefs(worker, selector);
    void (async () => {
      try {
        await this.sendInternalCommand(
          worker,
          createSwitchSessionCommand(selector.sessionFile),
        );
      } catch {
        this.destroyWorker(worker);
      }
    })().catch(() => {});
    return worker;
  }

  continueInterruptedTurnSessionWorker(item: {
    sessionFile?: string;
    source?: string;
  }) {
    const selector = sessionSelectorFromState(item);
    if (!selector.sessionFile) return;
    const worker = this.createWorker();
    this.setWorkerSessionRefs(worker, selector);
    void (async () => {
      try {
        await this.sendInternalCommand(
          worker,
          createSwitchSessionCommand(selector.sessionFile),
        );
        await this.sendInternalCommand(worker, {
          type: "resume_interrupted_turn",
          source: item.source || "daemon-restart",
        });
      } catch {
        this.destroyWorker(worker);
      }
    })().catch(() => {});
  }

  async shutdown(graceMs: number) {
    const restorable = this.getRestorableSessionSelectors();
    this.beginShutdown();
    const deadline = Date.now() + Math.max(0, graceMs);
    while (this.workers.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const worker of Array.from(this.workers)) {
        this.maybeReleaseWorker(worker);
      }
    }
    this.destroyAll();
    return restorable;
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
        this.maybeReleaseWorker(worker);
        return;
      }
    }

    if (payload.type === "agent_start") {
      worker.turnActive = true;
      worker.isStreaming = true;
    }
    if (payload.type === "agent_end") {
      worker.turnActive = false;
      worker.isStreaming = false;
      this.maybeReleaseWorker(worker);
    }
    if (payload.type === "compaction_start") {
      worker.isCompacting = true;
    }
    if (payload.type === "compaction_end") {
      worker.isCompacting = false;
      this.maybeReleaseWorker(worker);
    }
    if (
      payload.type === "rpc_turn_event" &&
      (payload.event === "start" || payload.event === "heartbeat")
    ) {
      worker.turnActive = true;
    }
    if (
      payload.type === "rpc_turn_event" &&
      (payload.event === "complete" || payload.event === "error")
    ) {
      worker.turnActive = false;
      worker.isStreaming = false;
      this.maybeReleaseWorker(worker);
    }
    if (payload.type === "rpc_turn_event" && payload.event === "complete") {
      this.setWorkerSessionRefs(worker, sessionSelectorFromState(payload));
    }
  }

  private createWorker(requester?: ConnectionState) {
    if (this.shuttingDown) {
      throw new Error("rin_daemon_shutting_down");
    }

    const child = spawn(process.execPath, [this.options.workerPath], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
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
      isStreaming: false,
      isCompacting: false,
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
            if (!connection.socket.destroyed) {
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

        for (const connection of worker.connections) {
          writeLine(connection.socket, payload);
        }
      });
    });

    child.stderr.on("data", (chunk) => {
      parseJsonl(String(chunk), worker.stderrBuffer, (line) => {
        for (const connection of worker.connections) {
          writeLine(connection.socket, { type: "stderr", line });
        }
      });
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

  private attachWorker(connection: ConnectionState, worker: WorkerHandle) {
    if (connection.attachedWorker === worker) return;
    this.detachWorker(connection);
    connection.attachedWorker = worker;
    worker.connections.add(connection);
    worker.lastUsedAt = Date.now();
    worker.idleSince = null;
    this.rememberSessionSelection(connection, this.getWorkerSelector(worker));
  }

  private maybeReleaseWorker(worker: WorkerHandle) {
    if (!this.workers.has(worker)) return;
    if (worker.gracefulShutdownRequested) return;
    if (worker.connections.size > 0) {
      worker.idleSince = null;
      return;
    }
    if (
      worker.pendingResponses.size > 0 ||
      worker.turnActive ||
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
    if (Date.now() - worker.idleSince >= this.gcIdleMs) {
      this.destroyWorker(worker);
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

  private setWorkerSessionRefs(worker: WorkerHandle, next: SessionSelector) {
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
    if (worker.sessionFile) {
      this.workersBySessionFile.set(worker.sessionFile, worker);
    }
    if (worker.sessionId) this.workersBySessionId.set(worker.sessionId, worker);
    for (const connection of worker.connections) {
      this.rememberSessionSelection(connection, selector);
    }
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
    const resumeTurn = Boolean(worker.turnActive || worker.isCompacting);
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
    if (!selector.sessionFile) return;

    const replacement = this.createWorker();
    this.setWorkerSessionRefs(replacement, selector);
    for (const connection of liveConnections) {
      this.attachWorker(connection, replacement);
    }

    void (async () => {
      try {
        await this.sendInternalCommand(
          replacement,
          createSwitchSessionCommand(selector.sessionFile),
        );
        if (resumeTurn) {
          await this.sendInternalCommand(replacement, {
            type: "resume_interrupted_turn",
            source: "worker-exit",
          });
        }
        for (const connection of liveConnections) {
          writeLine(connection.socket, {
            type: "session_recovered",
            sessionFile: selector.sessionFile,
            sessionId: selector.sessionId,
            resumed: resumeTurn,
          });
        }
      } catch {
        this.destroyWorker(replacement);
      }
    })().catch(() => {});
  }

  private getInternalCommandTimeoutMs(command: any) {
    const commandType = String(command?.type || "unknown");
    if (commandType === "switch_session") {
      return this.switchSessionCommandTimeoutMs;
    }
    return this.internalCommandTimeoutMs;
  }

  private async sendInternalCommand(worker: WorkerHandle, command: any) {
    const id = `rin_internal_${++this.internalRequestSeq}`;
    return await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.pendingResponses.delete(id);
        worker.ignoredResponseIds.add(id);
        this.maybeReleaseWorker(worker);
        reject(
          new Error(
            `rin_internal_timeout:${String(command?.type || "unknown")}`,
          ),
        );
      }, this.getInternalCommandTimeoutMs(command));
      timeout.unref?.();

      const finalize = () => clearTimeout(timeout);
      worker.pendingResponses.set(id, {
        id,
        commandType: String(command?.type || "unknown"),
        resolve,
        reject,
        finalize,
      });
      try {
        worker.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      } catch (error: any) {
        worker.pendingResponses.delete(id);
        worker.ignoredResponseIds.add(id);
        finalize();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
