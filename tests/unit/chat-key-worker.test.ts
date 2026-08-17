import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const workerModule = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "chat-key-worker.js"),
  ).href
);
const { createChatKeyWorkerPool } = workerModule;
const createStartupRecoveryAdmission = (workerModule as any)
  .createStartupRecoveryAdmission as (options: {
  availableMemoryBytes: () => number;
  reserveBytes?: number;
  logger?: { info?: (...args: any[]) => void };
}) => {
  run<T>(
    estimatedBytes: number,
    task: () => Promise<T>,
    label?: string,
  ): Promise<T>;
};
const estimateStartupRecoveryMemoryBytes = (workerModule as any)
  .estimateStartupRecoveryMemoryBytes as (sessionFileBytes: number) => number;
const readSystemAvailableMemoryBytes = (workerModule as any)
  .readSystemAvailableMemoryBytes as (deps?: {
  readMeminfo?: () => string;
  fallbackAvailableBytes?: () => number;
}) => number;
const runStartupRecoveryWithAdmission = (workerModule as any)
  .runStartupRecoveryWithAdmission as <T>(input: {
  admission: ReturnType<typeof createStartupRecoveryAdmission>;
  estimatedBytes: number;
  preconnect: () => Promise<void>;
  resume: (connect: () => Promise<void>) => Promise<T>;
}) => Promise<T>;

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("chat key worker prepares same-chat jobs concurrently while preserving run order", async () => {
  const events: string[] = [];
  let releaseSlowPrepare!: () => void;
  const slowPrepareGate = new Promise<void>((resolve) => {
    releaseSlowPrepare = resolve;
  });

  const pool = createChatKeyWorkerPool<{ kind: string }>({
    prepare: async (payload) => {
      events.push(`${payload.kind}-prepare-start`);
      if (payload.kind === "slow") await slowPrepareGate;
      events.push(`${payload.kind}-prepare-end`);
      return {
        run: async () => {
          events.push(`${payload.kind}-run-start`);
        },
      };
    },
  });

  pool.enqueue("telegram/1:concurrent-prepare", { kind: "slow" });
  pool.enqueue("telegram/1:concurrent-prepare", { kind: "fast" });

  await waitUntil(
    () => events.includes("fast-prepare-end"),
    "fast prepare waited behind slow prepare",
  );
  assert.deepEqual(events, [
    "slow-prepare-start",
    "fast-prepare-start",
    "fast-prepare-end",
  ]);

  releaseSlowPrepare();
  await waitUntil(
    () => events.includes("fast-run-start"),
    "prepared jobs did not run",
  );
  assert.deepEqual(events, [
    "slow-prepare-start",
    "fast-prepare-start",
    "fast-prepare-end",
    "slow-prepare-end",
    "slow-run-start",
    "fast-run-start",
  ]);
});

test("chat key worker reports prepare errors in queue order", async () => {
  const events: string[] = [];
  let releaseSlowPrepare!: () => void;
  const slowPrepareGate = new Promise<void>((resolve) => {
    releaseSlowPrepare = resolve;
  });

  const pool = createChatKeyWorkerPool<{ kind: string }>({
    prepare: async (payload) => {
      events.push(`${payload.kind}-prepare-start`);
      if (payload.kind === "slow") await slowPrepareGate;
      if (payload.kind === "fast-error") throw new Error("fast failed");
      events.push(`${payload.kind}-prepare-end`);
      return {
        run: async () => {
          events.push(`${payload.kind}-run-start`);
        },
      };
    },
    onPrepareError: async (payload) => {
      events.push(`${payload.kind}-prepare-error`);
    },
  });

  pool.enqueue("telegram/1:ordered-errors", { kind: "slow" });
  pool.enqueue("telegram/1:ordered-errors", { kind: "fast-error" });

  await waitUntil(
    () => events.includes("fast-error-prepare-start"),
    "fast prepare did not start concurrently",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.includes("fast-error-prepare-error"), false);

  releaseSlowPrepare();
  await waitUntil(
    () => events.includes("fast-error-prepare-error"),
    "prepare error was not reported",
  );
  assert.deepEqual(events, [
    "slow-prepare-start",
    "fast-error-prepare-start",
    "slow-prepare-end",
    "slow-run-start",
    "fast-error-prepare-error",
  ]);
});

