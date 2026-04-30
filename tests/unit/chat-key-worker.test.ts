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

test("chat key worker lets abort bypass admission but keeps later jobs behind abort cleanup", async () => {
  const events: string[] = [];
  let releaseAdmission!: () => void;
  let releaseAbort!: () => void;
  let releaseActive!: () => void;
  const admission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });

  const pool = createChatKeyWorkerPool<{ kind: string }>({
    canBypassAdmissionWait: (payload) => payload.kind === "abort",
    prepare: async (payload) => {
      if (payload.kind === "active") {
        return {
          run: async () => {
            events.push("active-start");
            await activeGate;
            events.push("active-end");
          },
          waitForAdmission: async () => {
            await admission;
          },
        };
      }
      if (payload.kind === "abort") {
        return {
          run: async () => {
            events.push("abort-start");
            releaseAdmission();
            await abortGate;
            events.push("abort-end");
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

  pool.enqueue("telegram/1:2", { kind: "abort" });
  await waitUntil(() => events.includes("abort-start"), "abort did not bypass");

  pool.enqueue("telegram/1:2", { kind: "next" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ["active-start", "abort-start"]);

  releaseAbort();
  await waitUntil(() => events.includes("next-start"), "next did not resume");
  releaseActive();
  await waitUntil(
    () => events.includes("active-end"),
    "active did not clean up",
  );
  assert.deepEqual(events, [
    "active-start",
    "abort-start",
    "abort-end",
    "next-start",
    "active-end",
  ]);
});
