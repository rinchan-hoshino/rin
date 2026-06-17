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
