import { getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";

import {
  extractPiContinuableToolCallIds,
  extractPiContinuableToolCallParts,
} from "../pi/tool-continuation.js";
import { parseJsonl } from "../rin-lib/common.js";
import { createInterruptedToolResultMessage } from "../rin-lib/interruption.js";
import { fail, ok } from "../rin-lib/rpc.js";
import {
  listBoundSessionPage,
  listBoundSessions,
  renameBoundSession,
} from "../session/factory.js";
import { getManagedSessionDir } from "../session/managed-paths.js";
import { requireSessionFile } from "../session/ref.js";
import { resolveRuntimeProfile } from "../rin-lib/runtime.js";
import { normalizeFrontendIdentity } from "../rin-frontend-sdk/frontend-identity.js";
import { resolveSubmittedTurnFromMessages } from "../rin-frontend-sdk/submitted-turn.js";
import {
  captureRinTurnCompletionBaseline,
  resolveRinLatestSubmittedTurnCompletion,
  resolveRinTurnCompletionAfterPromptSettled,
  resolveRinTurnFailureMessage,
  type RinTurnCompletionResolution,
} from "../rin-frontend-sdk/turn-completion.js";
import {
  emitPiSessionEvent,
  refreshPiSessionToolRegistry,
  rewritePiSessionManagerFile,
} from "../pi/session-host.js";
import { safeString } from "../text-utils.js";
import {
  getCommandArgumentCompletions,
  getOAuthState,
  getResourceDiagnostics,
  getSessionState,
  getSlashCommands,
  runBuiltinCommand,
  writeJsonLine,
} from "./worker-helpers.js";

const TURN_HEARTBEAT_INTERVAL_MS = 2_000;
const TURN_COMPLETION_RECHECK_DELAYS_MS = [0, 10];
const THINKING_LEVEL_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

type PendingExtensionUiRequest = {
  resolve: (response: any) => void;
  timer?: NodeJS.Timeout;
  abort?: () => void;
};

function createExtensionUiResponseParser(defaultValue: any) {
  return (response: any) => {
    if (response?.cancelled) return defaultValue;
    if ("confirmed" in (response || {})) return Boolean(response.confirmed);
    if ("value" in (response || {})) return response.value;
    return defaultValue;
  };
}

function latestCompactionTokensBefore(session: any) {
  const entries = Array.isArray(session?.entries) ? session.entries : [];
  return getLatestCompactionEntry(entries as any)?.tokensBefore;
}

function withCompactionEventMetadata(session: any, event: any) {
  if (!event || typeof event !== "object") return event;
  if (event.type !== "compaction_end") return event;
  if (event.tokensBefore !== undefined) return event;
  const tokensBefore = latestCompactionTokensBefore(session);
  return tokensBefore === undefined ? event : { ...event, tokensBefore };
}

function stableJson(value: any) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function waitForTurnCompletionRecheck(delayMs: number) {
  return new Promise((resolve) => {
    if (delayMs <= 0) setImmediate(resolve);
    else setTimeout(resolve, delayMs);
  });
}

async function resolveRinTurnCompletionAfterPromptSettledWithRechecks(
  session: any,
  options: { baseline: ReturnType<typeof captureRinTurnCompletionBaseline> },
) {
  let resolution = resolveRinTurnCompletionAfterPromptSettled(session, options);
  if (resolution.completion.finalText) return resolution;
  if (resolveRinTurnFailureMessage(session, resolution.messages)) {
    return resolution;
  }
  for (const delayMs of TURN_COMPLETION_RECHECK_DELAYS_MS) {
    await waitForTurnCompletionRecheck(delayMs);
    resolution = resolveRinTurnCompletionAfterPromptSettled(session, options);
    if (resolution.completion.finalText) return resolution;
    if (resolveRinTurnFailureMessage(session, resolution.messages)) {
      return resolution;
    }
  }
  return resolution;
}

async function promptWithQueueableTurnReceiver(
  session: any,
  message: string,
  options: Record<string, unknown>,
) {
  if (typeof session?.prompt !== "function") return;
  const receiver = new Proxy(session, {
    get(target, property, receiver) {
      if (property === "isStreaming") return true;
      return Reflect.get(target, property, receiver);
    },
  });
  return await session.prompt.call(receiver, message, options);
}

function getSessionEntries(session: any) {
  return Array.isArray(session?.sessionManager?.getEntries?.())
    ? session.sessionManager.getEntries()
    : [];
}

function lastPersistedMessage(session: any) {
  const entries = getSessionEntries(session);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message") return entry.message;
  }
  return undefined;
}

function ensureInterruptedAssistantPersisted(session: any, message: any) {
  const manager = session?.sessionManager;
  if (typeof manager?.appendMessage !== "function") return;
  if (stableJson(lastPersistedMessage(session)) === stableJson(message)) return;
  manager.appendMessage(message);
}

function messageToolCallIds(message: any) {
  return extractPiContinuableToolCallIds(message);
}

function toolResultHasMatchingAncestor(
  entry: any,
  byId: Map<string, any>,
  validIds: Set<string>,
) {
  const toolCallId = safeString(entry?.message?.toolCallId).trim();
  if (!toolCallId) return true;
  let parentId = safeString(entry?.parentId).trim();
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    if (!validIds.has(parentId)) return false;
    const parent = byId.get(parentId);
    if (!parent) return false;
    const message = parent.type === "message" ? parent.message : undefined;
    if (message?.role === "user") return false;
    if (messageToolCallIds(message).includes(toolCallId)) return true;
    parentId = safeString(parent.parentId).trim();
  }
  return false;
}