test("chat key worker reports synchronous prepare throws in queue order", async () => {
  const events: string[] = [];
  let releaseSlowPrepare!: () => void;
  const slowPrepareGate = new Promise<void>((resolve) => {
    releaseSlowPrepare = resolve;
  });

  const pool = createChatKeyWorkerPool<{ kind: string }>({
    prepare: (payload) => {
      events.push(`${payload.kind}-prepare-start`);
      if (payload.kind === "sync-error") throw new Error("sync failed");
      return (async () => {
        await slowPrepareGate;
        events.push(`${payload.kind}-prepare-end`);
        return {
          run: async () => {
            events.push(`${payload.kind}-run-start`);
          },
        };
      })();
    },
    onPrepareError: async (payload) => {
      events.push(`${payload.kind}-prepare-error`);
    },
  });

  pool.enqueue("telegram/1:sync-errors", { kind: "slow" });
  pool.enqueue("telegram/1:sync-errors", { kind: "sync-error" });

  await waitUntil(
    () => events.includes("sync-error-prepare-start"),
    "sync throw prepare did not start concurrently",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.includes("sync-error-prepare-error"), false);

  releaseSlowPrepare();
  await waitUntil(
    () => events.includes("sync-error-prepare-error"),
    "sync throw prepare error was not reported",
  );
  assert.deepEqual(events, [
    "slow-prepare-start",
    "sync-error-prepare-start",
    "slow-prepare-end",
    "slow-run-start",
    "sync-error-prepare-error",
  ]);
});

test("chat key worker treats undefined prepare rejection as an error", async () => {
  const events: string[] = [];
  const pool = createChatKeyWorkerPool<{ kind: string }>({
    prepare: async (payload) => {
      events.push(`${payload.kind}-prepare-start`);
      throw undefined;
    },
    onPrepareError: async (payload, chatKey, error) => {
      events.push(`${payload.kind}-prepare-error:${chatKey}:${String(error)}`);
    },
  });

  pool.enqueue("telegram/1:undefined-error", { kind: "bad" });

  await waitUntil(
    () => events.some((event) => event.startsWith("bad-prepare-error")),
    "undefined prepare rejection was not reported",
  );
  assert.deepEqual(events, [
    "bad-prepare-start",
    "bad-prepare-error:telegram/1:undefined-error:undefined",
  ]);
});

test("chat key worker logs task failures and retires the fallback-key worker", async () => {
  const warnings: string[] = [];
  const pool = createChatKeyWorkerPool<string>({
    prepare: async () => ({
      run: async () => {
        throw new Error("run failed");
      },
    }),
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
  });

  pool.enqueue(" ", "payload");
  assert.equal(pool.hasWorker(""), true);
  await waitUntil(
    () => warnings.length === 1 && !pool.hasWorker(""),
    "failed task did not retire its worker",
  );
  assert.match(warnings[0], /chatKey=unknown err=run failed/);
});

test("chat key worker wait helper exits for predicates and settled tasks", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await workerModule.waitUntil(() => true, pending);
  release();

  await workerModule.waitUntil(() => false, Promise.resolve());
});

test("chat key worker requests another inbox drain after a chat becomes idle", async () => {
  const idleChatKeys: string[] = [];
  const pool = createChatKeyWorkerPool<{ kind: string }>({
    prepare: async () => ({ run: async () => {} }),
    onIdle: (chatKey) => idleChatKeys.push(chatKey),
  });

  pool.enqueue("telegram/1:idle", { kind: "record-only" });

  await waitUntil(
    () => idleChatKeys.length === 1,
    "idle worker did not request another drain",
  );
  assert.deepEqual(idleChatKeys, ["telegram/1:idle"]);
});

