import "../support/require-test-sandbox.ts";
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true before timeout");
}

test("hosted chat retries transient startup failures and self-heals to ready", async () => {
  let attempts = 0;
  const bridge = {
    getStatus: () => ({ ready: true, adapterCount: 1 }),
    async stop() {},
  };
  const service = hostedChat.createHostedChatService({
    logger: { error() {} },
    retry: { initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 },
  });

  await service.start(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("rin_timeout:connect");
    return bridge;
  });

  assert.deepEqual(service.getStatus(), {
    ready: false,
    status: "degraded",
    error: "rin_timeout:connect",
    retrying: true,
    retryAttempt: 1,
  });
  await waitFor(() => service.getStatus().ready === true);
  assert.equal(attempts, 2);
  assert.equal(await service.getBridge(), bridge);
  assert.deepEqual(service.getStatus(), { ready: true, adapterCount: 1 });
  await service.stop();
});

test("hosted chat stop cancels a pending startup retry", async () => {
  let attempts = 0;
  const service = hostedChat.createHostedChatService({
    logger: { error() {} },
    retry: { initialDelayMs: 25, maxDelayMs: 25, jitterRatio: 0 },
  });

  await service.start(async () => {
    attempts += 1;
    throw new Error("rin_timeout:connect");
  });
  await service.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(attempts, 1);
  assert.equal(service.getStatus().status, "stopped");
});

test("hosted chat does not retry permanent startup failures", async () => {
  let attempts = 0;
  const service = hostedChat.createHostedChatService({
    logger: { error() {} },
    retry: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  });

  await service.start(async () => {
    attempts += 1;
    throw new Error("invalid_chat_credentials");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(attempts, 1);
  assert.deepEqual(service.getStatus(), {
    ready: false,
    status: "degraded",
    error: "invalid_chat_credentials",
  });
  await service.stop();
});

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
