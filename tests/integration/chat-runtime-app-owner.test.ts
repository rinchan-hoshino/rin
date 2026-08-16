import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const runtime = Object.assign(
  {},
  await import(
    pathToFileURL(path.resolve("dist/core/chat-runtime/app.js")).href
  ),
);

test("runtime app contains recovery and adapter lifecycle failures", async () => {
  const app = runtime.createChatRuntimeApp() as any;
  const events: any[] = [];
  app.on("inbound-recovery-chat-ready", (payload: any) =>
    events.push(["ready", payload]),
  );
  app.on("adapter-start-failed", (payload: any) =>
    events.push(["start", payload]),
  );
  app.on("adapter-stop-failed", (payload: any) =>
    events.push(["stop", payload]),
  );

  app.beginInboundRecoveryChat(" ");
  app.beginInboundRecoveryChat(" owner/chat ");
  assert.equal(app.isInboundRecoveryChat("owner/chat"), true);
  app.completeInboundRecoveryChat("");
  app.completeInboundRecoveryChat("missing");
  app.completeInboundRecoveryChat("owner/chat");
  assert.equal(app.isInboundRecoveryChat("owner/chat"), false);

  app.registerAdapterFailure({}, null);
  app.register(
    {
      async start() {
        throw "";
      },
      async stop() {
        throw new Error("cleanup failed");
      },
    },
    { platform: "failed", selfId: "bot", status: 1 },
  );
  app.register(
    {
      async stop() {
        throw "";
      },
    },
    null,
  );

  await app.start();
  await app.stop();
  const statuses = app.getAdapterStatuses();
  assert.equal(
    statuses.some((entry: any) => entry.error === "adapter_init_failed"),
    true,
  );
  assert.equal(
    statuses.some((entry: any) => entry.error === "adapter_stop_failed"),
    true,
  );
  assert.equal(
    events.some(([kind]) => kind === "ready"),
    true,
  );
  assert.equal(
    events.some(
      ([kind, payload]) =>
        kind === "start" && payload.error === "adapter_start_failed",
    ),
    true,
  );
  assert.equal(
    events.some(([kind]) => kind === "stop"),
    true,
  );
});
