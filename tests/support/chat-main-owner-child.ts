import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const state: any = ((globalThis as any).__chatMainOwner = {
  events: [],
  apps: [],
  controllers: [],
  jobs: [],
  pending: [],
  processed: new Set<string>(),
  outbox: [],
  activeWorkerKeys: new Set<string>(),
  ownedMessages: new Set<string>(),
  recordOnly: new Set<string>(),
  trustByUser: {},
  cwd: process.cwd(),
  recovery: {
    restoredProcessing: [{ id: "processing-owner" }],
    restoredOrphans: [{ id: "orphan-owner" }],
  },
  cleanupResult: { delivered: 2, failed: 1 },
  builtinAdapters: [{ builtIn: true }],
  externalAdapters: [{ external: true }],
  language: "zh_CN",
  commandRows: [
    { name: "help", description: "Help" },
    { name: "new", description: "New" },
    { name: "abort", description: "Abort" },
    { name: "usage", description: "Usage" },
    { name: "nodesc", description: "" },
  ],
});

const rootDir = path.resolve(process.env.RIN_REPO_ROOT || ".");
const agentDir = String(process.env.RIN_DIR);
await fs.mkdir(path.join(agentDir, "data"), { recursive: true });
await fs.writeFile(path.join(agentDir, "owner-settings.json"), "{}\n");
const mainUrl = pathToFileURL(
  path.join(rootDir, "dist", "core", "chat", "main.js"),
).href;
const { startChatBridge } = await import(mainUrl);
const createRinFrontendTurnCancelledError = () =>
  Object.assign(new Error("frontend-cancelled"), { rinCancelled: true });

