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
};

export function createChatKeyWorkerPool<T>(deps: {
  prepare: (payload: T, chatKey: string) => Promise<PreparedChatKeyWorkerJob>;
  onPrepareError?: (
    payload: T,
    chatKey: string,
    error: unknown,
  ) => void | Promise<void>;
  logger?: { warn?: (...args: any[]) => void };
}): ChatKeyWorkerPool<T> {
  const workers = new Map<string, ChatKeyWorker<T>>();

  const pump = (chatKey: string) => {
    const worker = workers.get(chatKey);
    if (!worker || worker.pumping) return;
    worker.pumping = true;
    void (async () => {
      try {
        while (worker.queue.length) {
          const payload = worker.queue.shift();
          if (!payload) continue;
          let prepared: PreparedChatKeyWorkerJob;
          try {
            prepared = await deps.prepare(payload, chatKey);
          } catch (error) {
            await deps.onPrepareError?.(payload, chatKey, error);
            continue;
          }

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

          if (prepared.waitForAdmission) {
            await prepared.waitForAdmission();
            continue;
          }
          await task;
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
        worker = { queue: [], pumping: false, activeTasks: new Set() };
        workers.set(key, worker);
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
