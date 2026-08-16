import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const chatRuntime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "app.js"))
    .href
);

test("chat runtime reports adapter initialization failures as degraded", () => {
  const app = new chatRuntime.ChatRuntimeApp();
  app.registerAdapterFailure(
    { platform: "custom", selfId: "provider" },
    new Error("provider_init_failed"),
  );

  assert.deepEqual(app.getAdapterStatuses(), [
    {
      platform: "custom",
      selfId: "provider",
      status: "degraded",
      error: "provider_init_failed",
    },
  ]);
});

test("chat runtime isolates adapter startup and shutdown failures", async () => {
  const app = new chatRuntime.ChatRuntimeApp();
  const calls: string[] = [];
  const failedBot = { platform: "failed", selfId: "bot-failed", status: 0 };
  const healthyBot = { platform: "healthy", selfId: "bot-healthy", status: 0 };

  app.register(
    {
      async start() {
        calls.push("failed:start");
        throw new Error("adapter_boot_failed");
      },
      async stop() {
        calls.push("failed:stop");
        throw new Error("adapter_stop_failed");
      },
    },
    failedBot,
  );
  app.register(
    {
      async start() {
        calls.push("healthy:start");
        healthyBot.status = 1;
      },
      async stop() {
        calls.push("healthy:stop");
        healthyBot.status = 0;
      },
    },
    healthyBot,
  );

  await app.start();

  assert.deepEqual(calls.slice(0, 3), [
    "failed:start",
    "failed:stop",
    "healthy:start",
  ]);
  assert.equal(healthyBot.status, 1);
  assert.deepEqual(app.getAdapterStatuses(), [
    {
      platform: "failed",
      selfId: "bot-failed",
      status: "degraded",
      error: "adapter_boot_failed",
    },
    {
      platform: "healthy",
      selfId: "bot-healthy",
      status: "ready",
    },
  ]);

  await app.stop();
  assert.deepEqual(calls.slice(3), ["healthy:stop", "failed:stop"]);
});
