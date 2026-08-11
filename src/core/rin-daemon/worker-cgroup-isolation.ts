import fs from "node:fs";
import path from "node:path";

export const WORKER_CGROUP_DELEGATION_ENV = "RIN_SYSTEMD_CGROUP_DELEGATION";

const CGROUP_ROOT = "/sys/fs/cgroup";
const PROC_ROOT = "/proc";
const WORKER_OOM_SCORE_FLOOR = 500;
const WORKER_OOM_SCORE_OFFSET = 300;
const CLEANUP_ATTEMPTS = 40;
const CLEANUP_DELAY_MS = 25;

export type WorkerCgroupLease = {
  wasOomKilled: () => boolean;
  cleanup: () => Promise<boolean>;
};

export type WorkerCgroupIsolation = {
  attachWorker: (workerId: string, pid: number) => WorkerCgroupLease;
};

type WorkerCgroupIsolationDeps = {
  platform: NodeJS.Platform | string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  pid: number;
  readText: (filePath: string) => string;
  writeText: (filePath: string, value: string) => void;
  mkdir: (filePath: string) => void;
  rmdir: (filePath: string) => void;
  exists: (filePath: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  sleepSync: (ms: number) => void;
  warn?: (message: string) => void;
};

type Warn = (message: string, error?: unknown) => void;

const defaultDeps: WorkerCgroupIsolationDeps = {
  platform: process.platform,
  env: process.env,
  pid: process.pid,
  readText: (filePath) => fs.readFileSync(filePath, "utf8"),
  writeText: (filePath, value) => fs.writeFileSync(filePath, value, "utf8"),
  mkdir: (filePath) => fs.mkdirSync(filePath),
  rmdir: (filePath) => fs.rmdirSync(filePath),
  exists: (filePath) => fs.existsSync(filePath),
  sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  sleepSync: (ms) => {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, ms);
  },
};

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function ensureDirectory(deps: WorkerCgroupIsolationDeps, directory: string) {
  try {
    deps.mkdir(directory);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

function unifiedCgroupPath(contents: string) {
  for (const line of contents.split("\n")) {
    const match = /^0::(\/.+)$/.exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

function parseCounter(contents: string, key: string) {
  for (const line of contents.split("\n")) {
    const [candidate, value] = line.trim().split(/\s+/, 2);
    if (candidate === key) return Number.parseInt(value || "0", 10) || 0;
  }
  return 0;
}

function workerOomScore(daemonScore: number) {
  return Math.min(
    1000,
    Math.max(WORKER_OOM_SCORE_FLOOR, daemonScore + WORKER_OOM_SCORE_OFFSET),
  );
}

function safeWorkerCgroupName(workerId: string, pid: number) {
  return `${workerId.replace(/[^A-Za-z0-9_.-]/g, "_")}-${pid}`;
}

function stopWorkerCgroup(
  deps: WorkerCgroupIsolationDeps,
  workerPath: string,
  warn: Warn,
) {
  try {
    const killPath = path.posix.join(workerPath, "cgroup.kill");
    if (deps.exists(killPath)) deps.writeText(killPath, "1\n");
  } catch (error) {
    warn("Rin could not stop every process in a worker cgroup", error);
  }
}

function tryRemoveWorkerCgroup(
  deps: WorkerCgroupIsolationDeps,
  workerPath: string,
  warn: Warn,
) {
  try {
    const populated = parseCounter(
      deps.readText(path.posix.join(workerPath, "cgroup.events")),
      "populated",
    );
    if (populated !== 0) return false;
    deps.rmdir(workerPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    if (errorCode(error) === "EBUSY" || errorCode(error) === "ENOTEMPTY") {
      return false;
    }
    warn("Rin could not remove a worker cgroup", error);
    return undefined;
  }
}

function cleanupWorkerCgroupSync(
  deps: WorkerCgroupIsolationDeps,
  workerPath: string,
  warn: Warn,
) {
  stopWorkerCgroup(deps, workerPath, warn);
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    const removed = tryRemoveWorkerCgroup(deps, workerPath, warn);
    if (removed === true) return true;
    if (removed === undefined) return false;
    deps.sleepSync(CLEANUP_DELAY_MS);
  }
  warn("Rin worker cgroup remained populated after cleanup");
  return false;
}

async function cleanupWorkerCgroup(
  deps: WorkerCgroupIsolationDeps,
  workerPath: string,
  warn: Warn,
) {
  stopWorkerCgroup(deps, workerPath, warn);
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    const removed = tryRemoveWorkerCgroup(deps, workerPath, warn);
    if (removed === true) return true;
    if (removed === undefined) return false;
    await deps.sleep(CLEANUP_DELAY_MS);
  }
  warn("Rin worker cgroup remained populated after cleanup");
  return false;
}

export function createWorkerCgroupIsolation(
  overrides: Partial<WorkerCgroupIsolationDeps> = {},
): WorkerCgroupIsolation | undefined {
  const deps = { ...defaultDeps, ...overrides };
  if (
    deps.platform !== "linux" ||
    deps.env[WORKER_CGROUP_DELEGATION_ENV] !== "1"
  ) {
    return undefined;
  }

  const warn: Warn = (message, error) => {
    deps.warn?.(
      error == null
        ? message
        : `${message}: ${String(
            error instanceof Error ? error.message : error,
          )}`,
    );
  };

  try {
    const currentPath = unifiedCgroupPath(
      deps.readText(path.posix.join(PROC_ROOT, "self", "cgroup")),
    );
    if (!currentPath) throw new Error("unified cgroup path is missing");

    let servicePath = currentPath;
    if (path.posix.basename(currentPath) === "daemon") {
      servicePath = path.posix.dirname(currentPath);
    } else if (!path.posix.basename(currentPath).endsWith(".service")) {
      throw new Error("daemon is not at the service cgroup root");
    } else {
      const daemonPath = path.posix.join(CGROUP_ROOT, servicePath, "daemon");
      ensureDirectory(deps, daemonPath);
      deps.writeText(
        path.posix.join(daemonPath, "cgroup.procs"),
        `${deps.pid}\n`,
      );
    }

    const serviceRoot = path.posix.join(CGROUP_ROOT, servicePath);
    const controllers = new Set(
      deps
        .readText(path.posix.join(serviceRoot, "cgroup.controllers"))
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    );
    if (!controllers.has("memory")) {
      throw new Error("memory controller is not delegated");
    }
    deps.writeText(
      path.posix.join(serviceRoot, "cgroup.subtree_control"),
      "+memory\n",
    );

    const workersRoot = path.posix.join(serviceRoot, "workers");
    ensureDirectory(deps, workersRoot);
    deps.writeText(
      path.posix.join(workersRoot, "cgroup.subtree_control"),
      "+memory\n",
    );

    const daemonOomScore = Number.parseInt(
      deps.readText(path.posix.join(PROC_ROOT, "self", "oom_score_adj")).trim(),
      10,
    );
    const normalizedDaemonScore = Number.isFinite(daemonOomScore)
      ? daemonOomScore
      : 0;
    const adjustedWorkerScore = workerOomScore(normalizedDaemonScore);
    if (adjustedWorkerScore <= normalizedDaemonScore) {
      warn("Rin worker OOM preference cannot exceed the daemon OOM preference");
    }

    return {
      attachWorker(workerId, pid) {
        const workerPath = path.posix.join(
          workersRoot,
          safeWorkerCgroupName(workerId, pid),
        );
        try {
          deps.mkdir(workerPath);
          deps.writeText(
            path.posix.join(workerPath, "memory.oom.group"),
            "1\n",
          );
          deps.writeText(
            path.posix.join(workerPath, "cgroup.procs"),
            `${pid}\n`,
          );
          deps.writeText(
            path.posix.join(PROC_ROOT, String(pid), "oom_score_adj"),
            `${adjustedWorkerScore}\n`,
          );
        } catch (error) {
          const cleanupComplete = cleanupWorkerCgroupSync(
            deps,
            workerPath,
            warn,
          );
          throw new Error(
            cleanupComplete
              ? `Rin could not attach worker ${workerId} to its cgroup`
              : `Rin could not attach or clean up worker ${workerId}`,
            { cause: error },
          );
        }

        return {
          wasOomKilled() {
            try {
              return (
                parseCounter(
                  deps.readText(
                    path.posix.join(workerPath, "memory.events.local"),
                  ),
                  "oom_kill",
                ) > 0
              );
            } catch {
              return false;
            }
          },
          async cleanup() {
            return await cleanupWorkerCgroup(deps, workerPath, warn);
          },
        };
      },
    };
  } catch (error) {
    throw new Error("Rin could not initialize worker cgroup isolation", {
      cause: error,
    });
  }
}
