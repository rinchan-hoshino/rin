#!/usr/bin/env node
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ensureDir } from "../platform/fs.js";
import {
  createConnectedRpcSocketPair,
  type RpcSocketConnector,
  type RpcSocketLike,
} from "../platform/rpc-socket.js";
import {
  bridgeDaemonSocketPath,
  defaultDaemonSocketPath,
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
  getRuntimeSessionDir,
} from "../rin-lib/runtime.js";
import { renameBoundSession } from "../session/factory.js";
import { getWebSearchStatus } from "../rin-web-search/service.js";
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
import {
  initializeTerminalTurnStateBaseline,
  listContinuableInterruptedTurnSessionFiles,
} from "../session/turn-state.js";
import { ConnectionState, WorkerPool } from "./worker-pool.js";

function writeLine(socket: RpcSocketLike, payload: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
}

function restartStatePath(agentDir: string) {
  return path.join(agentDir, "data", "restart.json");
}

function turnStateBaselinePath(agentDir: string) {
  return path.join(agentDir, "data", "turn-state-terminal-baseline.json");
}

function clearLegacyRestartState(agentDir: string) {
  try {
    fs.rmSync(restartStatePath(agentDir), { force: true });
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
  } = {},
) {
  const socketPath =
    options.socketPath || process.argv[2] || defaultDaemonSocketPath();
  const bridgeSocketPath = bridgeDaemonSocketPath(
    process.env.RIN_DIR || resolveRuntimeProfile().agentDir,
  );
  const workerPath =
    options.workerPath ||
    process.env.RIN_WORKER_PATH ||
    path.join(path.dirname(new URL(import.meta.url).pathname), "worker.js");
  const runtime = resolveRuntimeProfile();
  applyRuntimeProfileEnvironment(runtime);
  const sessionManagerModulePromise = loadRinSessionManagerModule();
  const workerPool = new WorkerPool({
    workerPath,
    cwd: runtime.cwd,
    gcIdleMs: Number(process.env.RIN_WORKER_GC_IDLE_MS || 30_000),
    sweepIntervalMs: Number(process.env.RIN_WORKER_GC_SWEEP_MS || 5_000),
    onWorkerSpawn: (requester, worker) => {
      if (requester)
        writeLine(requester.socket, {
          type: "ui",
          name: "worker_spawned",
          payload: { pid: worker.child.pid ?? null },
        });
    },
  });

  const cronScheduler = new CronScheduler({
    agentDir: runtime.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
    chat: options.chat,
  });
  cronScheduler.start();

  for (const candidate of [socketPath, bridgeSocketPath]) {
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
      data: { entries: [], tree: [], leafId: null },
    }),
    get_commands: async () => ({
      data: {
        commands: await listCatalogCommands(catalogOptions),
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
  };

  const cronCommandHandlers: Partial<
    Record<RinRpcCommandType, DaemonCommandHandler>
  > = {
    cron_list_tasks: () => ({ data: { tasks: cronScheduler.listTasks() } }),
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

    if (type === "get_state" && !selectorPresent && !selectedSessionPresent) {
      const worker = workerPool.ensureAttachedWorker(connection);
      workerPool.forwardToWorker(connection, worker, command);
      workerPool.evictDetachedWorkers();
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
      const worker = workerPool.resolveWorkerForCommand(connection, command);
      if (!worker) {
        writeLine(
          connection.socket,
          response(id, type, false, "rin_no_attached_session"),
        );
        return true;
      }
      workerPool.forwardToWorker(connection, worker, command);
      workerPool.evictDetachedWorkers();
      return true;
    }
    if (
      type === "select_session" ||
      type === "switch_session" ||
      type === "attach_session"
    ) {
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
          response(id, type, false, "rin_no_attached_session"),
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
      const worker = connection.attachedWorker;
      if (!worker) {
        writeLine(
          connection.socket,
          response(id, type, false, "rin_no_attached_session"),
        );
        return true;
      }
      workerPool.forwardToWorker(connection, worker, command);
      workerPool.evictDetachedWorkers();
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
    if (type === "rename_session") {
      try {
        const { SessionManager } = await sessionManagerModulePromise;
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
    if (type === "daemon_status") {
      const extraStatus = await options.getExtraStatus?.();
      writeLine(
        connection.socket,
        response(id, type, true, {
          socketPath,
          ...workerPool.getStatusSnapshot(),
          taskCount: cronScheduler.listTasks().length,
          webSearch: getWebSearchStatus(runtime.agentDir),
          ...(extraStatus && typeof extraStatus === "object"
            ? extraStatus
            : {}),
        }),
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

    socket.on("data", (chunk) => {
      connection.clientBuffer += String(chunk);
      while (true) {
        const idx = connection.clientBuffer.indexOf("\n");
        if (idx < 0) break;
        let line = connection.clientBuffer.slice(0, idx);
        connection.clientBuffer = connection.clientBuffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        (async () => {
          let command: any;
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
          writeLine(socket, response(undefined, "unknown", false, error));
        });
      }
    });

    const cleanup = () => {
      workerPool.detachWorker(connection);
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
            if (typeof chmod === "number") {
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

  clearLegacyRestartState(runtime.agentDir);
  const sessionDir = getRuntimeSessionDir(runtime.cwd, runtime.agentDir);
  const terminalBaselineTimestamp = initializeTerminalTurnStateBaseline(
    sessionDir,
    turnStateBaselinePath(runtime.agentDir),
  );
  for (const sessionFile of listContinuableInterruptedTurnSessionFiles(
    sessionDir,
    {
      terminalBaselineTimestamp,
    },
  )) {
    try {
      workerPool.continueInterruptedTurnSessionWorker({
        sessionFile,
        source: "daemon-restart",
      });
    } catch {}
  }

  let shuttingDown = false;
  const shutdownGraceMs = Math.max(
    0,
    Number(process.env.RIN_DAEMON_SHUTDOWN_GRACE_MS || 85_000),
  );
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    cronScheduler.stop();
    workerPool.beginShutdown();
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
      try {
        fs.rmSync(candidate, { force: true });
      } catch {}
    }
    await workerPool.shutdown(shutdownGraceMs);
    await Promise.resolve(options.onShutdown?.()).catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  await startDaemon();
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
