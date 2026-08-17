import fs from "node:fs";
import os from "node:os";

import { sleep } from "../platform/process.js";
import { safeString } from "../text-utils.js";

export type PreparedChatKeyWorkerJob = {
  run: () => Promise<void>;
};

export type ChatKeyWorkerPool<T> = {
  enqueue: (chatKey: string, payload: T) => void;
  hasWorker: (chatKey: string) => boolean;
};

type ChatKeyWorkerPrepareResult =
  | { prepared: PreparedChatKeyWorkerJob; error?: never }
  | { prepared?: never; error: unknown };

type ChatKeyWorkerEntry<T> = {
  payload: T;
  prepared: Promise<ChatKeyWorkerPrepareResult>;
};

type ChatKeyWorker<T> = {
  queue: ChatKeyWorkerEntry<T>[];
  pumping: boolean;
  activeTasks: Set<Promise<void>>;
};

const MIB = 1024 * 1024;
export const STARTUP_RECOVERY_MEMORY_RESERVE_BYTES = 2 * 1024 * MIB;
const STARTUP_RECOVERY_BASE_MEMORY_BYTES = 512 * MIB;
const STARTUP_RECOVERY_SESSION_SIZE_MULTIPLIER = 2;

export function estimateStartupRecoveryMemoryBytes(sessionFileBytes: number) {
  const bytes = Number.isFinite(sessionFileBytes)
    ? Math.max(0, sessionFileBytes)
    : 0;
  return (
    STARTUP_RECOVERY_BASE_MEMORY_BYTES +
    bytes * STARTUP_RECOVERY_SESSION_SIZE_MULTIPLIER
  );
}

export function readSystemAvailableMemoryBytes(
  deps: {
    readMeminfo?: () => string;
    fallbackAvailableBytes?: () => number;
  } = {},
) {
  try {
    const meminfo = (
      deps.readMeminfo || (() => fs.readFileSync("/proc/meminfo", "utf8"))
    )();
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
    if (match) return Number(match[1]) * 1024;
  } catch {}
  const fallback = Number((deps.fallbackAvailableBytes || os.freemem)());
  return Number.isFinite(fallback) ? Math.max(0, fallback) : 0;
}

type StartupRecoveryAdmissionEntry = {
  estimatedBytes: number;
  label: string;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export function createStartupRecoveryAdmission(deps: {
  availableMemoryBytes: () => number;
  reserveBytes?: number;
  logger?: { info?: (...args: any[]) => void };
}) {
  const queue: StartupRecoveryAdmissionEntry[] = [];
  const reserveBytes = Number.isFinite(deps.reserveBytes)
    ? Math.max(0, Number(deps.reserveBytes))
    : STARTUP_RECOVERY_MEMORY_RESERVE_BYTES;
  let activeEstimatedBytes = 0;
  let activeOpenCount = 0;
  let pumpScheduled = false;

  const availableMemoryBytes = () => {
    try {
      const value = Number(deps.availableMemoryBytes());
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    } catch {
      return 0;
    }
  };

  const schedulePump = () => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      while (queue.length) {
        if (activeOpenCount > 0) return;
        const availableBytes = availableMemoryBytes();
        const headroomBytes = Math.max(
          0,
          availableBytes - reserveBytes - activeEstimatedBytes,
        );
        let index = queue.findIndex(
          (entry) => entry.estimatedBytes <= headroomBytes,
        );
        if (index < 0) {
          if (activeEstimatedBytes > 0) return;
          index = 0;
        }
        const entry = queue.splice(index, 1)[0]!;
        activeEstimatedBytes += entry.estimatedBytes;
        activeOpenCount += 1;
        deps.logger?.info?.(
          `chat startup recovery admitted session=${entry.label || "unknown"} estimatedBytes=${entry.estimatedBytes} availableBytes=${availableBytes} activeEstimatedBytes=${activeEstimatedBytes} queued=${queue.length}`,
        );
        void Promise.resolve()
          .then(entry.task)
          .then(entry.resolve, entry.reject)
          .finally(() => {
            activeEstimatedBytes = Math.max(
              0,
              activeEstimatedBytes - entry.estimatedBytes,
            );
            activeOpenCount = Math.max(0, activeOpenCount - 1);
            schedulePump();
          });
      }
    });
  };

  return {
    run<T>(
      estimatedBytes: number,
      task: () => Promise<T>,
      label = "",
    ): Promise<T> {
      const estimate = Number.isFinite(estimatedBytes)
        ? Math.max(0, estimatedBytes)
        : STARTUP_RECOVERY_BASE_MEMORY_BYTES;
      return new Promise<T>((resolve, reject) => {
        queue.push({
          estimatedBytes: estimate,
          label: safeString(label).trim(),
          task,
          resolve: (value) => resolve(value as T),
          reject,
        });
        schedulePump();
      });
    },
  };
}

