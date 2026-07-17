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
