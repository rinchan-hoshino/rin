import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
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