function rebuildSessionTreeIndexes(session: any, keptEntries: any[]) {
  const manager = session?.sessionManager;
  if (manager?.byId instanceof Map) {
    manager.byId.clear();
    for (const entry of keptEntries) {
      if (entry?.id) manager.byId.set(entry.id, entry);
    }
  }
  if ("leafId" in (manager || {})) {
    manager.leafId =
      [...keptEntries].reverse().find((entry) => entry?.type !== "session")
        ?.id ?? null;
  }
}

function repairProviderInvalidToolResultEntries(session: any) {
  const entries = getSessionEntries(session);
  if (!entries.length) return 0;
  const byId = new Map<string, any>(
    entries
      .filter((entry: any) => safeString(entry?.id).trim())
      .map((entry: any) => [safeString(entry.id).trim(), entry]),
  );
  const validIds = new Set<string>();
  const keptEntries: any[] = [];
  const replacementParents = new Map<string, string | null>();
  let removed = 0;
  let lastKeptId: string | null = null;

  for (const entry of entries) {
    const id = safeString(entry?.id).trim();
    const originalParentId = safeString(entry?.parentId).trim();
    const replacementParent = originalParentId
      ? replacementParents.get(originalParentId)
      : undefined;
    const parentId = replacementParent ?? originalParentId;
    if (replacementParent !== undefined) entry.parentId = parentId;
    const parentValid = !parentId || validIds.has(parentId);
    const toolResultValid =
      entry?.type !== "message" ||
      entry?.message?.role !== "toolResult" ||
      toolResultHasMatchingAncestor(entry, byId, validIds);
    if (!parentValid || !toolResultValid) {
      removed += 1;
      if (id)
        replacementParents.set(id, parentValid ? parentId || null : lastKeptId);
      continue;
    }
    keptEntries.push(entry);
    if (id) {
      validIds.add(id);
      lastKeptId = id;
    }
  }

  if (!removed) return 0;
  entries.splice(0, entries.length, ...keptEntries);
  rebuildSessionTreeIndexes(session, keptEntries);
  rewritePiSessionManagerFile(session?.sessionManager);
  if (Array.isArray(session?.agent?.state?.messages)) {
    const context = session.sessionManager?.buildSessionContext?.();
    if (Array.isArray(context?.messages)) {
      session.agent.state.messages = context.messages;
    }
  }
  return removed;
}

function appendInterruptedToolResults(
  session: any,
  options: { persistToSession?: boolean } = {},
) {
  const messages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") return false;
  const toolCalls = extractPiContinuableToolCallParts(lastMessage);
  if (!toolCalls.length) return false;

  const persistToSession = options.persistToSession !== false;
  if (persistToSession)
    ensureInterruptedAssistantPersisted(session, lastMessage);

  for (const toolCall of toolCalls) {
    const message = createInterruptedToolResultMessage(toolCall);
    session.agent.state.messages.push(message);
    if (persistToSession) {
      session.sessionManager.appendMessage(message);
    }
  }
  return true;
}

function clampSessionThinkingLevel(session: any, level: string) {
  const availableLevels = Array.isArray(session?.getAvailableThinkingLevels?.())
    ? session
        .getAvailableThinkingLevels()
        .map((item: unknown) => safeString(item).trim())
    : [];
  if (availableLevels.includes(level)) return level;
  if (!availableLevels.length) return level;
  const requestedIndex = THINKING_LEVEL_ORDER.indexOf(level);
  if (requestedIndex < 0) return availableLevels[0];
  for (let i = requestedIndex; i < THINKING_LEVEL_ORDER.length; i += 1) {
    if (availableLevels.includes(THINKING_LEVEL_ORDER[i])) {
      return THINKING_LEVEL_ORDER[i];
    }
  }
  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    if (availableLevels.includes(THINKING_LEVEL_ORDER[i])) {
      return THINKING_LEVEL_ORDER[i];
    }
  }
  return availableLevels[0];
}

function setSessionThinkingLevel(
  session: any,
  level: string,
  options: { persistSettings?: boolean } = {},
) {
  if (options.persistSettings !== false) {
    return session.setThinkingLevel(level);
  }
  const requested = safeString(level).trim();
  if (!session?.agent?.state || !requested) {
    return session.setThinkingLevel(level);
  }
  const effectiveLevel = clampSessionThinkingLevel(session, requested);
  const previousLevel = session.agent.state.thinkingLevel;
  session.agent.state.thinkingLevel = effectiveLevel;
  if (effectiveLevel !== previousLevel) {
    session.sessionManager?.appendThinkingLevelChange?.(effectiveLevel);
    emitPiSessionEvent(session, {
      type: "thinking_level_changed",
      level: effectiveLevel,
    });
  }
  return { level: effectiveLevel };
}

async function setSessionModel(
  session: any,
  model: any,
  options: { persistSettings?: boolean } = {},
) {
  if (options.persistSettings !== false) {
    await session.setModel(model);
    return model;
  }
  if (!session?.agent?.state) {
    await session.setModel(model);
    return model;
  }
  if (
    typeof session.modelRegistry?.hasConfiguredAuth === "function" &&
    !session.modelRegistry.hasConfiguredAuth(model)
  ) {
    throw new Error(`No API key for ${model.provider}/${model.id}`);
  }
  const thinkingLevel = safeString(session.thinkingLevel).trim() || "medium";
  session.agent.state.model = model;
  session.sessionManager?.appendModelChange?.(model.provider, model.id);
  setSessionThinkingLevel(session, thinkingLevel, { persistSettings: false });
  return model;
}

