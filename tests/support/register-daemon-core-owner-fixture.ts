import { register } from "node:module";

const replacements: Record<string, string> = {
  "dist/core/rin-lib/profile.js": `
    export function resolveRuntimeProfile() {
      return { cwd: process.env.RIN_TEST_DAEMON_CWD, agentDir: process.env.RIN_DIR };
    }
    export function applyRuntimeProfileEnvironment() {}
    export function getRuntimeSessionDir(cwd, agentDir) { return agentDir + "/sessions"; }
  `,
  "dist/core/rin-lib/loader.js": `
    export async function loadRinSessionManagerModule() {
      return { SessionManager: { owner: true } };
    }
  `,
  "dist/core/session/factory.js": `
    export async function openBoundSession() {
      return {
        session: {
          agent: { async waitForIdle() {} },
          async prompt() {},
          getLastAssistantText() { return "owner-session"; },
          async abort() {},
        },
        runtime: { async dispose() {} },
      };
    }
    export async function listBoundSessionPage(options) {
      if (options.limit === 99) throw "owner list page failure";
      if (options.limit === 98) throw new Error("owner list error");
      return { sessions: [{ page: true }], limit: options.limit, offset: options.offset };
    }
    export async function listBoundSessions() {
      return [{ all: true }];
    }
    export async function renameBoundSession(command, name) {
      if (!String(name || "").trim()) throw new Error("owner rename rejected");
    }
  `,
  "dist/core/rin-daemon/cron.js": `
    export class CronScheduler {
      constructor(options) { this.options = options; this.tasks = new Map([["owner-task", { id: "owner-task" }]]); }
      start() {}
      stop() {}
      listTasks() { return [...this.tasks.values()]; }
      reloadTasks() { return { reloaded: true }; }
      getTask(id) { return this.tasks.get(id); }
      upsertTask(task, defaults) { const next = { ...defaults, ...task, id: task.id || "upserted" }; this.tasks.set(next.id, next); return next; }
      deleteTask(id) { return this.tasks.delete(id); }
      completeTask(id, reason) { return { id, reason, state: "completed" }; }
      pauseTask(id) { return { id, state: "paused" }; }
      resumeTask(id) { return { id, state: "active" }; }
      rescheduleOneTimeTask(id, runAt) { return { id, runAt }; }
      runTaskNow(id) { return { id, run: true }; }
      wakeTaskNow(id) { return { id, wake: true }; }
      getStatusSnapshot() { return { taskCount: this.tasks.size, running: 1 }; }
    }
  `,
  "dist/core/rin-daemon/catalog.js": `
    export async function listCatalogCommands(options) { return [{ name: "owner", options }]; }
    export async function listCatalogAllModels() { return [{ id: "all-owner" }]; }
    export async function listCatalogModels() { return [{ id: "available-owner" }]; }
    export async function getCatalogOAuthState() { return { owner: true }; }
  `,
  "dist/core/rin-daemon/extensions.js": `
    export class RinDaemonExtensionManager {
      constructor(options) { this.options = options; }
      async start() { if (process.env.RIN_TEST_DAEMON_MANAGER_START_FAIL) throw new Error("owner manager start failed"); }
      async stop() { if (process.env.RIN_TEST_DAEMON_MANAGER_STOP_FAIL) throw new Error("owner manager stop failed"); }
      async recallProviders(payload) { return [{ recalled: payload }]; }
      async writeMemoryProviders(payload) { return { written: payload }; }
    }
  `,
  "dist/core/rin-daemon/running-workers.js": `
    export function listRunningWorkerSessions() {
      return [{ sessionId: "continued" }, { sessionId: "continue-fails" }];
    }
  `,
  "dist/core/rin-daemon/lock.js": `
    export async function acquireDaemonInstanceLock(agentDir, options) {
      if (process.env.RIN_TEST_DAEMON_LOCK_FAIL) throw new Error("owner lock failed");
      return { async release() {} };
    }
  `,
  "dist/core/rin-daemon/worker-cgroup-isolation.js": `
    export function createWorkerCgroupIsolation(options) { options.warn("owner isolation warning"); return { owner: true }; }
  `,
  "dist/core/rin-daemon/worker-pool.js": `
    const makeWorker = (suffix = "owner") => ({
      sessionFile: "/sessions/" + suffix + ".jsonl",
      sessionId: suffix,
      child: { pid: 4242 },
      attachments: new Set(),
    });
    export class WorkerPool {
      constructor(options) {
        this.options = options;
        this.worker = makeWorker();
        this.previous = makeWorker("previous");
        options.onWorkerSpawn(null, this.worker);
        options.onWorkerSpawn({ socket: { destroyed: true, write() {} } }, this.worker);
      }
      registerConnection(connection) { this.connection = connection; }
      unregisterConnection(connection) { if (this.connection === connection) this.connection = undefined; }
      hasSelectedSession(connection) { return Boolean(connection.selectedSession); }
      resolveCurrentWorkerForCommand(connection, command) {
        this.abortCompleted = false;
        this.failAbort = Boolean(command.failAbort);
        return command.previous === false ? undefined : connection.attachedWorker;
      }
      async abortWorker(worker) {
        if (this.failAbort) throw new Error("owner abort failed");
        this.abortedWorker = worker;
        this.abortCompleted = true;
      }
      detachWorker(connection, options = {}) {
        connection.attachedWorker = undefined;
        if (options.clearSelection) connection.selectedSession = undefined;
      }
      resolveWorkerForCommand(connection, command) {
        if (command.requireAbort && !this.abortCompleted) throw new Error("new_session_did_not_abort_previous");
        if (command.failState) this.failNextState = true;
        if (command.stateEmpty) this.worker.stateEmpty = true;
        else this.worker.stateEmpty = false;
        if (command.noWorker) return undefined;
        if (command.usePrevious) return this.previous;
        return connection.attachedWorker || (command.createWorker ? this.worker : undefined);
      }
      async readWorkerState(worker) {
        if (this.failNextState) { this.failNextState = false; throw new Error("owner worker state failed"); }
        return { sessionFile: worker.stateEmpty ? "" : worker.sessionFile, sessionId: worker.stateEmpty ? "" : worker.sessionId };
      }
      attachWorkerToConnection(connection, worker) { connection.attachedWorker = worker; connection.selectedSession = { sessionFile: worker.sessionFile, sessionId: worker.sessionId }; }
      terminateWorkerGracefullyIfUnattached() { return Promise.resolve(); }
      async recoverActiveDaemonTurns() {}
      destroyWorker() {}
      evictDetachedWorkers() {}
      async selectSession(connection, selector) {
        if (selector.sessionId === "missing" || selector.sessionFile === "missing") return undefined;
        const worker = makeWorker(selector.sessionId || "selected-file");
        if (selector.sessionId === "empty-state") { worker.sessionFile = ""; worker.sessionId = ""; }
        this.attachWorkerToConnection(connection, worker);
        return worker;
      }
      terminateWorkerGracefully() {}
      replayPendingTerminalTurnEvent(connection, selector) { return Boolean(selector.sessionFile || selector.sessionId); }
      async awaitTerminalTurnEvent(connection, selector, requestTag) { return { sessionFile: selector.sessionFile || "", sessionId: selector.sessionId || "", requestTag: requestTag || null }; }
      getStatusSnapshot() { return { workerCount: 2, busyWorkerCount: 1 }; }
      continueInterruptedTurnSessionWorker(session) { if (session.sessionId === "continue-fails") throw new Error("continue failed"); }
      async ensureSelectedWorker(connection, selector) {
        if (selector.sessionId === "ensure-missing") return undefined;
        const worker = makeWorker(selector.sessionId || "ensured");
        this.attachWorkerToConnection(connection, worker);
        return worker;
      }
      forwardToWorker(connection, worker, command) {
        connection.socket.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { forwarded: true, sessionId: worker.sessionId } }) + "\\n");
      }
      resumeInterruptedTurnSession(payload) { return { resumed: payload }; }
      beginShutdown() {}
      destroyAll() { this.beginShutdown(); }
      get failState() { return this.failNextState; }
      set failState(value) { this.failNextState = value; }
    }
  `,
};

const replacementUrls = Object.fromEntries(
  Object.entries(replacements).map(([target, source]) => [
    target,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hookSource = `
const replacements = ${JSON.stringify(replacementUrls)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  for (const [target, replacementUrl] of Object.entries(replacements)) {
    if (resolved.url.endsWith(target)) return { url: replacementUrl, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