test("chat key worker reports synchronous idle callback errors", async () => {
  const warnings: string[] = [];
  const pool = createChatKeyWorkerPool<{ kind: string }>({
    prepare: async () => ({ run: async () => {} }),
    onIdle: () => {
      throw new Error("idle failed");
    },
    logger: {
      warn: (message) => warnings.push(String(message)),
    },
  });

  pool.enqueue("telegram/1:idle-error", { kind: "record-only" });

  await waitUntil(
    () => warnings.length === 1,
    "idle callback error was not reported",
  );
  assert.match(warnings[0], /idle callback failed.*idle failed/);
});

test("chat key worker releases queued jobs immediately after submission starts", async () => {
  const events: string[] = [];
  let releaseActive!: () => void;
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });

  const pool = createChatKeyWorkerPool<{ kind: string }>({
    prepare: async (payload) => {
      if (payload.kind === "active") {
        return {
          run: async () => {
            events.push("active-start");
            await activeGate;
            events.push("active-end");
          },
        };
      }
      return {
        run: async () => {
          events.push(`${payload.kind}-start`);
        },
      };
    },
  });

  pool.enqueue("telegram/1:2", { kind: "active" });
  await waitUntil(
    () => events.includes("active-start"),
    "active did not start",
  );

  pool.enqueue("telegram/1:2", { kind: "follow-up" });
  await waitUntil(
    () => events.includes("follow-up-start"),
    "follow-up waited for the active job to finish",
  );
  assert.deepEqual(events, ["active-start", "follow-up-start"]);

  releaseActive();
  await waitUntil(
    () => events.includes("active-end"),
    "active did not clean up",
  );
});

test("startup recovery estimates parsed session memory above raw file bytes", () => {
  const gib = 1024 ** 3;
  assert.equal(estimateStartupRecoveryMemoryBytes(0), 512 * 1024 ** 2);
  assert.equal(estimateStartupRecoveryMemoryBytes(gib), 2.5 * gib);
  assert.equal(estimateStartupRecoveryMemoryBytes(Number.NaN), 512 * 1024 ** 2);
  assert.equal(estimateStartupRecoveryMemoryBytes(-1), 512 * 1024 ** 2);
});

test("startup recovery reads Linux MemAvailable with a portable fallback", () => {
  assert.equal(
    readSystemAvailableMemoryBytes({
      readMeminfo: () => "MemTotal: 1000 kB\nMemAvailable: 768 kB\n",
      fallbackAvailableBytes: () => 1,
    }),
    768 * 1024,
  );
  assert.equal(
    readSystemAvailableMemoryBytes({
      readMeminfo: () => "MemTotal: 1000 kB\n",
      fallbackAvailableBytes: () => 456,
    }),
    456,
  );
  assert.equal(
    readSystemAvailableMemoryBytes({
      readMeminfo: () => {
        throw new Error("missing");
      },
      fallbackAvailableBytes: () => Number.NaN,
    }),
    0,
  );
  assert.equal(
    readSystemAvailableMemoryBytes({
      readMeminfo: () => "missing",
      fallbackAvailableBytes: () => -1,
    }),
    0,
  );
  assert.ok(readSystemAvailableMemoryBytes() > 0);
});

test("startup recovery overlaps session opens only inside available headroom", async () => {
  const gib = 1024 ** 3;
  const events: string[] = [];
  let releaseLarge!: () => void;
  const largeGate = new Promise<void>((resolve) => {
    releaseLarge = resolve;
  });
  const admission = createStartupRecoveryAdmission({
    availableMemoryBytes: () => 5 * gib,
    reserveBytes: 2 * gib,
  });

  const large = admission.run(2.5 * gib, async () => {
    events.push("large-start");
    await largeGate;
    events.push("large-end");
  });
  const small = admission.run(gib, async () => {
    events.push("small-start");
  });

  await waitUntil(
    () => events.includes("large-start"),
    "large open did not start",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["large-start"]);

  releaseLarge();
  await Promise.all([large, small]);
  assert.deepEqual(events, ["large-start", "large-end", "small-start"]);
});