async function resetSessionModelOptionsFromSettings(session: any) {
  if (typeof session?.settingsManager?.reload === "function") {
    await session.settingsManager.reload();
  }

  const provider = safeString(
    session?.settingsManager?.getDefaultProvider?.() ||
      session?.settingsManager?.settings?.defaultProvider,
  ).trim();
  const modelId = safeString(
    session?.settingsManager?.getDefaultModel?.() ||
      session?.settingsManager?.settings?.defaultModel,
  ).trim();
  const thinkingLevel = safeString(
    session?.settingsManager?.getDefaultThinkingLevel?.() ||
      session?.settingsManager?.settings?.defaultThinkingLevel,
  ).trim();

  let model: any;
  if (provider && modelId) {
    const models = await session.modelRegistry.getAvailable();
    model = models.find(
      (item: any) => item?.provider === provider && item?.id === modelId,
    );
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await setSessionModel(session, model, { persistSettings: false });
  }
  if (thinkingLevel) {
    setSessionThinkingLevel(session, thinkingLevel, { persistSettings: false });
  }
  return {
    model: model || session.model,
    thinkingLevel: session.thinkingLevel,
  };
}

async function forceFlushSessionFile(session: any) {
  await Promise.resolve(rewritePiSessionManagerFile(session?.sessionManager));
}

async function resumeInterruptedTurn(
  session: any,
  options: { persistInterruptionMessage?: boolean } = {},
): Promise<RinTurnCompletionResolution | null> {
  const lastMessage = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages[session.agent.state.messages.length - 1]
    : null;
  if (!lastMessage) return null;
  if (lastMessage.role === "assistant") {
    if (
      !appendInterruptedToolResults(session, {
        persistToSession: options.persistInterruptionMessage,
      })
    ) {
      return resolveRinLatestSubmittedTurnCompletion(session);
    }
  }
  await session.agent.continue();
  return null;
}

function isWorkerLocalSessionReplacementCommand(commandLine: string) {
  const trimmed = safeString(commandLine).trim();
  if (trimmed === "/new") return true;
  if (!trimmed.startsWith("/resume ")) return false;
  return Boolean(trimmed.slice("/resume ".length).trim());
}

function canReuseCurrentSessionForNewSessionCommand(
  session: any,
  command: any,
) {
  if (!session || session.isStreaming || session.isCompacting) return false;
  if (String(command?.parentSession || "").trim()) return false;
  if (String(command?.managedSessionLeaf || "").trim()) return false;
  if (String(command?.sessionFile || command?.sessionPath || "").trim()) {
    return false;
  }
  const entryCount = Array.isArray(session.sessionManager?.getEntries?.())
    ? session.sessionManager.getEntries().length
    : undefined;
  if (typeof entryCount === "number") return entryCount === 0;
  const messageCount = Array.isArray(session.messages)
    ? session.messages.length
    : undefined;
  return typeof messageCount === "number" ? messageCount === 0 : false;
}

async function createManagedNewSession(
  runtime: any,
  SessionManager: any,
  options: { managedSessionLeaf: string; parentSession?: unknown },
) {
  const managedSessionLeaf = safeString(options.managedSessionLeaf).trim();
  if (!managedSessionLeaf) {
    return await runtime.newSession(
      options.parentSession
        ? { parentSession: options.parentSession }
        : undefined,
    );
  }

  if (
    typeof runtime.emitBeforeSwitch !== "function" ||
    typeof runtime.teardownCurrent !== "function" ||
    typeof runtime.apply !== "function" ||
    typeof runtime.createRuntime !== "function"
  ) {
    throw new Error("managed_new_session_unsupported");
  }

  const beforeResult = await runtime.emitBeforeSwitch("new");
  if (beforeResult?.cancelled) return beforeResult;

  const currentSession = runtime.session;
  const cwd =
    safeString(
      runtime.cwd || currentSession?.sessionManager?.getCwd?.(),
    ).trim() || process.cwd();
  const profile = resolveRuntimeProfile({
    cwd,
    agentDir: safeString(runtime.services?.agentDir).trim() || undefined,
  });
  const sessionDir = getManagedSessionDir(profile.agentDir, managedSessionLeaf);
  const sessionManager = SessionManager.create(cwd, sessionDir);
  if (options.parentSession) {
    sessionManager.newSession({ parentSession: options.parentSession });
  }
  const previousSessionFile = currentSession?.sessionFile;
  await runtime.teardownCurrent("new", sessionManager.getSessionFile());
  runtime.apply(
    await runtime.createRuntime({
      cwd,
      agentDir: profile.agentDir,
      sessionManager,
      sessionStartEvent: {
        type: "session_start",
        reason: "new",
        previousSessionFile,
      },
    }),
  );
  await runtime.finishSessionReplacement?.();
  return { cancelled: false };
}