export async function runStartupRecoveryWithAdmission<T>(input: {
  admission: {
    run<R>(
      estimatedBytes: number,
      task: () => Promise<R>,
      label?: string,
    ): Promise<R>;
  };
  estimatedBytes: number;
  preconnect: () => Promise<void>;
  resume: (connect: () => Promise<void>) => Promise<T>;
  label?: string;
}) {
  return await input.resume(async () => {
    await input.admission.run(
      input.estimatedBytes,
      input.preconnect,
      input.label,
    );
  });
}

export function createChatKeyWorkerPool<T>(deps: {
  prepare: (payload: T, chatKey: string) => Promise<PreparedChatKeyWorkerJob>;
  onPrepareError?: (
    payload: T,
    chatKey: string,
    error: unknown,
  ) => void | Promise<void>;
  onIdle?: (chatKey: string) => void | Promise<void>;
  logger?: { warn?: (...args: any[]) => void };
}): ChatKeyWorkerPool<T> {
  const workers = new Map<string, ChatKeyWorker<T>>();

  const releaseIdleWorker = (worker: ChatKeyWorker<T>, chatKey: string) => {
    if (worker.queue.length || worker.activeTasks.size) return;
    if (workers.get(chatKey) !== worker) return;
    workers.delete(chatKey);
    void Promise.resolve()
      .then(() => deps.onIdle?.(chatKey))
      .catch((error: any) => {
        deps.logger?.warn?.(
          `chat inbox worker idle callback failed chatKey=${chatKey} err=${safeString(error?.message || error)}`,
        );
      });
  };

  const startPreparedTask = (
    worker: ChatKeyWorker<T>,
    chatKey: string,
    prepared: PreparedChatKeyWorkerJob,
  ) => {
    const task = prepared
      .run()
      .catch((error: any) => {
        deps.logger?.warn?.(
          `chat inbox worker task failed chatKey=${chatKey} err=${safeString(error?.message || error)}`,
        );
      })
      .finally(() => {
        worker.activeTasks.delete(task);
        releaseIdleWorker(worker, chatKey);
      });
    worker.activeTasks.add(task);
    return task;
  };

  const prepareEntry = (
    payload: T,
    chatKey: string,
  ): ChatKeyWorkerEntry<T> => ({
    payload,
    prepared: Promise.resolve()
      .then(() => deps.prepare(payload, chatKey))
      .then((prepared) => ({ prepared }))
      .catch((error) => ({ error })),
  });

  const pump = (chatKey: string) => {
    const worker = workers.get(chatKey);
    if (!worker || worker.pumping) return;
    worker.pumping = true;
    void (async () => {
      try {
        while (worker.queue.length) {
          const entry = worker.queue[0];
          if (!entry) {
            worker.queue.shift();
            continue;
          }
          const result = await entry.prepared;
          worker.queue.shift();
          if ("error" in result) {
            await deps.onPrepareError?.(entry.payload, chatKey, result.error);
            continue;
          }
          startPreparedTask(worker, chatKey, result.prepared);
        }
      } finally {
        worker.pumping = false;
        if (worker.queue.length) pump(chatKey);
        else releaseIdleWorker(worker, chatKey);
      }
    })().catch((error: any) => {
      worker.pumping = false;
      deps.logger?.warn?.(
        `chat inbox worker pump failed chatKey=${chatKey} err=${safeString(error?.message || error)}`,
      );
      if (worker.queue.length) pump(chatKey);
    });
  };

  return {
    enqueue(chatKey: string, payload: T) {
      const key = safeString(chatKey).trim() || "unknown";
      let worker = workers.get(key);
      if (!worker) {
        worker = {
          queue: [],
          pumping: false,
          activeTasks: new Set(),
        };
        workers.set(key, worker);
      }
      worker.queue.push(prepareEntry(payload, key));
      pump(key);
    },
    hasWorker(chatKey: string) {
      const key = safeString(chatKey).trim() || "unknown";
      return workers.has(key);
    },
  };
}

export async function waitUntil(
  predicate: () => boolean,
  task: Promise<unknown>,
) {
  let settled = false;
  void task.finally(() => {
    settled = true;
  });
  while (!settled && !predicate()) {
    await sleep(10);
  }
}
