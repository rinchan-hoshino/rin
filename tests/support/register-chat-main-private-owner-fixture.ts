import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "/dist/core/chat/main.js";
const daemonTarget = "/dist/core/rin-frontend-sdk/daemon-client.js";
const fakeDaemonSource = `
export class RinDaemonFrontendClient {
  constructor() {
    this.connected = false;
    return new Proxy(this, {
      get(target, key) {
        if (key in target) return target[key];
        return async () => ({});
      },
    });
  }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  isConnected() { return this.connected; }
  subscribe() { return () => {}; }
  async getCommands() { return []; }
  async getState() { return {}; }
  async ensureSessionReady() { return {}; }
  async request(command = {}) {
    if (command.type === "list_unacknowledged_chat_terminals") {
      return { terminals: [] };
    }
    return {};
  }
  async prompt() { throw new Error("owner_frontend_unavailable"); }
  async abort() {}
}
`;
const returnNeedle = `return {
        app,
        options,
        stop,
        getStatus,`;
const returnReplacement = `return {
        __rinOwner: {
            runOutboxHistoryCleanup,
            requestDrainChatOutbox,
            requestReconcileChatTerminals,
            findRuntimeBot,
            sessionChatKey,
            isRecordOnlyChatKey,
            isInboundMessageProcessed,
            handleUnmatchedCommandSession,
            handleCommandSession,
            prepareAllowedChatTurnSubmission,
            enqueueAndDrainOutbox,
            buildCommandPromptMeta,
            getController,
            getDetachedController,
            detachedControllerUsers,
            retiredDetachedControllers,
        },
        app,
        options,
        stop,
        getStatus,`;
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (url.endsWith(${JSON.stringify(daemonTarget)})) {
    return {
      ...loaded,
      source: ${JSON.stringify(fakeDaemonSource)},
      shortCircuit: true,
    };
  }
  if (!url.endsWith(${JSON.stringify(target)})) return loaded;
  const source = String(loaded.source).replace(${JSON.stringify(returnNeedle)}, ${JSON.stringify(returnReplacement)});
  return {
    ...loaded,
    source: source + "\\nexport { appendTelegramThreadToChatKey as __rinOwnerAppendTelegramThreadToChatKey, buildTelegramInboundMediaDebug as __rinOwnerBuildTelegramInboundMediaDebug, getCommandTargets as __rinOwnerGetCommandTargets, parseInboundCommandRequest as __rinOwnerParseInboundCommandRequest, parseInboundCommand as __rinOwnerParseInboundCommand, elementsToCommandText as __rinOwnerElementsToCommandText };\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