export async function runCustomRpcMode(
  runtimeOrSession: any,
  deps: {
    SessionManager: any;
    reuseFreshSessionForInitialNewSession?: boolean;
  },
) {
  const { SessionManager } = deps;
  const runtime =
    runtimeOrSession && runtimeOrSession.session
      ? runtimeOrSession
      : {
          session: runtimeOrSession,
          newSession: runtimeOrSession.newSession?.bind(runtimeOrSession),
          switchSession: runtimeOrSession.switchSession?.bind(runtimeOrSession),
          fork: runtimeOrSession.fork?.bind(runtimeOrSession),
          importFromJsonl:
            runtimeOrSession.importFromJsonl?.bind(runtimeOrSession),
        };
  const getSession = () => runtime.session;
  const output = (obj: unknown) => writeJsonLine(obj);
  const done = (id: string | undefined, type: string, value?: unknown) =>
    ok(id, type, value);
  const pendingExtensionUiRequests = new Map<
    string,
    PendingExtensionUiRequest
  >();
  let extensionUiRequestSeq = 0;

  const createExtensionUiRequestId = () =>
    `extension_ui_${Date.now().toString(36)}_${++extensionUiRequestSeq}`;

  const resolvePendingExtensionUiRequest = (response: any) => {
    const requestId = safeString(response?.id).trim();
    if (!requestId) return false;
    const pending = pendingExtensionUiRequests.get(requestId);
    if (!pending) return false;
    pendingExtensionUiRequests.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.abort?.();
    pending.resolve(response);
    return true;
  };

  const createExtensionUiDialogPromise = (
    options: any,
    defaultValue: any,
    request: Record<string, unknown>,
    parseResponse = createExtensionUiResponseParser(defaultValue),
  ) => {
    if (options?.signal?.aborted) return Promise.resolve(defaultValue);
    const requestId = createExtensionUiRequestId();
    return new Promise<any>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const abort = () => {
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener?.("abort", onAbort);
      };
      const finish = (value: any) => {
        abort();
        pendingExtensionUiRequests.delete(requestId);
        resolve(value);
      };
      const onAbort = () => finish(defaultValue);
      options?.signal?.addEventListener?.("abort", onAbort, { once: true });
      if (Number(options?.timeout) > 0) {
        timer = setTimeout(() => finish(defaultValue), Number(options.timeout));
      }
      pendingExtensionUiRequests.set(requestId, {
        resolve: (response) => finish(parseResponse(response)),
        timer,
        abort,
      });
      output({ type: "extension_ui_request", id: requestId, ...request });
    });
  };

  const createExtensionUiContext = () => ({
    select: (title: string, options: string[], dialogOptions?: any) =>
      createExtensionUiDialogPromise(
        dialogOptions,
        undefined,
        { method: "select", title, options, timeout: dialogOptions?.timeout },
        createExtensionUiResponseParser(undefined),
      ),
    confirm: (title: string, message: string, dialogOptions?: any) =>
      createExtensionUiDialogPromise(
        dialogOptions,
        false,
        { method: "confirm", title, message, timeout: dialogOptions?.timeout },
        createExtensionUiResponseParser(false),
      ),
    input: (title: string, placeholder?: string, dialogOptions?: any) =>
      createExtensionUiDialogPromise(
        dialogOptions,
        undefined,
        {
          method: "input",
          title,
          placeholder,
          timeout: dialogOptions?.timeout,
        },
        createExtensionUiResponseParser(undefined),
      ),
    editor: (title: string, prefill?: string, dialogOptions?: any) =>
      createExtensionUiDialogPromise(
        dialogOptions,
        undefined,
        { method: "editor", title, prefill, timeout: dialogOptions?.timeout },
        createExtensionUiResponseParser(undefined),
      ),
    notify: (message: string, notifyType?: string) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "notify",
        message,
        notifyType,
      }),
    onTerminalInput: () => () => {},
    setStatus: (statusKey: string, statusText?: string) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "setStatus",
        statusKey,
        statusText,
      }),
    setWorkingMessage: (message?: string) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "setWorkingMessage",
        message,
      }),
    setWorkingVisible: (visible: boolean) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "setWorkingVisible",
        visible,
      }),
    setWorkingIndicator: (options?: any) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "setWorkingIndicator",
        options,
      }),
    setHiddenThinkingLabel: (label?: string) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "setHiddenThinkingLabel",
        label,
      }),
    setWidget: (widgetKey: string, content: unknown, options?: any) => {
      if (content !== undefined && !Array.isArray(content)) return;
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "setWidget",
        widgetKey,
        widgetLines: content,
        widgetPlacement: options?.placement,
      });
    },
    setFooter: (factory?: unknown) => {
      if (factory !== undefined) return;
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "setFooter",
      });
    },
    setHeader: (factory?: unknown) => {
      if (factory !== undefined) return;
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "setHeader",
      });
    },
    setTitle: (title: string) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "setTitle",
        title,
      }),
    custom: async () => undefined,
    pasteToEditor: (text: string) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "set_editor_text",
        text,
      }),
    setEditorText: (text: string) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "set_editor_text",
        text,
      }),
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({
      success: false,
      error:
        "Theme switching is not available through the daemon frontend bridge",
    }),
    getToolsExpanded: () => false,
    setToolsExpanded: (expanded: boolean) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "setToolsExpanded",
        expanded,
      }),
  });
  const run = async (
    id: string | undefined,
    type: string,
    fn: () => any,
    map?: (value: any) => any,
  ) => {
    const value = await fn();
    return done(id, type, map ? map(value) : value);
  };
  let activeTurnPromise: Promise<void> | null = null;
  const isTurnActive = () => Boolean(activeTurnPromise);
  let interruptQueue = Promise.resolve();
  let initialFreshSessionReusable =
    deps.reuseFreshSessionForInitialNewSession === true &&
    canReuseCurrentSessionForNewSessionCommand(getSession(), {});
  const emitTurnEvent = (
    event: string,
    requestTag: string,
    payload: Record<string, unknown> = {},
    force = false,
  ) => {
    if (!requestTag && !force) return;
    output({
      type: "rpc_turn_event",
      event,
      ...(requestTag ? { requestTag } : {}),
      ...payload,
    });
  };
  const abortCurrentSessionForReplacement = async () => {
    const current = getSession();
    if (!current) return;
    if (!current.isStreaming && !current.isCompacting && !isTurnActive()) {
      return;
    }
    await current.abort();
  };
  const startTurnTask = (
    requestTag: string,
    task: () => Promise<RinTurnCompletionResolution | void>,
    options: { forceTurnEvents?: boolean } = {},
  ) => {
    const turnSession = getSession();
    const baseline = captureRinTurnCompletionBaseline(turnSession);
    const promise = (async () => {
      const forceTurnEvents = options.forceTurnEvents === true;
      emitTurnEvent(
        "start",
        requestTag,
        {
          sessionFile: turnSession.sessionFile,
          sessionId: turnSession.sessionId,
        },
        forceTurnEvents,
      );
      const heartbeatTimer =
        requestTag || forceTurnEvents
          ? setInterval(() => {
              emitTurnEvent(
                "heartbeat",
                requestTag,
                {
                  sessionFile: turnSession.sessionFile,
                  sessionId: turnSession.sessionId,
                },
                forceTurnEvents,
              );
            }, TURN_HEARTBEAT_INTERVAL_MS)
          : null;
      try {
        const taskCompletion = await task();
        const { messages, completion } =
          taskCompletion ||
          (await resolveRinTurnCompletionAfterPromptSettledWithRechecks(
            turnSession,
            {
              baseline,
            },
          ));
        if (!completion.finalText) {
          const failureMessage = resolveRinTurnFailureMessage(
            turnSession,
            messages,
          );
          throw new Error(failureMessage || "rpc_turn_final_output_missing");
        }
        emitTurnEvent(
          "complete",
          requestTag,
          {
            sessionFile: turnSession.sessionFile,
            sessionId: turnSession.sessionId,
            finalText: completion.finalText,
            result: completion.result,
          },
          forceTurnEvents,
        );
      } catch (error: any) {
        emitTurnEvent(
          "error",
          requestTag,
          {
            error: String(error?.message || error || "rpc_turn_failed"),
          },
          forceTurnEvents,
        );
        throw error;
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (activeTurnPromise === promise) activeTurnPromise = null;
      }
    })();
    activeTurnPromise = promise;
    promise.catch(() => {});
  };
  const startInterruptTurnTask = (
    requestTag: string,
    task: () => Promise<RinTurnCompletionResolution | void>,
  ) => {
    interruptQueue = interruptQueue
      .then(
        async () => {
          const session = getSession();
          if (session.isStreaming || session.isCompacting)
            await session.abort();
          try {
            await activeTurnPromise;
          } catch {}
          startTurnTask(requestTag, task, { forceTurnEvents: true });
        },
        async () => {
          const session = getSession();
          if (session.isStreaming || session.isCompacting)
            await session.abort();
          try {
            await activeTurnPromise;
          } catch {}
          startTurnTask(requestTag, task, { forceTurnEvents: true });
        },
      )
      .catch(() => {});
  };
  let loginSeq = 0;
  const activeLogins = new Map<
    string,
    {
      abort: AbortController;
      waits: Map<
        string,
        { resolve: (value: string) => void; reject: (error: Error) => void }
      >;
    }
  >();
  const emitLoginEvent = (
    loginId: string,
    event: string,
    payload: Record<string, unknown> = {},
  ) => output({ type: "oauth_login_event", loginId, event, ...payload });
  const ensureLogin = (loginId: string) => {
    const login = activeLogins.get(loginId);
    if (!login) throw new Error(`Unknown OAuth login: ${loginId}`);
    return login;
  };
  const waitForLoginInput = (
    loginId: string,
    kind: string,
    payload: Record<string, unknown> = {},
  ) => {
    const login = ensureLogin(loginId);
    const requestId = `${loginId}:${kind}:${login.waits.size + 1}`;
    emitLoginEvent(loginId, kind, { requestId, ...payload });
    return new Promise<string>((resolve, reject) => {
      login.waits.set(requestId, { resolve, reject });
    });
  };
  const finishLogin = (loginId: string) => {
    const login = activeLogins.get(loginId);
    if (!login) return;
    for (const pending of login.waits.values())
      pending.reject(new Error("OAuth login cancelled"));
    activeLogins.delete(loginId);
  };

  let unsubscribeSessionEvents: (() => void) | undefined;
  const bindCurrentSession = async () => {
    const session = getSession();
    repairProviderInvalidToolResultEntries(session);
    await session.bindExtensions({
      uiContext: createExtensionUiContext(),
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => getSession().agent.waitForIdle(),
        newSession: async (options) => {
          await abortCurrentSessionForReplacement();
          const result = await runtime.newSession(options);
          await bindCurrentSession();
          return result;
        },
        fork: async (entryId, options) => {
          const result = await runtime.fork(entryId, options);
          await bindCurrentSession();
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => ({
          cancelled: (
            await getSession().navigateTree(targetId, {
              summarize: options?.summarize,
              customInstructions: options?.customInstructions,
              replaceInstructions: options?.replaceInstructions,
              label: options?.label,
            })
          ).cancelled,
        }),
        switchSession: async (sessionPath, options) => {
          const result = await runtime.switchSession(sessionPath, options);
          await bindCurrentSession();
          return result;
        },
        reload: async () => {
          await getSession().reload();
        },
      },
      onError: (err) => {
        output({
          type: "extension_error",
          extensionPath: err.extensionPath,
          event: err.event,
          error: err.error,
        });
      },
    });

    unsubscribeSessionEvents?.();
    unsubscribeSessionEvents = session.subscribe((event: unknown) => {
      output(withCompactionEventMetadata(session, event));
    });
  };

  await bindCurrentSession();

  const handleCommand = async (command: any) => {
    const session = getSession();
    const id = command?.id;
    const type = String(command?.type || "unknown");
    const usingInitialFreshSession = initialFreshSessionReusable;
    initialFreshSessionReusable = false;
    switch (type) {
      case "extension_ui_response":
        resolvePendingExtensionUiRequest(command);
        return done(id, type);
      case "prompt": {
        const streamingBehavior = command.streamingBehavior;
        const promptOptions: Record<string, unknown> = {
          images: command.images,
          streamingBehavior,
          source: command.source || "rpc",
        };
        if (command.requestTag !== undefined) {
          promptOptions.requestTag = command.requestTag;
        }
        if (command.promptContext !== undefined) {
          promptOptions.promptContext = command.promptContext;
        }
        const frontendIdentity = normalizeFrontendIdentity(
          command.frontendIdentity,
        );
        if (frontendIdentity !== undefined) {
          promptOptions.frontendIdentity = frontendIdentity;
        }
        if (streamingBehavior) {
          if (isTurnActive() && !session.isStreaming) {
            await promptWithQueueableTurnReceiver(
              session,
              command.message,
              promptOptions,
            );
          } else {
            await session.prompt(command.message, promptOptions);
          }
          return done(id, "prompt");
        }
        startTurnTask(String(command.requestTag || ""), async () => {
          await session.prompt(command.message, promptOptions);
        });
        return done(id, "prompt");
      }
      case "resume_interrupted_turn":
        startInterruptTurnTask(String(command.requestTag || ""), async () => {
          return await resumeInterruptedTurn(session);
        });
        return done(id, "resume_interrupted_turn");
      case "steer":
        return run(id, type, () =>
          session.steer(command.message, command.images),
        );
      case "follow_up":
        return run(id, type, () =>
          session.followUp(command.message, command.images),
        );
      case "clear_queue":
        return done(id, type, session.clearQueue());
      case "abort":
        return run(id, type, async () => {
          session.abortCompaction?.();
          await session.abort();
        });
      case "shutdown_session": {
        const frontendIdentity = normalizeFrontendIdentity(
          command.frontendIdentity,
        );
        if (frontendIdentity && session.sessionManager) {
          session.sessionManager.__rinFrontend = frontendIdentity;
        }
        await runtime.dispose();
        await forceFlushSessionFile(session);
        output(done(id, type, { shutdown: true }));
        return process.exit(0);
      }
      case "sleep_session":
        try {
          await session.abort();
        } catch {}
        await forceFlushSessionFile(session);
        session.dispose();
        output(done(id, type, { sleeping: true }));
        return process.exit(0);
      case "attach_session":
        return done(
          id,
          type,
          getSessionState(session, { turnActive: isTurnActive() }),
        );
      case "get_state":
        return done(
          id,
          type,
          getSessionState(session, { turnActive: isTurnActive() }),
        );
      case "cycle_model":
        return run(
          id,
          type,
          () => session.cycleModel(),
          (value) => value ?? null,
        );
      case "get_all_models":
        return done(id, type, { models: session.modelRegistry.getAll() });
      case "get_available_models":
        return run(
          id,
          type,
          () => session.modelRegistry.getAvailable(),
          (models) => ({ models }),
        );
      case "get_oauth_state":
        return done(id, type, getOAuthState(session));
      case "get_resource_diagnostics":
        return done(id, type, getResourceDiagnostics(session));
      case "get_command_argument_completions":
        return run(id, type, () =>
          getCommandArgumentCompletions(
            session,
            safeString(command.commandName).trim(),
            safeString(command.argumentPrefix),
          ),
        );
      case "set_thinking_level":
        return run(id, type, () =>
          setSessionThinkingLevel(session, safeString(command.level).trim(), {
            persistSettings:
              command.persistSettings === false ? false : undefined,
          }),
        );
      case "reset_model_options_from_settings":
        return run(id, type, () =>
          resetSessionModelOptionsFromSettings(session),
        );
      case "cycle_thinking_level":
        return run(
          id,
          type,
          () => session.cycleThinkingLevel(),
          (level) => (level ? { level } : null),
        );
      case "set_steering_mode":
        return run(id, type, () => session.setSteeringMode(command.mode));
      case "set_follow_up_mode":
        return run(id, type, () => session.setFollowUpMode(command.mode));
      case "compact":
        return run(id, type, async () => {
          const value = await session.compact(command.customInstructions);
          return {
            ...(value && typeof value === "object" ? value : {}),
            tokensBefore: latestCompactionTokensBefore(session),
          };
        });
      case "set_auto_compaction":
        return run(id, type, () =>
          session.setAutoCompactionEnabled(Boolean(command.enabled)),
        );
      case "set_auto_retry":
        return run(id, type, () =>
          session.setAutoRetryEnabled(Boolean(command.enabled)),
        );
      case "abort_retry":
        return run(id, type, () => session.abortRetry());
      case "bash":
        return run(id, type, () =>
          session.executeBash(command.command, undefined, {
            excludeFromContext: command.excludeFromContext,
          }),
        );
      case "abort_bash":
        return run(id, type, () => session.abortBash());
      case "get_session_stats":
        return done(id, type, session.getSessionStats());
      case "get_session_snapshot":
        return done(id, type, {
          entries: session.sessionManager.getEntries(),
          leafId: session.sessionManager.getLeafId(),
        });
      case "set_entry_label":
        return run(id, type, () =>
          session.sessionManager.appendLabelChange(
            command.entryId,
            command.label?.trim() || undefined,
          ),
        );
      case "navigate_tree":
        return run(id, type, () =>
          session.navigateTree(command.targetId, {
            summarize: command.summarize,
            customInstructions: command.customInstructions,
            replaceInstructions: command.replaceInstructions,
            label: command.label,
          }),
        );
      case "export_html":
        return run(
          id,
          type,
          () => session.exportToHtml(command.outputPath),
          (path) => ({ path }),
        );
      case "export_jsonl":
        return done(id, type, {
          path: session.exportToJsonl(command.outputPath),
        });
      case "import_jsonl":
        return run(
          id,
          type,
          async () => {
            const value = await runtime.importFromJsonl(command.inputPath);
            await bindCurrentSession();
            return value;
          },
          (value) => ({ cancelled: Boolean(value?.cancelled) }),
        );
      case "get_fork_messages":
        return done(id, type, {
          messages: session.getUserMessagesForForking(),
        });
      case "get_last_assistant_text":
        return done(id, type, { text: session.getLastAssistantText() });
      case "get_messages":
        return done(id, type, { messages: session.messages });
      case "resolve_submitted_turn": {
        const resolved = resolveSubmittedTurnFromMessages(session.messages, {
          text: safeString(command.text).trim(),
          sentAt: Number(command.sentAt || 0),
        });
        if (resolved && !("submitted" in resolved)) {
          return done(id, type, {
            ...resolved,
            sessionId: session.sessionId,
            sessionFile: session.sessionFile,
          });
        }
        return done(id, type, resolved);
      }
      case "get_active_tools":
        return done(id, type, {
          tools: session.getActiveToolNames?.() || [],
        });
      case "get_all_tools":
        return done(id, type, {
          tools: session.getAllTools?.() || [],
        });
      case "set_active_tools": {
        const toolNames = Array.isArray(command.toolNames)
          ? command.toolNames
              .map((name: unknown) => safeString(name).trim())
              .filter(Boolean)
          : [];
        session.setActiveToolsByName?.(toolNames);
        return done(id, type, {
          tools: session.getActiveToolNames?.() || toolNames,
        });
      }
      case "refresh_tools":
        refreshPiSessionToolRegistry(session);
        return done(id, type, {
          tools: session.getAllTools?.() || [],
        });
      case "append_custom_entry": {
        const customType = safeString(command.customType).trim();
        if (!customType) throw new Error("customType is required");
        session.sessionManager?.appendCustomEntry?.(customType, command.data);
        return done(id, type);
      }
      case "send_custom_message":
        return run(id, type, async () => {
          await session.sendCustomMessage(command.message, command.options);
          return { sent: true };
        });
      case "send_user_message":
        startTurnTask(String(command.requestTag || ""), async () => {
          await session.sendUserMessage(command.content, command.options);
        });
        return done(id, type, { sent: true });
      case "get_commands":
        return done(id, type, {
          commands: getSlashCommands(session),
        });
      case "run_command": {
        const commandLine = String(command.commandLine || "").trim();
        const commandName = commandLine.startsWith("/")
          ? commandLine.split(/\s+/, 1)[0]?.slice(1) || ""
          : "";
        return run(
          id,
          type,
          async () => {
            if (isWorkerLocalSessionReplacementCommand(commandLine)) {
              return {
                handled: true,
                text: "Session replacement commands must be routed through the frontend.",
              };
            }
            const builtinResult = await runBuiltinCommand(
              runtime,
              commandLine,
              {
                SessionManager,
                uiContext: createExtensionUiContext(),
              },
            );
            if (builtinResult.handled) return builtinResult;
            if (
              commandName &&
              session.extensionRunner?.getCommand?.(commandName)
            ) {
              await session.prompt(commandLine);
              return { handled: true };
            }
            return builtinResult;
          },
          (value) => value,
        );
      }
      case "new_session":
        if (
          usingInitialFreshSession &&
          canReuseCurrentSessionForNewSessionCommand(session, command)
        ) {
          return done(id, type, {
            cancelled: false,
            sessionFile: session.sessionFile,
            sessionId: session.sessionId,
          });
        }
        return run(
          id,
          type,
          async () => {
            const frontendIdentity = normalizeFrontendIdentity(
              command.frontendIdentity,
            );
            if (frontendIdentity && session.sessionManager) {
              session.sessionManager.__rinFrontend = frontendIdentity;
            }
            await abortCurrentSessionForReplacement();
            const managedSessionLeaf = safeString(
              command.managedSessionLeaf || "",
            ).trim();
            if (safeString(command.sessionFile || command.sessionPath).trim()) {
              throw new Error("new_session_session_file_unsupported");
            }
            const value = managedSessionLeaf
              ? await createManagedNewSession(runtime, SessionManager, {
                  managedSessionLeaf,
                  parentSession: command.parentSession,
                })
              : await runtime.newSession(
                  command.parentSession
                    ? { parentSession: command.parentSession }
                    : undefined,
                );
            await bindCurrentSession();
            const rebound = getSession();
            return {
              cancelled: Boolean(value?.cancelled),
              sessionFile: rebound?.sessionFile,
              sessionId: rebound?.sessionId,
            };
          },
          (value) => value,
        );
      case "switch_session": {
        const sessionFile = requireSessionFile(command);
        return run(
          id,
          type,
          () => {
            const frontendIdentity = normalizeFrontendIdentity(
              command.frontendIdentity,
            );
            if (frontendIdentity && session.sessionManager) {
              session.sessionManager.__rinFrontend = frontendIdentity;
            }
            return runtime
              .switchSession(sessionFile)
              .then(async (value: any) => {
                await bindCurrentSession();
                const rebound = getSession();
                return {
                  cancelled: Boolean(value?.cancelled),
                  sessionFile: rebound?.sessionFile,
                  sessionId: rebound?.sessionId,
                };
              });
          },
          (value) => value,
        );
      }
      case "fork":
        return run(
          id,
          type,
          () =>
            runtime.fork(command.entryId).then(async (value: any) => {
              await bindCurrentSession();
              return value;
            }),
          (value) => ({ text: value.selectedText, cancelled: value.cancelled }),
        );
      case "list_sessions": {
        if (command.limit !== undefined || command.offset !== undefined) {
          const currentSession = getSession();
          return done(
            id,
            type,
            await listBoundSessionPage({
              cwd:
                safeString(runtime.cwd).trim() ||
                safeString(currentSession?.sessionManager?.getCwd?.()).trim(),
              agentDir: safeString(runtime.services?.agentDir).trim(),
              limit: command.limit,
              offset: command.offset,
            }),
          );
        }
        const sessions = await listBoundSessions({ SessionManager });
        return done(id, type, { sessions });
      }
      case "set_model": {
        const models = await session.modelRegistry.getAvailable();
        const model = models.find(
          (m: any) =>
            m.provider === command.provider && m.id === command.modelId,
        );
        if (!model)
          throw new Error(
            `Model not found: ${command.provider}/${command.modelId}`,
          );
        await setSessionModel(session, model, {
          persistSettings:
            command.persistSettings === false ? false : undefined,
        });
        return done(id, type, model);
      }
      case "rename_session": {
        await renameBoundSession(command, command.name, {
          SessionManager,
        });
        return done(id, type);
      }
      case "set_session_name": {
        const name = String(command.name || "").trim();
        if (!name) throw new Error("Session name cannot be empty");
        session.setSessionName(name);
        return done(id, type);
      }
      case "oauth_login_start": {
        const providerId = String(command.providerId || "").trim();
        if (!providerId) throw new Error("providerId is required");
        const loginId = `login_${++loginSeq}`;
        const abort = new AbortController();
        activeLogins.set(loginId, { abort, waits: new Map() });
        (async () => {
          try {
            await session.modelRegistry.authStorage.login(providerId, {
              onAuth: (info: { url: string; instructions?: string }) =>
                emitLoginEvent(loginId, "auth", {
                  url: info.url,
                  instructions: info.instructions,
                }),
              onPrompt: (prompt: { message: string; placeholder?: string }) =>
                waitForLoginInput(loginId, "prompt", {
                  message: prompt.message,
                  placeholder: prompt.placeholder,
                }),
              onProgress: (message: string) =>
                emitLoginEvent(loginId, "progress", { message }),
              onManualCodeInput: () =>
                waitForLoginInput(loginId, "manual_code"),
              signal: abort.signal,
            });
            session.modelRegistry.refresh();
            emitLoginEvent(loginId, "complete", {
              success: true,
              state: getOAuthState(session),
            });
          } catch (error: any) {
            emitLoginEvent(loginId, "complete", {
              success: false,
              error: String(error?.message || error || "oauth_login_failed"),
            });
          } finally {
            finishLogin(loginId);
          }
        })().catch(() => {});
        return done(id, type, { loginId });
      }
      case "oauth_login_respond": {
        const login = ensureLogin(String(command.loginId || ""));
        const requestId = String(command.requestId || "");
        const pending = login.waits.get(requestId);
        if (!pending)
          throw new Error(`Unknown OAuth login request: ${requestId}`);
        login.waits.delete(requestId);
        pending.resolve(String(command.value || ""));
        return done(id, type);
      }
      case "oauth_login_cancel": {
        const loginId = String(command.loginId || "");
        const login = ensureLogin(loginId);
        login.abort.abort();
        finishLogin(loginId);
        return done(id, type);
      }
      case "oauth_set_api_key": {
        const providerId = String(command.providerId || "").trim();
        const key = String(command.key || "").trim();
        if (!providerId) throw new Error("providerId is required");
        if (!key) throw new Error("key is required");
        session.modelRegistry.authStorage.set(providerId, {
          type: "api_key",
          key,
        });
        session.modelRegistry.refresh();
        return done(id, type, getOAuthState(session));
      }
      case "oauth_logout": {
        const providerId = String(command.providerId || "").trim();
        if (!providerId) throw new Error("providerId is required");
        session.modelRegistry.authStorage.logout(providerId);
        session.modelRegistry.refresh();
        return done(id, type, getOAuthState(session));
      }
      default:
        throw new Error(`Unknown command: ${type}`);
    }
  };

  const state = { buffer: "" };
  process.stdin.on("data", (chunk) => {
    parseJsonl(String(chunk), state, async (line) => {
      let command: any;
      try {
        command = JSON.parse(line);
      } catch (error) {
        output(fail(undefined, "parse", error));
        return;
      }
      try {
        const reply = await handleCommand(command);
        if (reply) output(reply);
      } catch (error) {
        output(fail(command?.id, command?.type || "unknown", error));
      }
    });
  });

  await new Promise<never>(() => {});
}
