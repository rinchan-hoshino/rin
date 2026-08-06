import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTestSandbox } from "../support/test-sandbox.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const sandboxRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "rin-hosted-chat-service-"),
);
const sandbox = await createTestSandbox(sandboxRoot);
after(() => fs.rm(sandboxRoot, { recursive: true, force: true }));
assert.notEqual(sandbox.env.HOME, process.env.HOME);

const hostedChat = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "app", "rin-daemon", "hosted-chat-service.js"),
  ).href
);

test("hosted chat startup failure degrades chat without rejecting daemon startup", async () => {
  const errors: string[] = [];
  const service = hostedChat.createHostedChatService({
    logger: { error: (message: string) => errors.push(message) },
  });

  await service.start(async () => {
    throw new Error("discord_gateway_failed");
  });

  assert.deepEqual(service.getStatus(), {
    ready: false,
    status: "degraded",
    error: "discord_gateway_failed",
  });
  await assert.rejects(
    () => service.getBridge(),
    /chat_bridge_unavailable:discord_gateway_failed/,
  );
  assert.equal(errors.length, 1);

  await service.stop();
});

test("hosted chat reports unopened, fallback failure, and stopped states", async () => {
  const service = hostedChat.createHostedChatService();
  assert.deepEqual(service.getStatus(), { ready: false, status: "starting" });
  await assert.rejects(
    () => service.getBridge(),
    /chat_bridge_unavailable:starting/,
  );
  await service.stop();
  await service.stop();
  assert.deepEqual(service.getStatus(), { ready: false, status: "stopped" });

  const failed = hostedChat.createHostedChatService({
    logger: { error() {} },
  });
  await Promise.all([
    failed.start(async () => {
      throw "";
    }),
    failed.start(async () => assert.fail("startup factory ran twice")),
  ]);
  assert.deepEqual(failed.getStatus(), {
    ready: false,
    status: "degraded",
    error: "chat_start_failed",
  });

  const stopFailure = hostedChat.createHostedChatService();
  await stopFailure.start(async () => ({
    getStatus: () => ({ ready: true }),
    stop: async () => {
      throw new Error("stop failed");
    },
  }));
  await assert.doesNotReject(() => stopFailure.stop());
});

test("hosted chat exposes the ready bridge and stops it once", async () => {
  let stopCalls = 0;
  const bridge = {
    getStatus: () => ({ ready: true, adapterCount: 1 }),
    async stop() {
      stopCalls += 1;
    },
  };
  const service = hostedChat.createHostedChatService();

  await service.start(async () => bridge);

  assert.equal(await service.getBridge(), bridge);
  assert.deepEqual(service.getStatus(), { ready: true, adapterCount: 1 });
  await Promise.all([service.stop(), service.stop()]);
  assert.equal(stopCalls, 1);
});
