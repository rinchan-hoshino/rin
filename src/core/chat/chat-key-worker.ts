import { safeString } from "../text-utils.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type PreparedChatKeyWorkerJob = {
  run: () => Promise<void>;
  waitForAdmission?: () => Promise<void>;
};

export type ChatKeyWorkerPool<T> = {
  enqueue: (chatKey: string, payload: T) => void;
  activeWorkerCount: () => number;
};

type ChatKeyWorker<T> = {
  queue: T[];
  pumping: boolean;
  activeTasks: Set<Promise<void>>;
  barrierTasks: Set<Promise<void>>;
};

export function createChatKeyWorkerPool<T>(deps: {
  prepare: (payload: T, chatKey: string) => Promise<PreparedChatKeyWorkerJob>;
  onPrepareError?: (
    payload: T,
    chatKey: string,
    error: unknown,
  ) => void | Promise<void>;
  canBypassAdmissionWait?: (payload: T, chatKey: string) => boolean;
  logger?: { warn?: (...args: any[]) => void };
}): ChatKeyWorkerPool<T> {
  const workers = new Map<string, ChatKeyWorker<T>>();

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
        if (!worker.queue.length && !worker.activeTasks.size) {
          workers.delete(chatKey);
        }
      });
    worker.activeTasks.add(task);
    return task;
  };

  const runPreparedPayload = async (
    worker: ChatKeyWorker<T>,
    chatKey: string,
    prepared: PreparedChatKeyWorkerJob,
  ) => {
    const task = startPreparedTask(worker, chatKey, prepared);
    if (prepared.waitForAdmission) {
      await prepared.waitForAdmission();
      return;
    }
    await task;
  };

  const runPayload = async (
    worker: ChatKeyWorker<T>,
    chatKey: string,
    payload: T,
  ) => {
    let prepared: PreparedChatKeyWorkerJob;
    try {
      prepared = await deps.prepare(payload, chatKey);
    } catch (error) {
      await deps.onPrepareError?.(payload, chatKey, error);
      return;
    }

    await runPreparedPayload(worker, chatKey, prepared);
  };

  const runBypassPayload = async (
    worker: ChatKeyWorker<T>,
    chatKey: string,
    payload: T,
  ) => {
    let complete!: () => void;
    const bypassTask = new Promise<void>((resolve) => {
      complete = resolve;
    });
    worker.activeTasks.add(bypassTask);
    worker.barrierTasks.add(bypassTask);
    try {
      await runPayload(worker, chatKey, payload);
    } finally {
      worker.activeTasks.delete(bypassTask);
      worker.barrierTasks.delete(bypassTask);
      complete();
      if (!worker.queue.length && !worker.activeTasks.size) {
        workers.delete(chatKey);
      }
    }
  };

  const pump = (chatKey: string) => {
    const worker = workers.get(chatKey);
    if (!worker || worker.pumping) return;
    worker.pumping = true;
    void (async () => {
      try {
        while (worker.queue.length) {
          const payload = worker.queue.shift();
          if (!payload) continue;
          await runPayload(worker, chatKey, payload);
          while (worker.barrierTasks.size > 0) {
            await Promise.race([...worker.barrierTasks]);
          }
        }
      } finally {
        worker.pumping = false;
        if (worker.queue.length) pump(chatKey);
        else if (!worker.activeTasks.size) workers.delete(chatKey);
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
          barrierTasks: new Set(),
        };
        workers.set(key, worker);
      }
      if (
        worker.pumping &&
        worker.activeTasks.size > 0 &&
        deps.canBypassAdmissionWait?.(payload, key)
      ) {
        void runBypassPayload(worker, key, payload).catch((error: any) => {
          deps.logger?.warn?.(
            `chat inbox worker bypass failed chatKey=${key} err=${safeString(error?.message || error)}`,
          );
        });
        return;
      }
      worker.queue.push(payload);
      pump(key);
    },
    activeWorkerCount() {
      return workers.size;
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
