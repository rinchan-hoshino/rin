import { register } from "node:module";

(globalThis as any).__chatMainOwner = {
  events: [],
  apps: [],
  controllers: [],
  jobs: [],
  pending: [],
  processed: new Set(),
  outbox: [],
  commandRows: [{ name: "help", description: "Help" }],
  appStartError: process.env.RIN_TEST_CHAT_MAIN_APP_START_ERROR || "",
};

const replacements: Record<string, string> = {
  "dist/core/rin-lib/profile.js": `
    const state = () => globalThis.__chatMainOwner;
    export function resolveRuntimeProfile() {
      const value = state();
      return value.runtime || { agentDir: process.env.RIN_DIR, cwd: value.cwd || process.cwd() };
    }
    export function applyRuntimeProfileEnvironment(runtime) { state().events.push(["apply-profile", runtime]); }
  `,
  "dist/core/time-utils.js": `
    export function nowIso() { return "2026-07-18T12:00:00.000Z"; }
  `,
  "dist/core/chat-bridge/eval.js": `
    const state = () => globalThis.__chatMainOwner;
    export async function executeChatBridgeCode(input) {
      state().events.push(["eval", input]);
      if (state().evalError) throw new Error(state().evalError);
      return { timeoutMs: input.timeoutMs || 1000, value: state().evalValue ?? { owner: true } };
    }
    export function renderChatBridgeResult(value) { return "rendered:" + JSON.stringify(value); }
  `,
  "dist/core/chat-bridge/runtime.js": `
    const state = () => globalThis.__chatMainOwner;
    export function createChatBridgeRuntime(input) { state().events.push(["eval-runtime", input]); return input; }
    export function appendChatBridgeAudit(agentDir, input) {
      state().events.push(["audit", input]);
      return state().auditPath === false ? "" : agentDir + "/audit-owner.jsonl";
    }
  `,
  "dist/core/chat/support.js": `
    const state = () => globalThis.__chatMainOwner;
    export function canRunCommand(trust, command) { return state().denyCommands?.includes(command) ? false : trust !== "UNTRUSTED"; }
    export function chatStateDir(dataDir, chatKey) { return dataDir + "/chat-state/" + chatKey.replaceAll("/", "_"); }
    export function composeChatKeyForBot(app, platform, chatId, selfId) {
      if (state().emptyChatKey) return "";
      return platform + "/" + selfId + ":" + chatId;
    }
    export function loadIdentity() { return state().identity || { owner: true }; }
    export function trustOf(identity, platform, userId) { return state().trustByUser?.[userId] || "OWNER"; }
  `,
  "dist/core/chat/boot.js": `
    const state = () => globalThis.__chatMainOwner;
    export function getChatCommandRows(language) {
      state().events.push(["command-rows", language]);
      return state().commandRows || [
        { name: "help", description: "Help" },
        { name: "new", description: "New" },
        { name: "abort", description: "Abort" },
        { name: "usage", description: "Usage" },
      ];
    }
    export function reconcileCommittedChatOutboxProcessing(agentDir) { state().events.push(["reconcile-outbox", agentDir]); }
    export async function syncDiscordCommands(app, logger, rows) { state().events.push(["sync-discord", rows.length]); if (state().syncDiscordError) throw new Error("sync-discord-owner"); }
    export async function syncTelegramCommands(app, logger, rows) { state().events.push(["sync-telegram", rows.length]); if (state().syncTelegramError) throw new Error("sync-telegram-owner"); }
    export async function drainChatOutbox(app, agentDir, h, logger, filter) {
      state().events.push(["drain-outbox", filter || null]);
      if (state().drainOutboxError) throw new Error(state().drainOutboxError);
      if (!filter?.itemId) return [];
      if (state().drainOutboxMode === "missing") return [];
      if (state().drainOutboxMode === "dispatched") return [{ id: filter.itemId, status: "dispatched" }];
      if (state().drainOutboxMode === "pending") return [{ id: filter.itemId, status: "pending", error: state().drainOutboxMessage }];
      return [{ id: filter.itemId, status: "delivered" }];
    }
  `,
  "dist/core/chat/chat-helpers.js": `
    const state = () => globalThis.__chatMainOwner;
    export function safeString(value) { return value == null ? "" : String(value); }
    export function elementsToText(elements) { return (elements || []).map((item) => item?.text ?? item?.attrs?.content ?? "").join(""); }
    export function ensureDir(directory) { state().events.push(["ensure-dir", directory]); }
    export function ensureSessionElements(session) { return Array.isArray(session.elements) ? session.elements : [{ text: session.content || "" }]; }
    export async function extractInboundAttachments(elements) { return { attachments: state().attachments || [], failures: state().attachmentFailures || [] }; }
    export function buildInboundAttachmentNotice(failures) { return failures.length ? "attachment-owner-notice" : ""; }
    export function getChatId(session) { return session.channelId || session.chatId || "chat"; }
    export function getChatType(session) { return session.chatType || (session.isDirect ? "private" : "group"); }
    export function lookupReplySession() { return state().replySession; }
    export function persistInboundMessage(agentDir, session, elements) {
      state().events.push(["persist", session.messageId]);
      if (session.persistError) throw new Error("persist-owner");
      if (session.enqueue !== false) {
        const chatKey = session.ownerChatKey || (session.platform + "/" + (session.selfId || "bot") + ":" + (session.channelId || "chat"));
        state().jobs.push({ claimedPath: agentDir + "/claimed-" + (session.messageId || "message") + ".json", envelope: { chatKey, messageId: session.messageId || "message", session, elements } });
      }
    }
    export function pickChatName(session) { return session.chatName || ""; }
    export function pickMessageId(session) { return session.messageId || ""; }
    export function pickReplyToMessageId(session) { return session.replyToMessageId || ""; }
    export function pickSenderNickname(session) { return session.nickname || "owner-nick"; }
    export function pickUnsessionedOwnQuoteText() { return state().quotedOwnText || ""; }
    export function pickUserId(session) { return session.userId || "owner-user"; }
    export function prependQuoteTextToPromptBody(body, quote) { return quote ? quote + "\\n\\n" + body : body; }
    export function renderPromptTextWithSavedAttachments(elements, attachments) { return state().attachmentPrompt || "attachment-prompt"; }
    export function hasInboundChatMessageReplyBoundary(agentDir, chatKey, messageId) { return state().processed?.has(messageId) || false; }
    export function isInboundChatMessageProcessed(agentDir, chatKey, messageId) { return state().processed?.has(messageId) || false; }
    export function isReplyToLatestAssistantMessage() { return Boolean(state().replyToLatest); }
    export function markProcessedChatMessage(agentDir, chatKey, messageId, input) { state().processed.add(messageId); state().events.push(["mark-processed", messageId, input]); }
  `,
  "dist/core/chat/inbound-normalization.js": `
    export function buildInboundChatLogInput(session, elements, input) { if (session.noLog) return undefined; return { ...input, messageId: session.messageId }; }
  `,
  "dist/core/chat/message-store.js": `
    export function buildChatMessageRecordKey(chatKey, messageId) { return (chatKey + "-" + messageId).replace(/[^A-Za-z0-9_-]/g, "_"); }
  `,
  "dist/core/chat/controller.js": `
    const state = () => globalThis.__chatMainOwner;
    export function loadChatSettings(settingsPath) { state().events.push(["load-settings", settingsPath]); return state().settings || {}; }
    export class ChatController {
      constructor(app, dataDir, chatKey, options) {
        this.app = app; this.dataDir = dataDir; this.chatKey = chatKey; this.options = options; this.state = { chatKey };
        state().controllers.push(this); state().events.push(["controller", chatKey, options]);
      }
      async runCommand(...args) { state().events.push(["run-command", this.chatKey, ...args]); if (state().commandError) throw new Error(state().commandError); return state().commandResult || { ok: true }; }
      async runTurn(input) {
        state().events.push(["run-turn", this.chatKey, input]);
        const error = state().turnErrors?.shift();
        if (error) throw error;
        return { finalText: "owner-final", input };
      }
      async pollTyping() { state().events.push(["poll-typing", this.chatKey]); if (state().pollTypingError) throw new Error("poll-owner"); }
      async housekeep() { state().events.push(["housekeep", this.chatKey]); if (state().housekeepError) throw new Error("housekeep-owner"); }
      async clearProcessingState() { state().events.push(["clear-processing", this.chatKey]); if (state().clearError) throw new Error("clear-owner"); }
      ownsInboundMessage(messageId) { return state().ownedMessages?.has(messageId) || false; }
      hasActiveTurn() { return Boolean(state().hasActiveTurn); }
      dispose() { state().events.push(["dispose", this.chatKey]); }
      async terminateSession() { state().events.push(["terminate", this.chatKey]); if (state().terminateError) throw new Error("terminate-owner"); }
      async beginExternalWorking() { state().events.push(["working-begin", this.chatKey]); if (state().workingError) throw new Error("working-owner"); }
      async endExternalWorking() { state().events.push(["working-end", this.chatKey]); if (state().workingError) throw new Error("working-owner"); }
      async detachForDaemonShutdown() { state().events.push(["detach-shutdown", this.chatKey]); if (state().detachError) throw new Error("detach-owner"); }
    }
  `,
  "dist/core/chat/command-responses.js": `export function readChatCommandResponses() { return { owner: true }; }`,
  "dist/core/chat/settings.js": `
    const state = () => globalThis.__chatMainOwner;
    export function resolveChatModelOptions(settings, chatKey) { return state().modelOptions?.[chatKey] || {}; }
    export function resolveChatTurnPolicyMode(settings, chatKey) { return state().recordOnly?.has(chatKey) ? "record_only" : "normal"; }
  `,
  "dist/core/chat/chat-log.js": `
    const state = () => globalThis.__chatMainOwner;
    export function appendChatLog(agentDir, input) { state().events.push(["chat-log", input]); if (state().chatLogError) throw new Error("chat-log-owner"); }
  `,
  "dist/core/chat/inbox.js": `
    const state = () => globalThis.__chatMainOwner;
    export function reconcileChatInboxRecovery() { return state().recovery || { restoredProcessing: [], restoredOrphans: [] }; }
    export function restoreChatInboxFile(agentDir, claimedPath, envelope) { state().events.push(["restore-file", claimedPath, envelope.messageId]); }
    export function restoreChatInboxSession(envelope, bot) { return { ...envelope.session, bot: bot || envelope.session?.bot }; }
    export function touchChatInboxFile(claimedPath, envelope) { state().events.push(["touch", claimedPath]); if (state().touchError) throw new Error("touch-owner"); }
  `,
  "dist/core/chat/inbox-drain.js": `
    const state = () => globalThis.__chatMainOwner;
    export function finalizeClaimedChatInboxJob(agentDir, job, result) { state().events.push(["finalize", job.envelope.messageId, result]); if (state().finalizeError) throw new Error("finalize-owner"); if (result?.processed) state().processed.add(job.envelope.messageId); }
    export function requeueClaimedChatInboxJob(agentDir, job, error) { state().events.push(["requeue", job.envelope.messageId, String(error)]); }
    export function createChatInboxDrain(options) {
      state().inboxOptions = options;
      return { requestDrainChatInbox() {
        state().events.push(["request-inbox"]);
        const jobs = state().jobs.splice(0);
        for (const job of jobs) state().pending.push(Promise.resolve(options.enqueueClaimedInboxItem(job)));
      }};
    }
  `,
  "dist/core/chat/chat-key-worker.js": `
    const state = () => globalThis.__chatMainOwner;
    export function createChatKeyWorkerPool(options) {
      state().workerOptions = options;
      return {
        enqueue(chatKey, job) {
          const work = Promise.resolve().then(() => options.prepare(job)).then((prepared) => prepared.run()).catch((error) => options.onPrepareError(job, chatKey, error));
          state().pending.push(work); return work;
        },
        hasWorker(chatKey) { return state().activeWorkerKeys?.has(chatKey) || false; },
      };
    }
  `,
  "dist/core/chat/decision.js": `
    const state = () => globalThis.__chatMainOwner;
    export async function isEffectivePrivateChatSession(session) { return session.private !== false; }
    export async function shouldProcessText(session, elements, identity, options) {
      state().events.push(["decision", session.messageId, options]);
      if (session.decisionError) throw new Error("decision-owner");
      return session.decision || { allow: session.allow !== false, chatKey: options.chatKey, text: session.turnText || elements.map((item) => item.text || item.attrs?.content || "").join(""), chatType: session.chatType || (session.isDirect ? "private" : "group"), requiresMentionToStartTurn: session.requiresMentionToStartTurn };
    }
  `,
  "dist/core/chat-runtime/index.js": `
    const state = () => globalThis.__chatMainOwner;
    function createApp() {
      const handlers = new Map();
      const app = {
        bots: state().initialBots || [], handlers,
        on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
        emit(name, value) { for (const handler of handlers.get(name) || []) handler(value); },
        async start() { state().events.push(["app-start"]); if (state().appStartError) throw new Error(state().appStartError); },
        async stop() { state().events.push(["app-stop"]); if (state().appStopError) throw new Error(state().appStopError); },
      };
      state().apps.push(app); return app;
    }
    export function createChatRuntimeApp(agentDir) { state().events.push(["create-app", agentDir]); return createApp(); }
    export function createChatRuntimeH() { return { text(value) { return { text: value }; } }; }
    export async function instantiateChatRuntimeAdapters(app, options) { state().events.push(["builtin-adapters", options]); return state().builtinAdapters || [{ owner: "builtin" }]; }
    export async function instantiateExternalChatRuntimeAdapters(app, options) { state().events.push(["external-adapters", options]); if (state().externalAdapterError) throw new Error("external-owner"); return state().externalAdapters || [{ owner: "external" }]; }
  `,
  "dist/core/chat/runtime-config.js": `
    const state = () => globalThis.__chatMainOwner;
    export function ensureChatRuntimeDependencies(root, settings) { state().events.push(["runtime-dependencies", root]); if (state().dependencyError) throw new Error(state().dependencyError); }
    export function listChatRuntimeAdapterEntries() { return state().adapterEntries || [{ platform: "owner" }]; }
  `,
  "dist/core/rin-frontend-sdk/frontend-identity.js": `export function normalizeFrontendIdentity(value) { return value ? { ...value, normalized: true } : undefined; }`,
  "dist/core/rin-frontend-sdk/lifecycle-errors.js": `
    export function createRinFrontendTurnCancelledError() { const error = new Error("frontend-cancelled"); error.rinCancelled = true; return error; }
    export function isRinFrontendTurnCancelledError(error) { return Boolean(error?.rinCancelled); }
  `,
  "dist/core/rin-lib/chat-outbox.js": `
    const state = () => globalThis.__chatMainOwner;
    export function enqueueChatOutboxPayload(agentDir, payload, options) { state().events.push(["enqueue-outbox", payload, options]); state().outbox.push({ payload, options }); if (state().enqueueError) throw new Error("enqueue-owner"); }
    export function cleanupChatOutboxHistory(agentDir) { state().events.push(["cleanup-outbox", agentDir]); return state().cleanupResult || { delivered: 0, failed: 0 }; }
  `,
  "dist/core/chat/transport.js": `
    const state = () => globalThis.__chatMainOwner;
    export async function sendTyping(app, chatKey, h) { state().events.push(["typing", chatKey]); return state().typingSent !== false; }
    export async function sendReaction(app, chatKey, messageId, emoji) { state().events.push(["reaction", chatKey, messageId, emoji]); return state().reactionSent !== false; }
  `,
  "dist/core/language.js": `export function readConfiguredLanguageFromSettings() { return globalThis.__chatMainOwner.language || "en"; }`,
  "dist/core/session/ref.js": `export function normalizeSessionRef(value) { return { sessionId: value?.sessionId || undefined, sessionFile: value?.sessionFile || undefined }; }`,
  "dist/core/rin-lib/user-facing-errors.js": `export function formatRuntimeErrorForChat(value) { return "friendly:" + value; }`,
};

const replacementUrls = Object.fromEntries(
  Object.entries(replacements).map(([target, source]) => [
    target,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hookSource = `
const replacements = ${JSON.stringify(replacementUrls)};
const owner = "/dist/core/chat/main.js";
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (!context.parentURL?.endsWith(owner)) return resolved;
  for (const [target, replacementUrl] of Object.entries(replacements)) {
    if (resolved.url.endsWith(target)) return { url: replacementUrl, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
