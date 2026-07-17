import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { createChatKeyWorkerPool } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "chat-key-worker.js"),
  ).href
);

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
