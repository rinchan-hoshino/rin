#!/usr/bin/env node
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { coreDataPath } from "../data-layout.js";
import { ensureDir } from "../platform/fs.js";
import { nowIso } from "../time-utils.js";
import {
  createConnectedRpcSocketPair,
  type RpcSocketConnector,
  type RpcSocketLike,
} from "../platform/rpc-socket.js";
import {
  bridgeDaemonSocketPath,
  defaultDaemonSocketPath,
  isWindowsNamedPipePath,
  safeString,
} from "../rin-lib/common.js";
import type { RinRpcCommandType } from "../rin-lib/rpc-types.js";
import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import {
  emptySessionState,
  isSessionScopedCommand,
  response,
} from "../rin-lib/rpc.js";
import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../rin-lib/profile.js";
import {
  listBoundSessionPage,
  listBoundSessions,
  renameBoundSession,
} from "../session/factory.js";
import { CronScheduler } from "./cron.js";
import {
  getCatalogOAuthState,
  listCatalogAllModels,
  listCatalogCommands,
  listCatalogModels,
} from "./catalog.js";
import {
  hasSessionRef as hasSessionSelector,
  normalizeSessionRef as sessionSelectorFromCommand,
} from "../session/ref.js";
import { startQueuedMemoryWorkerSupervisor } from "../self-improve/async-jobs.js";
import { RinDaemonExtensionManager } from "./extensions.js";
import { acquireDaemonInstanceLock, type DaemonInstanceLock } from "./lock.js";
import { ConnectionState, WorkerPool } from "./worker-pool.js";
import {
  acknowledgeDaemonTurnTerminal,
  closeDaemonTurnLedger,
  daemonTurnTerminalEvent,
  listUnacknowledgedChatTerminals,
} from "./turn-ledger.js";
import {
  createWorkerCgroupIsolation,
  type WorkerCgroupIsolation,
} from "./worker-cgroup-isolation.js";

function writeLine(socket: RpcSocketLike, payload: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
}

const DAEMON_TEARDOWN_TIMEOUT_MS = 2_000;

function legacyRestartStatePath(agentDir: string) {
  return path.join(agentDir, "data", "restart.json");
}

function clearLegacyRestartState(agentDir: string) {
  try {
    fs.rmSync(legacyRestartStatePath(agentDir), { force: true });
  } catch {}
}