async function settle() {
  for (let pass = 0; pass < 8; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = state.pending.splice(0);
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}

function countEvent(name: string) {
  return state.events.filter((entry: any[]) => entry[0] === name).length;
}

const bridge = await startChatBridge({
  hosted: true,
  settingsPath: path.join(agentDir, "owner-settings.json"),
  additionalExtensionPaths: ["/owner/extensions"],
  frontendClientFactory: () => ({ owner: true }),
  chatAdapterProviders: [{ platform: "owner", create: () => ({}) }],
});
assert.deepEqual(
  {
    ready: bridge.getStatus().ready,
    adapterCount: bridge.getStatus().adapterCount,
    botCount: bridge.getStatus().botCount,
    stopping: bridge.getStatus().stopping,
  },
  { ready: true, adapterCount: 2, botCount: 0, stopping: false },
);
assert.equal(bridge.options.hosted, true);
assert.equal(countEvent("reconcile-outbox"), 1);
assert.equal(countEvent("cleanup-outbox"), 1);

state.drainOutboxMode = "missing";
await assert.rejects(
  bridge.send({ chatKey: "owner/chat", parts: [] }),
  /chat_outbox_delivery_missing/,
);
state.drainOutboxMode = "pending";
state.drainOutboxMessage = "owner-pending";
await assert.rejects(
  bridge.send({ chatKey: "owner/chat", parts: [] }),
  /owner-pending/,
);
state.drainOutboxMessage = "";
await assert.rejects(
  bridge.send({ chatKey: "owner/chat", parts: [] }),
  /chat_outbox_delivery_pending/,
);
state.drainOutboxMode = "dispatched";
const dispatchedSend = await bridge.send({ chatKey: "owner/chat", parts: [] });
assert.equal(dispatchedSend.delivered, false);
assert.equal(dispatchedSend.pending, true);
assert.ok(dispatchedSend.outboxId);
state.drainOutboxMode = "delivered";
assert.deepEqual(await bridge.send({ chatKey: "owner/chat", parts: [] }), {
  delivered: true,
});

await assert.rejects(bridge.typing({}), /chat_key_required/);
assert.deepEqual(await bridge.typing({ chatKey: " owner/chat " }), {
  sent: true,
});
await assert.rejects(
  bridge.react({ messageId: "m", emoji: "ok" }),
  /chat_key_required/,
);
await assert.rejects(
  bridge.react({ chatKey: "owner/chat", emoji: "ok" }),
  /chat_message_id_required/,
);
await assert.rejects(
  bridge.react({ chatKey: "owner/chat", messageId: "m" }),
  /chat_reaction_emoji_required/,
);
assert.deepEqual(
  await bridge.react({ chatKey: "owner/chat", messageId: "m", emoji: "ok" }),
  { sent: true },
);

await assert.rejects(bridge.runTurn({ text: "  " }), /chat_text_required/);
state.modelOptions = {
  "owner/chat": { model: "configured", thinkingLevel: "high" },
};
const bound = await bridge.runTurn({
  chatKey: "owner/chat",
  text: " owner turn ",
  sessionFile: "/owner/session.jsonl",
  sessionName: "Owner",
  managedSessionLeaf: "owner-leaf",
  createSessionFileIfMissing: true,
  tools: ["read"],
  excludeTools: ["bash"],
  noTools: false,
  disabledRinCapabilities: ["owner-capability"],
  model: "explicit",
  thinkingLevel: "medium",
  piStartupOptions: { owner: true },
  promptMeta: { source: "owner" },
  requestTag: "owner-tag",
  deliveryIdempotencyKey: "owner-delivery",
  deliverFinal: true,
  quietMode: false,
});
assert.equal(bound.input.model, "explicit");
assert.equal(bound.input.thinkingLevel, "medium");

await bridge.runTurn({
  chatKey: "owner/detached-a",
  controllerKey: "owner/scheduler",
  affectChatBinding: false,
  text: "detached one",
  frontend: { type: "owner" },
});
await bridge.runTurn({
  chatKey: "owner/detached-b",
  controllerKey: "owner/scheduler",
  affectChatBinding: false,
  text: "detached two",
  disposeAfterTurn: true,
});
state.terminateError = true;
await bridge.runTurn({
  controllerKey: "owner:shutdown",
  text: "detached shutdown",
  shutdownAfterTurn: true,
});
state.terminateError = false;

assert.deepEqual(await bridge.setWorkingVisible({}), { handled: false });
assert.deepEqual(
  await bridge.setWorkingVisible({ chatKey: "owner/chat", visible: true }),
  { handled: true },
);
assert.deepEqual(
  await bridge.setWorkingVisible({ chatKey: "owner/chat", visible: false }),
  { handled: true },
);
state.workingError = true;
assert.deepEqual(
  await bridge.setWorkingVisible({ controllerKey: "owner-working" }),
  { handled: true },
);
state.workingError = false;

await assert.rejects(bridge.terminateTurn({}), /chat_controller_key_required/);
assert.deepEqual(await bridge.terminateTurn({ chatKey: "missing-chat" }), {
  terminated: false,
});
assert.deepEqual(
  await bridge.terminateTurn({ controllerKey: "missing-controller" }),
  { terminated: false },
);
assert.deepEqual(await bridge.terminateTurn({ chatKey: "owner/chat" }), {
  terminated: true,
  chatKey: "owner/chat",
});
await bridge.runTurn({
  controllerKey: "owner-terminate",
  affectChatBinding: false,
  text: "terminate me",
});
assert.deepEqual(
  await bridge.terminateTurn({ controllerKey: "owner-terminate" }),
  { terminated: true, controllerKey: "owner-terminate" },
);

state.evalValue = ["owner", 1];
const evalResult = await bridge.evalBridge({
  createdAt: "now",
  currentChatKey: "owner/chat",
  requestId: "eval-owner",
  code: "return owner",
  timeoutMs: 17,
  sessionId: "session-owner",
  sessionFile: "/owner/eval.jsonl",
});
assert.equal(evalResult.ok, true);
assert.equal(evalResult.timeoutMs, 17);
assert.match(evalResult.text, /owner/);
state.evalError = "eval-owner-failed";
await assert.rejects(
  bridge.evalBridge({ createdAt: "now", code: "throw owner" }),
  /eval-owner-failed\naudit=/,
);
state.auditPath = false;
await assert.rejects(
  bridge.evalBridge({ createdAt: "now", code: "throw owner again" }),
  /^Error: eval-owner-failed$/,
);
state.evalError = "";

const app = bridge.app;
app.bots.push({ platform: "telegram", selfId: "bot", status: 1 });
app.emit("bot-status-updated", { status: 0 });
app.emit("bot-status-updated", { status: 1 });
await settle();
const savedBots = app.bots;
app.bots = null;
assert.equal(bridge.getStatus().botCount, 0);
app.bots = savedBots;

async function emit(session: any) {
  app.emit("message", {
    platform: "telegram",
    selfId: "bot",
    channelId: "chat",
    userId: "owner-user",
    isDirect: true,
    messageId: `m-${state.events.length}`,
    content: "owner prompt",
    elements: [{ text: "owner prompt" }],
    ...session,
  });
  await settle();
}

await emit({ allow: false });
state.recordOnly.add("telegram/bot:record");
await emit({ channelId: "record", ownerChatKey: "telegram/bot:record" });
await emit({
  channelId: "record",
  ownerChatKey: "telegram/bot:record",
  content: "/help",
  elements: [{ text: "/help" }],
});
state.recordOnly.clear();

await emit({ content: "/session", elements: [{ text: "/session" }] });
await emit({ content: "/help", elements: [{ text: "/help" }] });
state.denyCommands = ["help"];
await emit({ content: "/help", elements: [{ text: "/help" }] });
state.denyCommands = [];
state.commandError = "command-owner-failed";
await emit({ content: "/new owner", elements: [{ text: "/new owner" }] });
state.commandError = "";
await emit({ content: "/usage", elements: [{ text: "/usage" }] });
await emit({
  private: false,
  content: "/unknown",
  elements: [{ text: "/unknown" }],
});
await emit({ content: "/unknown", elements: [{ text: "/unknown" }] });
state.trustByUser["untrusted-user"] = "UNTRUSTED";
await emit({
  userId: "untrusted-user",
  content: "/unknown",
  elements: [{ text: "/unknown" }],
});
state.trustByUser["untrusted-user"] = "OWNER";
await emit({
  content: "/help@OtherBot",
  elements: [{ text: "/help@OtherBot" }],
  bot: { username: "RinBot" },
});
await emit({
  content: "/help@RinBot",
  elements: [{ text: "/help@RinBot" }],
  bot: { username: "RinBot" },
});
await emit({ content: "/", elements: [{ text: "/" }] });
await emit({ content: "/@RinBot", elements: [{ text: "/@RinBot" }] });
await emit({
  selfId: "",
  bot: {},
  content: "/help@AnyBot",
  elements: [{ text: "/help@AnyBot" }],
});
state.emptyChatKey = true;
await emit({ content: "/unknown", elements: [{ text: "/unknown" }] });
await emit({ content: "/usage", elements: [{ text: "/usage" }] });
state.emptyChatKey = false;

state.attachments = [{ kind: "file", name: "owner.txt", path: "/owner.txt" }];
state.attachmentFailures = [{ kind: "photo", error: "missing" }];
state.attachmentPrompt = "attachment owner prompt";
state.replySession = { linked: true, sessionFile: "/owner/reply.jsonl" };
state.quotedOwnText = "quoted owner text";
await emit({
  replyToMessageId: "reply-owner",
  timestamp: 123,
  chatName: "Owner Chat",
  nickname: "Owner Nick",
  runtimeMetadata: { owner: true },
  requiresMentionToStartTurn: true,
  messageThreadId: "topic / one",
  ownerChatKey: "telegram/bot:chat?thread=topic%20%2F%20one",
  telegram: {
    message: {
      message_id: 7,
      photo: [
        {
          file_id: "ok",
          file_unique_id: "u1",
          file_size: 4,
          width: 8,
          height: 9,
        },
        { file_id: "bad", width: "x", height: "x" },
        { file_id: "", file_size: "x" },
      ],
      document: {
        file_id: "doc",
        file_name: "owner.txt",
        mime_type: "text/plain",
        file_size: 3,
      },
    },
  },
  bot: {
    username: "RinBot",
    internal: {
      async getFile({ file_id }: any) {
        if (file_id === "bad") throw new Error("telegram-file-owner");
        return {
          file_path: `/owner/${file_id}`,
          file_size: file_id === "doc" ? 3 : 4,
        };
      },
    },
  },
});
state.replyToLatest = true;
state.quotedOwnText = "";
await emit({ replyToMessageId: "latest-owner" });
state.replyToLatest = false;
state.replySession = undefined;
state.attachments = [];

await emit({ platform: "discord", telegram: { message: {} } });
await emit({ telegram: null });
await emit({ telegram: {} });
await emit({ telegram: { edited_message: "not-an-object" } });
await emit({ telegram: { channel_post: { photo: "not-an-array" } } });
await emit({
  telegram: {
    edited_channel_post: {
      document: {
        file_id: "doc-no-lookup",
        file_size: "not-a-number",
        mime_type: "",
        file_name: "",
      },
    },
  },
  bot: {},
});
await emit({
  telegram: {
    message: {
      photo: [
        {
          file_id: "photo-empty-file",
          file_unique_id: "",
          file_size: "not-a-number",
          width: "not-a-number",
          height: "not-a-number",
        },
      ],
    },
  },
  bot: {
    internal: {
      async getFile() {
        return {};
      },
    },
  },
});
await emit({
  telegram: { message: { photo: [{ file_id: "getter-error" }] } },
  bot: {
    internal: {
      get getFile() {
        throw new Error("get-file-getter-owner");
      },
    },
  },
});
state.attachmentFailures = [];

const lifecyclePending = createRinFrontendTurnCancelledError();
state.turnErrors = [lifecyclePending];
await emit({ messageId: "lifecycle-pending" });
state.processed.add("lifecycle-done");
state.turnErrors = [createRinFrontendTurnCancelledError()];
await emit({ messageId: "lifecycle-done" });
state.turnErrors = [new Error("terminal-owner")];
await emit({ messageId: "terminal-owner" });
assert.equal(state.processed.has("terminal-owner"), true);
state.drainOutboxMode = "missing";
state.turnErrors = [new Error("terminal-committed-owner")];
await emit({ messageId: "terminal-committed-owner" });
state.drainOutboxMode = "delivered";
state.enqueueError = true;
state.turnErrors = [new Error("terminal-retry-owner")];
await emit({ messageId: "terminal-retry-owner" });
state.enqueueError = false;

await emit({ persistError: true, noLog: true, enqueue: false });
state.chatLogError = true;
await emit({ enqueue: false });
state.chatLogError = false;
app.emit("message", {
  platform: "telegram",
  messageId: "outer-failure",
  get elements() {
    throw new Error("outer-owner");
  },
});
await settle();

const candidateEnvelope = {
  chatKey: "telegram/bot:claim",
  messageId: "claim-owner",
  session: {
    platform: "telegram",
    selfId: "bot",
    channelId: "claim",
    messageId: "claim-owner",
    content: "/help",
  },
  elements: [{ text: "/help" }],
};
assert.equal(
  await state.inboxOptions.canClaimDuringActiveChatKeyWorker(candidateEnvelope),
  true,
);
state.recordOnly.add("telegram/bot:claim");
assert.equal(
  await state.inboxOptions.canClaimDuringActiveChatKeyWorker(candidateEnvelope),
  false,
);
state.recordOnly.clear();
const deniedEnvelope = {
  ...candidateEnvelope,
  session: { ...candidateEnvelope.session, allow: false, content: "prompt" },
  elements: [{ text: "prompt" }],
};
assert.equal(
  await state.inboxOptions.canClaimDuringActiveChatKeyWorker(deniedEnvelope),
  false,
);
state.decisionError = true;
const prepareFailureJob = {
  claimedPath: path.join(agentDir, "prepare-owner.json"),
  envelope: {
    ...candidateEnvelope,
    session: {
      ...candidateEnvelope.session,
      decisionError: true,
      content: "prompt",
    },
    elements: [{ text: "prompt" }],
  },
};
await state.workerOptions
  .prepare(prepareFailureJob)
  .catch((error: Error) =>
    state.workerOptions.onPrepareError(
      prepareFailureJob,
      "telegram/bot:claim",
      error,
    ),
  );
state.decisionError = false;
state.finalizeError = true;
await emit({ messageId: "finalize-failure-owner" });
state.finalizeError = false;

await new Promise((resolve) => setTimeout(resolve, 1_100));
assert.ok(countEvent("poll-typing") > 0);
assert.ok(countEvent("housekeep") > 0);

const statusBeforeStop = bridge.getStatus();
assert.ok(statusBeforeStop.controllerCount >= 1);
assert.ok(statusBeforeStop.detachedControllerCount >= 1);
state.detachError = true;
await Promise.all([bridge.stop(), bridge.stop()]);
assert.equal(bridge.getStatus().stopping, true);
const stoppingJob = {
  claimedPath: path.join(agentDir, "stopping-claimed.json"),
  envelope: {
    chatKey: "telegram/bot:stopping",
    messageId: "stopping-claimed-owner",
    session: {
      platform: "telegram",
      selfId: "bot",
      channelId: "stopping",
      messageId: "stopping-claimed-owner",
      content: "pending",
    },
    elements: [{ text: "pending" }],
  },
};
const stoppingPrepared = await state.workerOptions.prepare(stoppingJob);
await stoppingPrepared.run();
await assert.rejects(
  bridge.runTurn({ chatKey: "stopped", text: "no" }),
  /frontend-cancelled/,
);
app.emit("message", {
  platform: "telegram",
  selfId: "bot",
  channelId: "stopping",
  userId: "owner-user",
  isDirect: true,
  messageId: "stopping-owner",
  content: "pending",
  elements: [{ text: "pending" }],
});
await settle();

state.dependencyError = "dependency-owner";
state.runtime = { agentDir, cwd: agentDir };
state.cleanupResult = { delivered: 0, failed: 0 };
state.recovery = { restoredProcessing: [], restoredOrphans: [] };
state.appStopError = true;
const plainBridge = await startChatBridge({ hosted: false });
await plainBridge.runTurn({ chatKey: "plain/chat", text: "plain" });
await plainBridge.runTurn({
  controllerKey: "plain-detached",
  affectChatBinding: false,
  text: "plain detached",
});
await plainBridge.stop();
assert.equal(plainBridge.getStatus().stopping, true);

assert.ok(countEvent("app-start") >= 2);
assert.ok(countEvent("app-stop") >= 2);
assert.ok(countEvent("run-turn") >= 8);
assert.ok(countEvent("run-command") >= 2);
assert.ok(countEvent("audit") >= 3);
assert.ok(countEvent("restore-file") >= 1);
assert.ok(countEvent("requeue") >= 2);
console.log(JSON.stringify({ ok: true, events: state.events.length }));
