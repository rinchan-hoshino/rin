import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const runtime = Object.assign(
  {},
  await import(pathToFileURL(path.resolve("dist/core/chat/chat.js")).href),
);

test("runtime app exposes the Chat lifecycle and node helpers", async () => {
  const app = runtime.createChat(".") as any;
  const events: any[] = [];
  const working: string[] = [];
  const platform = {
    bot: {
      platform: "owner",
      selfId: "bot",
      status: 0,
      async sendMessage() {
        return [];
      },
    },
    async start() {},
    async stop() {},
    setWorkingText(text: string) {
      working.push(text);
    },
  };
  app.on("bot-status-updated", (bot: any) => events.push(bot.status));
  assert.equal(app.addPlatform(null), false);
  assert.equal(app.addPlatform({ bot: {} }), false);
  assert.equal(app.addPlatform(platform), true);
  app.updateStatus(platform.bot, 1);
  app.setWorkingText("working");
  await app.start();
  await app.stop();
  assert.deepEqual(events, [1]);
  assert.deepEqual(working, ["working"]);
  assert.deepEqual(app.getPlatformStatuses(), [
    { platform: "owner", selfId: "bot", status: "stopped" },
  ]);

  const h = runtime.createChatNodes();
  assert.equal(h("text", { content: "owner" }).type, "text");
  assert.equal(h.text(7).attrs.content, "7");
  assert.equal(h.quote(8).attrs.id, "8");
  assert.equal(h.at(9, { name: "Owner" }).attrs.name, "Owner");
  assert.equal(h.image("image").attrs.src, "image");
  assert.equal(h.markdown("**owner**").type, "markdown");
  assert.equal(h.html("<b>owner</b>").type, "html");
  assert.equal(h.file(Buffer.from("owner"), "text/plain").attrs.data.length, 5);
  assert.equal(h.file("file:///owner", "").attrs.src, "file:///owner");
});

test("runtime app contains recovery and adapter lifecycle failures", async () => {
  const app = runtime.createChat() as any;
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

  app.registerPlatformFailure({}, null);
  app.addPlatform({
    bot: { platform: "failed", selfId: "bot", status: 1 },
    async start() {
      throw "";
    },
    async stop() {
      throw new Error("cleanup failed");
    },
  });
  app.addPlatform({
    bot: { platform: "cleanup", selfId: "bot", status: 1 },
    async start() {},
    async stop() {
      throw "";
    },
  });

  await app.start();
  await app.stop();
  const statuses = app.getPlatformStatuses();
  assert.equal(
    statuses.some((entry: any) => entry.error === "platform_init_failed"),
    true,
  );
  assert.equal(
    statuses.some((entry: any) => entry.error === "platform_stop_failed"),
    true,
  );
  assert.equal(
    events.some(([kind]) => kind === "ready"),
    true,
  );
  assert.equal(
    events.some(
      ([kind, payload]) =>
        kind === "start" && payload.error === "platform_start_failed",
    ),
    true,
  );
  assert.equal(
    events.some(([kind]) => kind === "stop"),
    true,
  );
});