test("startup recovery preserves high parallelism when memory is available", async () => {
  const gib = 1024 ** 3;
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admission = createStartupRecoveryAdmission({
    availableMemoryBytes: () => 12 * gib,
    reserveBytes: 2 * gib,
  });

  const tasks = ["first", "second", "third"].map((name) =>
    admission.run(gib, async () => {
      events.push(`${name}-start`);
      await gate;
    }),
  );
  await waitUntil(() => events.length === 3, "opens did not overlap");
  release();
  await Promise.all(tasks);
  assert.deepEqual(events, ["first-start", "second-start", "third-start"]);
});

test("startup recovery releases admission after session open while resumed turns overlap", async () => {
  const gib = 1024 ** 3;
  const events: string[] = [];
  let releaseFirstOpen!: () => void;
  let releaseResumes!: () => void;
  const firstOpenGate = new Promise<void>((resolve) => {
    releaseFirstOpen = resolve;
  });
  const resumeGate = new Promise<void>((resolve) => {
    releaseResumes = resolve;
  });
  const admission = createStartupRecoveryAdmission({
    availableMemoryBytes: () => 3 * gib,
    reserveBytes: 2 * gib,
  });
  const recover = (name: string, preconnect: () => Promise<void>) =>
    runStartupRecoveryWithAdmission({
      admission,
      estimatedBytes: gib,
      preconnect,
      resume: async (connect) => {
        events.push(`${name}-prime`);
        await connect();
        events.push(`${name}-resume`);
        await resumeGate;
        return name;
      },
    });

  const first = recover("first", async () => {
    events.push("first-open");
    await firstOpenGate;
  });
  const second = recover("second", async () => {
    events.push("second-open");
  });

  await waitUntil(
    () => events.includes("first-open"),
    "first open did not start",
  );
  assert.deepEqual(events, ["first-prime", "second-prime", "first-open"]);
  releaseFirstOpen();
  await waitUntil(
    () => events.includes("second-resume"),
    "second turn did not resume while first turn remained active",
  );
  assert.deepEqual(events, [
    "first-prime",
    "second-prime",
    "first-open",
    "first-resume",
    "second-open",
    "second-resume",
  ]);
  releaseResumes();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
});

test("startup recovery falls back safely when memory signals are invalid", async () => {
  const logs: string[] = [];
  const invalid = createStartupRecoveryAdmission({
    availableMemoryBytes: () => Number.NaN,
    logger: { info: (line: string) => logs.push(line) },
  });
  assert.equal(await invalid.run(Number.NaN, async () => 42), 42);
  assert.match(logs[0] || "", /session=unknown/);

  const unavailable = createStartupRecoveryAdmission({
    availableMemoryBytes: () => {
      throw new Error("unavailable");
    },
  });
  assert.equal(await unavailable.run(1, async () => 7, "fallback"), 7);
});

test("startup recovery lets one oversized session make progress and releases failures", async () => {
  const gib = 1024 ** 3;
  const events: string[] = [];
  const admission = createStartupRecoveryAdmission({
    availableMemoryBytes: () => gib,
    reserveBytes: 2 * gib,
  });

  const failed = admission.run(4 * gib, async () => {
    events.push("oversized-start");
    throw new Error("open failed");
  });
  const next = admission.run(gib, async () => {
    events.push("next-start");
  });

  await assert.rejects(failed, /open failed/);
  await next;
  assert.deepEqual(events, ["oversized-start", "next-start"]);
});