export async function startDaemon(
  options: {
    socketPath?: string;
    workerPath?: string;
    additionalExtensionPaths?: string[];
    chat?: {
      send?: (payload: any) => Promise<any>;
      runTurn?: (payload: any) => Promise<any>;
      typing?: (payload: { chatKey?: string }) => Promise<any>;
      react?: (payload: {
        chatKey?: string;
        messageId?: string;
        emoji?: string;
      }) => Promise<any>;
      terminateTurn?: (payload: {
        controllerKey?: string;
        chatKey?: string;
      }) => Promise<any>;
    };
    getExtraStatus?:
      | (() => Promise<Record<string, unknown> | undefined>)
      | (() => Record<string, unknown> | undefined);
    handleLocalCommand?: (command: any) =>
      | Promise<
          | {
              success?: boolean;
              data?: unknown;
              error?: string;
            }
          | undefined
        >
      | {
          success?: boolean;
          data?: unknown;
          error?: string;
        }
      | undefined;
    onShutdown?: () => Promise<void> | void;
    registerLocalFrontendConnector?: (connector: RpcSocketConnector) => void;
    daemonExtensionManager?: RinDaemonExtensionManager;
    instanceLock?: DaemonInstanceLock;
    workerGcIdleMs?: number;
    workerSweepIntervalMs?: number;
    workerCgroupIsolation?: WorkerCgroupIsolation;
  } = {},
) {
  const runtime = resolveRuntimeProfile();
  applyRuntimeProfileEnvironment(runtime);
  const workerCgroupIsolation =
    options.workerCgroupIsolation ||
    createWorkerCgroupIsolation({ warn: (message) => console.warn(message) });
  const socketPath = options.socketPath || defaultDaemonSocketPath();
  const bridgeSocketPath = bridgeDaemonSocketPath(
    process.env.RIN_DIR || runtime.agentDir,
  );
  const workerPath =
    options.workerPath ||
    path.join(path.dirname(new URL(import.meta.url).pathname), "worker.js");
  const instanceLock =
    options.instanceLock ||
    (await acquireDaemonInstanceLock(runtime.agentDir, { socketPath }));
  process.once("exit", () => {
    void instanceLock.release();
  });
  let sessionManagerModulePromise:
    | ReturnType<typeof loadRinSessionManagerModule>
    | undefined;
  const getSessionManagerModule = () => {
    sessionManagerModulePromise ??= loadRinSessionManagerModule();
    return sessionManagerModulePromise;
  };
  const workerPool = new WorkerPool({
    workerPath,
    cwd: runtime.cwd,
    gcIdleMs: options.workerGcIdleMs,
    sweepIntervalMs: options.workerSweepIntervalMs,
    resourceOptionsDir: coreDataPath(runtime.agentDir, "workers", "options"),
    agentDir: runtime.agentDir,
    workerCgroupIsolation,
    onWorkerSpawn: (requester, worker) => {
      if (requester)
        writeLine(requester.socket, {
          type: "ui",
          name: "worker_spawned",
          payload: { pid: worker.child.pid ?? null },
        });
    },
  });
  await workerPool.recoverActiveDaemonTurns();

  const cronScheduler = new CronScheduler({
    agentDir: runtime.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
    chat: options.chat,
  });
  cronScheduler.start();
  const selfImproveMaintenanceSupervisor = startQueuedMemoryWorkerSupervisor(
    runtime.agentDir,
  );

  const daemonExtensionManager =
    options.daemonExtensionManager ||
    new RinDaemonExtensionManager({
      cwd: runtime.cwd,
      agentDir: runtime.agentDir,
      logger: console,
    });
  if (!options.daemonExtensionManager) {
    await daemonExtensionManager.start();
  }

  for (const candidate of [socketPath, bridgeSocketPath]) {
    if (isWindowsNamedPipePath(candidate)) continue;
    try {
      fs.rmSync(candidate, { force: true });
    } catch {}
    ensureDir(path.dirname(candidate));
  }

  type DaemonCommandResult = {
    success?: boolean;
    data?: unknown;
    error?: string;
  };
  type DaemonCommandHandler = (
    command: any,
  ) => Promise<DaemonCommandResult> | DaemonCommandResult;

  const catalogOptions = {
    cwd: runtime.cwd,
    agentDir: runtime.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
  };
  const getSessionSelector = (command: any) =>
    sessionSelectorFromCommand(command);
  const commandHasSessionSelector = (command: any) =>
    hasSessionSelector(getSessionSelector(command));
  const hasSelectedSession = (connection: ConnectionState) =>
    workerPool.hasSelectedSession(connection);
  const canHandleWithoutSession = (
    connection: ConnectionState,
    selectorPresent: boolean,
    selectedSessionPresent: boolean,
  ) =>
    !connection.attachedWorker && !selectorPresent && !selectedSessionPresent;
  const taskIdFromCommand = (command: any) =>
    String(command.taskId || "").trim();
  const sendCommandResult = (
    connection: ConnectionState,
    id: string | undefined,
    type: RinRpcCommandType | "unknown",
    result: DaemonCommandResult,
  ) => {
    const success = result.success !== false;
    writeLine(
      connection.socket,
      response(
        id,
        type,
        success,
        success ? result.data : String(result.error || "daemon_command_failed"),
      ),
    );
  };

  const sessionlessCommandHandlers: Partial<
    Record<RinRpcCommandType, DaemonCommandHandler>
  > = {
    get_messages: () => ({ data: { messages: [] } }),
    get_session_snapshot: () => ({
      data: { entries: [], leafId: null },
    }),
    get_commands: async (command) => ({
      data: {
        commands: await listCatalogCommands({
          ...catalogOptions,
          ...(command.resourceOptions || {}),
        }),
      },
    }),
    get_all_models: async () => ({
      data: {
        models: await listCatalogAllModels(catalogOptions),
      },
    }),
    get_available_models: async () => ({
      data: {
        models: await listCatalogModels(catalogOptions),
      },
    }),
    get_oauth_state: async () => ({
      data: await getCatalogOAuthState(catalogOptions),
    }),
    memory_search_external: async (command) => ({
      data: {
        results: await daemonExtensionManager.recallProviders(
          command.payload || {},
        ),
      },
    }),
    memory_write_external: async (command) => ({
      data: await daemonExtensionManager.writeMemoryProviders(
        command.payload || {},
      ),
    }),
  };

  const cronCommandHandlers: Partial<
    Record<RinRpcCommandType, DaemonCommandHandler>
  > = {
    cron_list_tasks: () => ({ data: { tasks: cronScheduler.listTasks() } }),
    cron_reload_tasks: () => ({ data: { cron: cronScheduler.reloadTasks() } }),
    cron_get_task: (command) => {
      const task = cronScheduler.getTask(taskIdFromCommand(command));
      return task
        ? { data: { task } }
        : { success: false, error: "cron_task_not_found" };
    },
    cron_upsert_task: (command) => ({
      data: {
        task: cronScheduler.upsertTask(
          command.task || {},
          command.defaults || {},
        ),
      },
    }),
    cron_delete_task: (command) => {
      const ok = cronScheduler.deleteTask(taskIdFromCommand(command));
      return ok
        ? { data: { deleted: true } }
        : { success: false, error: "cron_task_not_found" };
    },
    cron_complete_task: (command) => ({
      data: {
        task: cronScheduler.completeTask(
          taskIdFromCommand(command),
          String(command.reason || "completed_by_tool"),
        ),
      },
    }),
    cron_pause_task: (command) => ({
      data: {
        task: cronScheduler.pauseTask(taskIdFromCommand(command)),
      },
    }),
    cron_resume_task: (command) => ({
      data: {
        task: cronScheduler.resumeTask(taskIdFromCommand(command)),
      },
    }),
    cron_reschedule_once_task: (command) => ({
      data: {
        task: cronScheduler.rescheduleOneTimeTask(
          taskIdFromCommand(command),
          String(command.runAt || ""),
        ),
      },
    }),
    cron_run_task: (command) => ({
      data: {
        task: cronScheduler.runTaskNow(taskIdFromCommand(command)),
      },
    }),
    cron_wake_task: (command) => ({
      data: {
        task: cronScheduler.wakeTaskNow(taskIdFromCommand(command)),
      },
    }),
  };

  const selfHandleCommand = async (
    connection: ConnectionState,
    command: any,
  ) => {
    const id = command?.id;
    const type = String(command?.type || "unknown") as
      | RinRpcCommandType
      | "unknown";
    const selectorPresent = commandHasSessionSelector(command);
    const selectedSessionPresent = hasSelectedSession(connection);
    if (
      command?.resourceOptions &&
      typeof command.resourceOptions === "object"
    ) {
      connection.resourceOptions = command.resourceOptions;
    }

    if (type === "get_state" && !selectorPresent && !selectedSessionPresent) {
      writeLine(
        connection.socket,
        response(id, type, true, emptySessionState()),
      );
      return true;
    }

    const sessionlessHandler = canHandleWithoutSession(
      connection,
      selectorPresent,
      selectedSessionPresent,
    )
      ? sessionlessCommandHandlers[type as RinRpcCommandType]
      : undefined;
    if (sessionlessHandler) {
      sendCommandResult(
        connection,
        id,
        type,
        await sessionlessHandler(command),
      );
      return true;
    }
    if (type === "new_session") {
      const previousWorker = workerPool.resolveCurrentWorkerForCommand(
        connection,
        command,
      );
      let worker: ReturnType<typeof workerPool.resolveWorkerForCommand>;
      try {
        if (previousWorker) await workerPool.abortWorker(previousWorker);
        if (previousWorker === connection.attachedWorker) {
          workerPool.detachWorker(connection, { release: false });
        }
        worker = workerPool.resolveWorkerForCommand(connection, command);
        if (!worker) {
          writeLine(
            connection.socket,
            response(id, type, false, "rin_no_attached_session"),
          );
          return true;
        }
        const state = await workerPool.readWorkerState(worker);
        workerPool.attachWorkerToConnection(connection, worker);
        writeLine(
          connection.socket,
          response(id, type, true, {
            cancelled: false,
            sessionFile: state.sessionFile || worker.sessionFile,
            sessionId: state.sessionId || worker.sessionId,
          }),
        );
        if (previousWorker) {
          void workerPool.terminateWorkerGracefullyIfUnattached(previousWorker);
        }
      } catch (error: any) {
        if (worker) workerPool.destroyWorker(worker);
        if (previousWorker)
          workerPool.attachWorkerToConnection(connection, previousWorker);
        writeLine(
          connection.socket,
          response(
            id,
            type,
            false,
            String(error?.message || error || "rin_worker_state_unavailable"),
          ),
        );
      }
      workerPool.evictDetachedWorkers();
      return true;
    }
    if (type === "switch_session") {
      const selector = getSessionSelector(command);
      if (!selector.sessionFile && !selector.sessionId) {
        writeLine(
          connection.socket,
          response(id, type, false, "rin_no_attached_session"),
        );
        return true;
      }
      const worker = await workerPool.selectSession(connection, selector);
      if (!worker) {
        writeLine(
          connection.socket,
          response(id, type, false, "rin_no_attached_session"),
        );
        return true;
      }
      writeLine(
        connection.socket,
        response(id, type, true, {
          cancelled: false,
          sessionFile: worker.sessionFile || selector.sessionFile,
          sessionId: worker.sessionId || selector.sessionId,
        }),
      );
      workerPool.evictDetachedWorkers();
      return true;
    }
    if (type === "select_session" || type === "attach_session") {
      const selector = getSessionSelector(command);
      if (!selector.sessionFile && !selector.sessionId) {
        writeLine(
          connection.socket,
          response(id, type, false, "rin_no_attached_session"),
        );
        return true;
      }
      const worker = await workerPool.selectSession(connection, selector);
      if (!worker) {
        writeLine(
          connection.socket,
          response(id, type, false, "rin_no_attached_session"),
        );
        return true;
      }
      writeLine(
        connection.socket,
        response(id, type, true, { cancelled: false }),
      );
      workerPool.evictDetachedWorkers();
      return true;
    }
    if (type === "terminate_session") {
      const target =
        workerPool.resolveWorkerForCommand(connection, command) ||
        connection.attachedWorker;
      if (!target) {
        writeLine(
          connection.socket,
          response(id, type, true, { terminated: false }),
        );
        return true;
      }
      if (target === connection.attachedWorker) {
        workerPool.detachWorker(connection, { clearSelection: true });
      }
      workerPool.terminateWorkerGracefully(target);
      writeLine(
        connection.socket,
        response(id, type, true, { terminated: true }),
      );
      return true;
    }
    if (type === "list_sessions") {
      const hasPagination =
        command.limit !== undefined || command.offset !== undefined;
      if (hasPagination) {
        writeLine(
          connection.socket,
          response(
            id,
            type,
            true,
            await listBoundSessionPage({
              cwd: runtime.cwd,
              agentDir: runtime.agentDir,
              limit: command.limit,
              offset: command.offset,
            }),
          ),
        );
        return true;
      }

      writeLine(
        connection.socket,
        response(id, type, true, {
          sessions: await listBoundSessions({
            cwd: runtime.cwd,
            agentDir: runtime.agentDir,
          }),
        }),
      );
      return true;
    }
    if (type === "detach_session") {
      workerPool.detachWorker(connection, { clearSelection: true });
      writeLine(
        connection.socket,
        response(id, type, true, emptySessionState()),
      );
      return true;
    }
    if (type === "await_turn_terminal") {
      const terminal = await workerPool.awaitTerminalTurnEvent(
        connection,
        getSessionSelector(command),
        typeof command.requestTag === "string" ? command.requestTag : undefined,
      );
      writeLine(connection.socket, response(id, type, true, terminal));
      return true;
    }
    if (type === "ack_turn_terminal") {
      const terminal = acknowledgeDaemonTurnTerminal(runtime.agentDir, {
        requestTag: safeString(command.requestTag).trim(),
        terminalId: safeString(command.terminalId).trim(),
      });
      writeLine(connection.socket, response(id, type, true, terminal));
      return true;
    }
    if (type === "list_unacknowledged_chat_terminals") {
      const records = listUnacknowledgedChatTerminals(
        runtime.agentDir,
        safeString(command.chatKey).trim() || undefined,
      );
      writeLine(
        connection.socket,
        response(id, type, true, {
          terminals: records.map(daemonTurnTerminalEvent),
        }),
      );
      return true;
    }
    if (type === "rename_session") {
      try {
        const { SessionManager } = await getSessionManagerModule();
        await renameBoundSession(command, command.name, {
          SessionManager,
        });
        writeLine(connection.socket, response(id, type, true));
      } catch (error: any) {
        writeLine(
          connection.socket,
          response(
            id,
            type,
            false,
            String(error?.message || "Session name cannot be empty"),
          ),
        );
      }
      return true;
    }
    if (type === "daemon_status" || type === "daemon_activity") {
      const extraStatus = await options.getExtraStatus?.();
      const workerStatus = workerPool.getStatusSnapshot();
      const cronStatus = cronScheduler.getStatusSnapshot();
      const activity = {
        schemaVersion: 1,
        generatedAt: nowIso(),
        socketPath,
        ...workerStatus,
        cron: cronStatus,
        taskCount: cronStatus.taskCount,
      };
      writeLine(
        connection.socket,
        response(
          id,
          type,
          true,
          type === "daemon_activity"
            ? activity
            : {
                ...activity,
                ...(extraStatus && typeof extraStatus === "object"
                  ? extraStatus
                  : {}),
              },
        ),
      );
      return true;
    }
    const cronHandler = cronCommandHandlers[type as RinRpcCommandType];
    if (cronHandler) {
      sendCommandResult(connection, id, type, await cronHandler(command));
      return true;
    }
    const localResult = await options.handleLocalCommand?.(command);
    if (localResult) {
      sendCommandResult(connection, id, type, localResult);
      return true;
    }
    return false;
  };

  clearLegacyRestartState(runtime.agentDir);

  const activeSockets = new Set<RpcSocketLike>();

  const attachConnectionSocket = (socket: RpcSocketLike) => {
    activeSockets.add(socket);
    const dropSocket = () => activeSockets.delete(socket);
    socket.once("close", dropSocket);
    socket.once("error", dropSocket);

    const connection: ConnectionState = {
      socket,
      clientBuffer: "",
    };
    workerPool.registerConnection(connection);

    socket.on("data", (chunk) => {
      connection.clientBuffer += String(chunk);
      while (true) {
        const idx = connection.clientBuffer.indexOf("\n");
        if (idx < 0) break;
        let line = connection.clientBuffer.slice(0, idx);
        connection.clientBuffer = connection.clientBuffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let command: any;
        (async () => {
          try {
            command = JSON.parse(line);
          } catch {
            writeLine(
              socket,
              response(undefined, "unknown", false, "invalid_json"),
            );
            return;
          }

          if (await selfHandleCommand(connection, command)) {
            workerPool.evictDetachedWorkers();
            return;
          }

          let worker = workerPool.resolveWorkerForCommand(connection, command);
          if (
            !worker &&
            isSessionScopedCommand(String(command?.type || "unknown")) &&
            (commandHasSessionSelector(command) ||
              hasSelectedSession(connection))
          ) {
            worker = await workerPool.ensureSelectedWorker(
              connection,
              getSessionSelector(command),
            );
          }
          if (!worker) {
            writeLine(
              socket,
              response(
                command?.id,
                String(command?.type || "unknown"),
                false,
                "rin_no_attached_session",
              ),
            );
            return;
          }

          workerPool.forwardToWorker(connection, worker, command);
          workerPool.evictDetachedWorkers();
        })().catch((error) => {
          writeLine(
            socket,
            response(
              command?.id,
              String(command?.type || "unknown"),
              false,
              error,
            ),
          );
        });
      }
    });

    const cleanup = () => {
      workerPool.unregisterConnection(connection);
      workerPool.detachWorker(connection, { clearSelection: true });
      workerPool.evictDetachedWorkers();
    };

    socket.on("close", cleanup);
    socket.on("error", cleanup);
  };

  options.registerLocalFrontendConnector?.(() => {
    const { clientSocket, serverSocket } = createConnectedRpcSocketPair();
    attachConnectionSocket(serverSocket);
    return clientSocket;
  });

  const createSocketServer = () =>
    net.createServer((socket) => {
      attachConnectionSocket(socket);
    });

  const servers = [
    { server: createSocketServer(), path: socketPath, chmod: null },
    { server: createSocketServer(), path: bridgeSocketPath, chmod: 0o666 },
  ];

  await Promise.all(
    servers.map(
      ({ server, path: listenPath, chmod }) =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(listenPath, () => {
            server.removeListener("error", reject);
            if (
              typeof chmod === "number" &&
              !isWindowsNamedPipePath(listenPath)
            ) {
              try {
                fs.chmodSync(listenPath, chmod);
              } catch {}
            }
            resolve();
          });
        }),
    ),
  );

  console.log(`rin daemon listening on ${socketPath}`);
  console.log(`rin daemon bridge listening on ${bridgeSocketPath}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    selfImproveMaintenanceSupervisor.stop();
    cronScheduler.stop();
    workerPool.destroyAll();
    const teardownDeadline = Date.now() + DAEMON_TEARDOWN_TIMEOUT_MS;
    const settleLocalTeardown = async (
      task: () => unknown | Promise<unknown>,
    ) => {
      const remainingMs = Math.max(0, teardownDeadline - Date.now());
      if (remainingMs === 0) return;
      await Promise.race([
        Promise.resolve()
          .then(task)
          .catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
      ]);
    };
    await settleLocalTeardown(() => options.onShutdown?.());
    await settleLocalTeardown(() => daemonExtensionManager.stop());
    closeDaemonTurnLedger(runtime.agentDir);
    for (const socket of Array.from(activeSockets)) {
      try {
        socket.destroy();
      } catch {}
    }
    await Promise.all(
      servers.map(
        ({ server }) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    for (const candidate of [socketPath, bridgeSocketPath]) {
      if (isWindowsNamedPipePath(candidate)) continue;
      try {
        fs.rmSync(candidate, { force: true });
      } catch {}
    }
    await instanceLock.release().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseDaemonCliArgs(argv: string[]) {
  let socketPath = "";
  let workerPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "").trim();
    if (!arg) continue;
    if (arg === "--socket") {
      socketPath = String(argv[++index] || "").trim() || socketPath;
      continue;
    }
    if (arg.startsWith("--socket=")) {
      socketPath = arg.slice("--socket=".length).trim() || socketPath;
      continue;
    }
    if (arg === "--worker") {
      workerPath = String(argv[++index] || "").trim() || workerPath;
      continue;
    }
    if (arg.startsWith("--worker=")) {
      workerPath = arg.slice("--worker=".length).trim() || workerPath;
      continue;
    }
    if (!arg.startsWith("-") && !socketPath) socketPath = arg;
  }
  return {
    socketPath: socketPath || undefined,
    workerPath: workerPath || undefined,
  };
}

async function main() {
  await startDaemon(parseDaemonCliArgs(process.argv.slice(2)));
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    console.error(
      safeString(error && error.message ? error.message : error) ||
        "rin_daemon_failed",
    );
    process.exit(1);
  });
}
