import {
  extractPiContinuableToolCallIds,
  extractPiContinuableToolCallParts,
} from "../pi/tool-continuation.js";
import {
  requestProcessTermination,
  type ProcessTermination,
} from "../platform/process-lifetime.js";
import { parseJsonl } from "../rin-lib/common.js";
import { createInterruptedToolResultMessage } from "../rin-lib/interruption.js";
import { fail, ok } from "../rin-lib/rpc.js";
import {
  listBoundSessionPage,
  listBoundSessions,
  renameBoundSession,
} from "../session/factory.js";
import {
  captureTurnScope,
  readTurnMessages,
  type RinTurnScope,
} from "../session/turn-scope.js";
import { normalizeFrontendIdentity } from "../rin-lib/frontend-identity.js";
type RetryFailure = { attempt: number; finalError: string };
import {
  RIN_TURN_TERMINAL_ABSENT,
  RinTurnSettlementProjector,
  resolveRinTurnFailureMessage,
  resolveRinTurnTerminalOutcomeFromTurnResult,
  type RinTurnTerminalOutcome,
} from "../session/turn-completion.js";
import {
  emitPiSessionEvent,
  refreshPiSessionToolRegistry,
  resumePiSessionTurn,
} from "../pi/session-host.js";
import { safeString } from "../text-utils.js";
import { rawErrorMessage } from "../rin-lib/error-facts.js";
import {
  RpcTurnCoordinator,
  type RpcTurnInterrupt,
} from "./rpc-turn-coordinator.js";
import { createRpcAuthCommandHandlers } from "./rpc-auth-command-handler.js";
import { createRpcCommandDispatcher } from "./rpc-command-dispatcher.js";
import { createRpcExtensionUiCommandHandlers } from "./rpc-extension-ui-command-handler.js";
import { createRpcResourceCommandHandlers } from "./rpc-resource-command-handler.js";
import { createRpcSessionCommandHandlers } from "./rpc-session-command-handler.js";
import { createRpcTurnCommandHandlers } from "./rpc-turn-command-handler.js";
import { canInvokeRuntimeSlashCommand } from "./catalog-helpers.js";
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
const THINKING_LEVEL_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const sessionSettingsMutationQueues = new WeakMap<object, Promise<unknown>>();

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

function stableJson(value: any) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function rpcRequestTag(value: unknown) {
  return typeof value === "string" ? value : "";
}

type NativeInputOutcome =
  | "terminalOwner"
  | "nonterminal"
  | "rejected"
  | "indeterminate";

function nativeInputOutcome(
  session: any,
  outcome: NativeInputOutcome | "rejoined",
  requestTag: unknown,
  options: {
    turnActive: boolean;
    originalOutcome?: NativeInputOutcome;
  },
) {
  const normalizedRequestTag = rpcRequestTag(requestTag);
  return {
    outcome,
    ...(options.originalOutcome
      ? { originalOutcome: options.originalOutcome }
      : {}),
    ...(normalizedRequestTag.length > 0
      ? { requestTag: normalizedRequestTag }
      : {}),
    sessionFile: session?.sessionFile,
    sessionId: session?.sessionId,
    turnActive: options.turnActive,
    isStreaming: Boolean(session?.isStreaming),
  };
}

function getSessionEntries(session: any) {
  return Array.isArray(session?.sessionManager?.getEntries?.())
    ? session.sessionManager.getEntries()
    : [];
}

function getSessionEntriesSince(session: any, since: unknown) {
  const entries = getSessionEntries(session);
  const cursor = safeString(since).trim();
  if (!cursor) return { entries };
  const index = entries.findIndex((entry: any) => entry?.id === cursor);
  if (index < 0) return { error: `Unknown session entry cursor: ${cursor}` };
  return { entries: entries.slice(index + 1) };
}

function persistedNativeIdentityOutcome(
  session: any,
  requestTag: string,
): "terminalOwner" | "nonterminal" | undefined {
  if (!requestTag) return undefined;
  const entries = getSessionEntries(session);
  const userEntryIndexes = new Map<string, number[]>();
  entries.forEach((entry: any, index: number) => {
    if (entry?.type !== "message" || entry?.message?.role !== "user") return;
    const entryId = safeString(entry.id).trim();
    if (!entryId) return;
    const indexes = userEntryIndexes.get(entryId) || [];
    indexes.push(index);
    userEntryIndexes.set(entryId, indexes);
  });
  const identities = entries
    .map((entry: any, index: number) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry?.type === "custom" &&
        entry?.customType === "rin_request_identity" &&
        safeString(entry?.data?.requestId).trim() === requestTag,
    );
  if (identities.length !== 1) return undefined;
  const identity = identities[0];
  const messageEntryId = safeString(
    identity.entry?.data?.messageEntryId,
  ).trim();
  const messageIndexes = userEntryIndexes.get(messageEntryId) || [];
  if (messageIndexes.length !== 1 || messageIndexes[0] >= identity.index) {
    return undefined;
  }
  const observedRole = safeString(identity.entry?.data?.observedRole).trim();
  return observedRole === "terminalOwner" || observedRole === "nonterminal"
    ? observedRole
    : undefined;
}

function persistedNativeRequestOutcome(
  session: any,
  requestTag: string,
): NativeInputOutcome | undefined {
  const entries = getSessionEntries(session);
  const identityEntries = entries.filter(
    (entry: any) =>
      entry?.type === "custom" &&
      entry?.customType === "rin_request_identity" &&
      safeString(entry?.data?.requestId).trim() === requestTag,
  );
  const identityOutcome = persistedNativeIdentityOutcome(session, requestTag);
  const outcomeEntries = entries.filter(
    (entry: any) =>
      entry?.type === "custom" &&
      entry?.customType === "rin_request_outcome" &&
      safeString(entry?.data?.requestId).trim() === requestTag,
  );
  if (identityEntries.length && outcomeEntries.length) return undefined;
  if (identityEntries.length) return identityOutcome;
  if (outcomeEntries.length !== 1) return undefined;
  const outcome = safeString(outcomeEntries[0]?.data?.outcome).trim();
  return outcome === "rejected" || outcome === "indeterminate"
    ? outcome
    : undefined;
}

function nativeRequestReceiptState(
  session: any,
  requestTag: string,
): "missing" | "valid" | "conflict" {
  const receipts = getSessionEntries(session).filter(
    (entry: any) =>
      entry?.type === "custom" &&
      (entry?.customType === "rin_request_identity" ||
        entry?.customType === "rin_request_outcome") &&
      safeString(entry?.data?.requestId).trim() === requestTag,
  );
  if (!receipts.length) return "missing";
  return persistedNativeRequestOutcome(session, requestTag)
    ? "valid"
    : "conflict";
}

function persistNativeRequestOutcome(
  session: any,
  requestTag: string,
  outcome: "rejected" | "indeterminate",
) {
  if (!requestTag) return true;
  if (persistedNativeRequestOutcome(session, requestTag) === outcome) {
    return true;
  }
  session?.sessionManager?.appendCustomEntry?.("rin_request_outcome", {
    requestId: requestTag,
    outcome,
  });
  return persistedNativeRequestOutcome(session, requestTag) === outcome;
}

function hasPersistedUserRequestTag(session: any, requestTag: string) {
  return Boolean(
    requestTag && persistedNativeIdentityOutcome(session, requestTag),
  );
}

async function waitForPersistedUserRequestTag(
  session: any,
  requestTag: string,
) {
  if (hasPersistedUserRequestTag(session, requestTag)) return;
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      const receiptState = nativeRequestReceiptState(session, requestTag);
      if (receiptState === "missing") return;
      clearInterval(pollTimer);
      if (receiptState === "conflict") {
        reject(new Error("rin_prompt_outcome_indeterminate"));
        return;
      }
      resolve();
    };
    const pollTimer = setInterval(check, 10);
    pollTimer.unref();
    check();
  });
}

function getSessionLeafId(session: any) {
  return session?.sessionManager?.getLeafId?.() ?? null;
}

function getSessionTree(session: any) {
  const tree = session?.sessionManager?.getTree?.();
  return Array.isArray(tree) ? tree : [];
}

function ensureInterruptedAssistantPersisted(session: any, message: any) {
  const manager = session?.sessionManager;
  if (typeof manager?.appendMessage !== "function") return;
  const serialized = stableJson(message);
  const persisted = getSessionEntries(session).some(
    (entry: any) =>
      entry?.type === "message" && stableJson(entry.message) === serialized,
  );
  if (!persisted) manager.appendMessage(message);
}

function appendInterruptedToolResults(
  session: any,
  options: { persistToSession?: boolean } = {},
) {
  const messages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  let assistantIndex = messages.length - 1;
  while (
    assistantIndex >= 0 &&
    messages[assistantIndex]?.role === "toolResult"
  ) {
    assistantIndex -= 1;
  }
  if (assistantIndex < 0) return false;
  const toolCalls = extractPiContinuableToolCallParts(messages[assistantIndex]);
  if (!toolCalls.length) return false;
  const completedToolCallIds = new Set(
    messages
      .slice(assistantIndex + 1)
      .filter((message: any) => message?.role === "toolResult")
      .map((message: any) => safeString(message?.toolCallId).trim())
      .filter(Boolean),
  );
  const interruptedToolCalls = toolCalls.filter(
    (toolCall) => !completedToolCallIds.has(safeString(toolCall?.id).trim()),
  );
  if (!interruptedToolCalls.length) return false;

  const persistToSession = options.persistToSession !== false;
  if (persistToSession) {
    ensureInterruptedAssistantPersisted(session, messages[assistantIndex]);
  }

  for (const toolCall of interruptedToolCalls) {
    const message = createInterruptedToolResultMessage(toolCall);
    session.agent.state.messages.push(message);
    if (persistToSession) session.sessionManager.appendMessage(message);
  }
  return true;
}

function isAssistantFailureMessage(message: any) {
  if (safeString(message?.role).trim() !== "assistant") return false;
  const stopReason = safeString(message?.stopReason).trim();
  return stopReason === "error" || stopReason === "aborted";
}

function discardInterruptedAssistantFailures(session: any) {
  const messages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  while (isAssistantFailureMessage(messages.at(-1))) messages.pop();
}

async function resumeInterruptedTurn(
  session: any,
  invocationContext?: {
    source?: unknown;
    frontendIdentity?: unknown;
    promptContext?: unknown;
  },
) {
  const messages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  if (!messages.length) return;
  if (isAssistantFailureMessage(messages.at(-1))) {
    // A persisted failure without a daemon terminal is not a settled result.
    // Pi owns retry policy for the new continuation; Rin only restores a
    // provider-valid context and never replays the accepted user input.
    discardInterruptedAssistantFailures(session);
    await resumePiSessionTurn(session, invocationContext);
    return;
  }

  const appendedInterruption = appendInterruptedToolResults(session);
  const lastMessage = session.agent.state.messages.at(-1);
  if (!appendedInterruption && lastMessage?.role === "assistant") {
    return {
      finalText: safeString(session.getLastAssistantText?.()),
      result: { messages: [lastMessage] },
    };
  }
  await resumePiSessionTurn(session);
}

export async function abortInterruptedTurnAfterExecutionLoss(session: any) {
  const messages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  if (!messages.length) {
    await session.abort();
    return;
  }
  const appendedInterruption = appendInterruptedToolResults(session);
  const lastMessage = session.agent.state.messages.at(-1);
  if (!appendedInterruption && lastMessage?.role === "assistant") {
    return {
      finalText: safeString(session.getLastAssistantText?.()),
      result: { messages: [lastMessage] },
    };
  }
  const continuation = resumePiSessionTurn(session);
  await session.abort();
  await continuation;
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

async function flushSessionSettings(session: any) {
  const settings = session?.settingsManager;
  await settings?.flush?.();
  const errors = settings?.drainErrors?.();
  if (!Array.isArray(errors) || errors.length === 0) return;
  const detail = errors
    .map((item: any) => rawErrorMessage(item?.error ?? item))
    .filter(Boolean)
    .join("; ");
  throw new Error(`rin_settings_write_failed${detail ? `: ${detail}` : ""}`);
}

async function runPersistedSessionMutation<T>(
  session: any,
  mutate: () => T | Promise<T>,
) {
  const settings = session?.settingsManager;
  if (!settings || typeof settings !== "object") {
    const value = await mutate();
    await flushSessionSettings(session);
    return value;
  }
  const previous = sessionSettingsMutationQueues.get(settings);
  const ready = previous
    ? previous.then(
        () => undefined,
        () => undefined,
      )
    : Promise.resolve();
  const current = ready.then(async () => {
    const value = await mutate();
    await flushSessionSettings(session);
    return value;
  });
  sessionSettingsMutationQueues.set(settings, current);
  try {
    return await current;
  } finally {
    if (sessionSettingsMutationQueues.get(settings) === current) {
      sessionSettingsMutationQueues.delete(settings);
    }
  }
}

async function setPersistentSessionThinkingLevel(session: any, level: string) {
  return await runPersistedSessionMutation(session, async () => {
    const result = await setSessionThinkingLevel(session, level);
    const effectiveLevel = safeString(
      result?.level || session?.thinkingLevel || level,
    ).trim();
    const settings = session?.settingsManager;
    if (
      effectiveLevel &&
      settings?.getDefaultThinkingLevel?.() !== effectiveLevel
    ) {
      settings?.setDefaultThinkingLevel?.(effectiveLevel);
    }
    return result ?? (effectiveLevel ? { level: effectiveLevel } : undefined);
  });
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
  const models = sessionModelRuntime(session);
  const authTarget = session?.modelRuntime ? model?.provider : model;
  if (
    typeof models.hasConfiguredAuth === "function" &&
    !models.hasConfiguredAuth(authTarget)
  ) {
    throw new Error(`No API key for ${model.provider}/${model.id}`);
  }
  const thinkingLevel = safeString(session.thinkingLevel).trim() || "medium";
  session.agent.state.model = model;
  session.sessionManager?.appendModelChange?.(model.provider, model.id);
  setSessionThinkingLevel(session, thinkingLevel, { persistSettings: false });
  return model;
}

function sessionModelRuntime(session: any) {
  const runtime = session?.modelRuntime || session?.modelRegistry;
  if (!runtime) throw new Error("rin_session_model_runtime_unavailable");
  return runtime;
}

function sessionAllModels(session: any) {
  const runtime = sessionModelRuntime(session);
  const models =
    typeof runtime.getModels === "function"
      ? runtime.getModels()
      : runtime.getAll?.();
  return Array.isArray(models) ? [...models] : [];
}

async function sessionAvailableModels(session: any) {
  const models = await sessionModelRuntime(session).getAvailable();
  return Array.isArray(models) ? [...models] : [];
}

function combinedLoginPromptSignal(
  promptSignal?: AbortSignal,
  loginSignal?: AbortSignal,
) {
  const signals = [promptSignal, loginSignal].filter(Boolean) as AbortSignal[];
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

export async function loginSessionProvider(
  session: any,
  providerId: string,
  callbacks: any,
) {
  const runtime = sessionModelRuntime(session);
  const authType = callbacks.authType === "api_key" ? "api_key" : "oauth";
  if (authType === "oauth" && runtime.authStorage?.login) {
    return await runtime.authStorage.login(providerId, callbacks);
  }
  return await runtime.login(providerId, authType, {
    signal: callbacks.signal,
    prompt: async (prompt: any) => {
      const signal = combinedLoginPromptSignal(prompt.signal, callbacks.signal);
      if (prompt.type === "select") {
        return await callbacks.onSelect({ ...prompt, signal });
      }
      if (prompt.type === "manual_code") {
        return await callbacks.onManualCodeInput({ ...prompt, signal });
      }
      return await callbacks.onPrompt({
        type: prompt.type,
        message: prompt.message,
        placeholder: prompt.placeholder,
        // Current Pi AuthPrompt leaves blank-input policy to the provider.
        // Preserve flows such as GitHub Enterprise's blank-for-default host.
        allowEmpty: true,
        signal,
      });
    },
    notify: (event: any) => {
      if (event.type === "auth_url") return callbacks.onAuth(event);
      if (event.type === "device_code") return callbacks.onDeviceCode(event);
      if (event.type === "info") return callbacks.onInfo(event);
      if (event.type === "progress") return callbacks.onProgress(event.message);
    },
  });
}

async function refreshSessionModels(session: any) {
  const runtime = sessionModelRuntime(session);
  await runtime.refresh?.();
}

export async function setSessionApiKey(
  session: any,
  providerId: string,
  key: string,
) {
  const runtime = sessionModelRuntime(session);
  if (runtime.authStorage?.set) {
    runtime.authStorage.set(providerId, { type: "api_key", key });
  } else {
    let promptAnswered = false;
    await runtime.login(providerId, "api_key", {
      prompt: async (prompt: any) => {
        if (promptAnswered || prompt?.type !== "secret") {
          throw new Error(
            `Provider ${providerId} requires interactive API-key setup`,
          );
        }
        promptAnswered = true;
        return key;
      },
      notify: () => {},
    });
  }
  await refreshSessionModels(session);
}

async function logoutSessionProvider(session: any, providerId: string) {
  const runtime = sessionModelRuntime(session);
  if (runtime.authStorage?.logout) {
    await runtime.authStorage.logout(providerId);
  } else {
    await runtime.logout(providerId);
  }
  await refreshSessionModels(session);
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
    const models = await sessionAvailableModels(session);
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

function captureTurnScopeBeforeUserMessage(
  session: any,
  userMessage: any,
  previousScope: RinTurnScope,
): RinTurnScope {
  const currentScope = captureTurnScope(session);
  if (currentScope.sessionManager !== previousScope.sessionManager) {
    return previousScope;
  }
  const branch = currentScope.sessionManager.getBranch();
  const previousBaselineIndex = previousScope.baselineLeafId
    ? branch.findIndex(
        (entry: any) => entry?.id === previousScope.baselineLeafId,
      )
    : -1;
  if (previousScope.baselineLeafId && previousBaselineIndex < 0) {
    return previousScope;
  }
  const requestTag = safeString(userMessage?.requestTag).trim();
  let userEntryIndex = -1;
  for (
    let index = branch.length - 1;
    index > previousBaselineIndex;
    index -= 1
  ) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    if (
      entry.message === userMessage ||
      (requestTag &&
        safeString(entry.message?.requestTag).trim() === requestTag)
    ) {
      userEntryIndex = index;
      break;
    }
  }
  if (userEntryIndex < 0) return currentScope;
  const userEntry = branch[userEntryIndex];
  const baselineLeafId =
    safeString(userEntry?.parentId).trim() ||
    safeString(branch[userEntryIndex - 1]?.id).trim() ||
    null;
  return {
    sessionManager: currentScope.sessionManager,
    baselineLeafId,
  };
}

function isWorkerLocalSessionReplacementCommand(commandLine: string) {
  const trimmed = safeString(commandLine).trim();
  if (trimmed === "/new") return true;
  if (!trimmed.startsWith("/resume ")) return false;
  return Boolean(trimmed.slice("/resume ".length).trim());
}

export function nextOAuthLoginRequestId(
  login: { nextWaitSeq: number },
  loginId: string,
  kind: string,
) {
  return `${loginId}:${kind}:${++login.nextWaitSeq}`;
}

export function deferOAuthLoginStart(task: () => void | Promise<void>) {
  setImmediate(() => {
    void Promise.resolve()
      .then(task)
      .catch(() => {});
  });
}

export async function runCustomRpcMode(
  runtimeOrSession: any,
  deps: {
    SessionManager: any;
    terminateProcess?: ProcessTermination;
  },
) {
  const { SessionManager } = deps;
  const terminateProcess = deps.terminateProcess ?? requestProcessTermination;
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
    rinCommandResult: (result: unknown) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "rinCommandResult",
        result,
      }),
    rinChatPresentation: (presentation: unknown) => {
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "rinChatPresentation",
        presentation,
      });
    },
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
        visible: Boolean(visible),
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
  const turnCoordinator = new RpcTurnCoordinator<RinTurnTerminalOutcome>();
  type NativeInputSubmission = {
    requestTag: string;
    streamingBehavior: "steer" | "followUp";
    promptTask?: Promise<unknown>;
    promptTaskReady: Promise<void>;
    resolvePromptTaskReady: () => void;
    turnScope: ReturnType<typeof captureTurnScope>;
    admissionToken?: ReturnType<typeof turnCoordinator.admit>;
    outcome?: NativeInputOutcome;
    resolveObserved: (outcome: NativeInputOutcome) => void;
    observed: Promise<NativeInputOutcome>;
  };
  const turnState: {
    pendingNativeInputSubmission?: NativeInputSubmission;
    nativeInputAdmissionTail: Promise<void>;
    gracefulSessionShutdown: boolean;
  } = {
    nativeInputAdmissionTail: Promise.resolve(),
    gracefulSessionShutdown: false,
  };
  let latestAutoRetryFailure: RetryFailure | undefined;
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
      ...(requestTag || force ? { requestTag } : {}),
      ...payload,
    });
  };
  const observeNativeInput = (
    submission: NativeInputSubmission,
    outcome: NativeInputOutcome,
  ) => {
    if (submission.outcome) return;
    submission.outcome = outcome;
    if (turnState.pendingNativeInputSubmission === submission) {
      turnState.pendingNativeInputSubmission = undefined;
    }
    submission.resolveObserved(outcome);
  };
  const observeNativeTerminalOwner = (
    submission: NativeInputSubmission,
  ): Promise<void> | undefined => {
    if (submission.outcome) return undefined;
    const startOwner = () => {
      if (submission.outcome) return;
      startTurnTask(
        submission.requestTag,
        async () => {
          await submission.promptTaskReady;
          if (!submission.promptTask) {
            throw new Error("rin_prompt_task_missing");
          }
          return await submission.promptTask;
        },
        { turnScope: submission.turnScope },
      );
      submission.admissionToken = turnCoordinator.admit({
        requestTag: submission.requestTag,
        observedRole: "terminalOwner",
      });
      observeNativeInput(submission, "terminalOwner");
    };
    if (!turnCoordinator.isActive) {
      startOwner();
      return undefined;
    }
    return turnCoordinator.waitForIdle().then(startOwner);
  };
  const startTurnTask = (
    requestTag: string,
    task: () => Promise<unknown>,
    options: {
      forceTurnEvents?: boolean;
      interrupt?: RpcTurnInterrupt;
      turnScope?: ReturnType<typeof captureTurnScope>;
    } = {},
  ) => {
    if (turnCoordinator.isActive) throw new Error("rpc_turn_already_active");
    latestAutoRetryFailure = undefined;
    const turnSession = getSession();
    let terminalScope = options.turnScope ?? captureTurnScope(turnSession);
    const trackedTurn = turnCoordinator.openTurn(
      requestTag,
      (message) => {
        terminalScope = captureTurnScopeBeforeUserMessage(
          turnSession,
          message,
          terminalScope,
        );
        turnSettlement.reset();
      },
      options.interrupt,
    );
    const turnSettlement = new RinTurnSettlementProjector(
      turnSession,
      (outcome) => trackedTurn.observeAgentSettlement(outcome),
    );
    const agentSettledOutcome = trackedTurn.firstSettlement;
    const currentTurnGeneration = trackedTurn.turnGeneration;
    const promise = (async () => {
      const forceTurnEvents = options.forceTurnEvents === true;
      emitTurnEvent(
        "start",
        requestTag,
        {
          turnGeneration: currentTurnGeneration,
          sessionFile: turnSession.sessionFile,
          sessionId: turnSession.sessionId,
        },
        forceTurnEvents,
      );
      const heartbeatTimer: NodeJS.Timeout | null =
        requestTag || forceTurnEvents
          ? setInterval(() => {
              emitTurnEvent(
                "heartbeat",
                requestTag,
                {
                  turnGeneration: currentTurnGeneration,
                  sessionFile: turnSession.sessionFile,
                  sessionId: turnSession.sessionId,
                },
                forceTurnEvents,
              );
            }, TURN_HEARTBEAT_INTERVAL_MS)
          : null;
      heartbeatTimer?.unref();
      const commitTurnTerminal = (
        outcome:
          | Extract<RinTurnTerminalOutcome, { kind: "complete" }>
          | { kind: "error"; error: string },
      ) => {
        const event = outcome.kind === "complete" ? "complete" : "error";
        const payload =
          outcome.kind === "complete"
            ? {
                turnGeneration: currentTurnGeneration,
                sessionFile: turnSession.sessionFile,
                sessionId: turnSession.sessionId,
                finalText: outcome.resolution.completion.finalText,
                result: outcome.resolution.completion.result,
              }
            : {
                turnGeneration: currentTurnGeneration,
                sessionFile: turnSession.sessionFile,
                sessionId: turnSession.sessionId,
                error: outcome.error,
                ...(latestAutoRetryFailure
                  ? { retryFailure: { ...latestAutoRetryFailure } }
                  : {}),
              };
        const terminalKey = JSON.stringify({ event, payload });
        const committed = trackedTurn.commitTerminal(terminalKey, () => {
          emitTurnEvent(event, requestTag, payload, forceTurnEvents);
        });
        if (!committed && trackedTurn.terminalConflict) {
          console.error(`rin_turn_terminal_conflict:${currentTurnGeneration}`);
        }
      };
      let directOutcome: RinTurnTerminalOutcome = RIN_TURN_TERMINAL_ABSENT;
      try {
        const agentSettledProducerOutcome = agentSettledOutcome.then(
          (outcome) => ({
            source: "agent_settled" as const,
            outcome,
          }),
        );
        let taskResult: Promise<unknown>;
        try {
          taskResult = task();
        } catch (error) {
          taskResult = Promise.reject(error);
        }
        const taskProducerOutcome = taskResult.then(
          (value) => ({
            source: "task" as const,
            outcome: resolveRinTurnTerminalOutcomeFromTurnResult(value),
          }),
          (error) => ({
            source: "task_error" as const,
            outcome: RIN_TURN_TERMINAL_ABSENT,
            error,
          }),
        );
        const cancellationProducerOutcome = trackedTurn.cancelled.then(
          (error) => ({
            source: "turn_cancelled" as const,
            outcome: RIN_TURN_TERMINAL_ABSENT,
            error,
          }),
        );
        let producerOutcome = await Promise.race([
          agentSettledProducerOutcome,
          taskProducerOutcome,
          cancellationProducerOutcome,
        ]);
        // AgentSession.prompt(..., { streamingBehavior: "steer" }) returns
        // after Pi queues an input into an existing run. Keep the same backend
        // terminal observer alive until Pi publishes that run's settlement.
        if (
          producerOutcome.source === "task" &&
          producerOutcome.outcome.kind === "absent" &&
          (turnSession.isStreaming || turnSession.agent?.signal)
        ) {
          producerOutcome = await Promise.race([
            agentSettledProducerOutcome,
            cancellationProducerOutcome,
          ]);
        }
        directOutcome =
          producerOutcome.source === "task"
            ? producerOutcome.outcome
            : RIN_TURN_TERMINAL_ABSENT;
        // A recovered turn can settle in the narrow gap before an already
        // admitted Pi steer starts. Once the queued user message actually
        // starts, wait for Pi's next authoritative settlement before deriving
        // the one terminal outcome. With no admission, terminalization remains
        // immediate.
        const startedQueueAdmission = await trackedTurn.waitForContinuations();
        if (startedQueueAdmission) {
          directOutcome = RIN_TURN_TERMINAL_ABSENT;
        }
        if (producerOutcome.source === "task_error" && !startedQueueAdmission) {
          throw producerOutcome.error instanceof Error
            ? producerOutcome.error
            : new Error(String(producerOutcome.error || "rpc_turn_failed"));
        }
        // Pi's agent_settled event is the authoritative boundary after retries,
        // compaction, and queued continuations. Rin detaches post-settlement
        // extension observers so they cannot keep this producer event open.
        const terminalOutcome = turnSettlement.resolve(
          directOutcome,
          readTurnMessages(turnSession, terminalScope),
        );
        if (terminalOutcome.kind === "absent") {
          if (producerOutcome.source === "turn_cancelled") {
            throw new Error(producerOutcome.error);
          }
          if (producerOutcome.source === "task_error") {
            throw producerOutcome.error instanceof Error
              ? producerOutcome.error
              : new Error(
                  String(
                    producerOutcome.error ||
                      "rin_turn_settled_without_terminal",
                  ),
                );
          }
          throw new Error("rin_turn_settled_without_terminal");
        }
        if (terminalOutcome.kind === "error") {
          const failureMessage =
            resolveRinTurnFailureMessage(
              turnSession,
              terminalOutcome.resolution.messages,
            ) || terminalOutcome.error;
          throw new Error(failureMessage);
        }
        commitTurnTerminal(terminalOutcome);
      } catch (error: any) {
        if (turnState.gracefulSessionShutdown) {
          let recoveredMessages: any[] = [];
          try {
            recoveredMessages = readTurnMessages(turnSession, terminalScope);
          } catch (branchError: any) {
            if (directOutcome.kind === "absent") {
              commitTurnTerminal({
                kind: "error",
                error: String(
                  branchError?.message || branchError || "rpc_turn_failed",
                ),
              });
              return;
            }
          }
          let recoveredOutcome: RinTurnTerminalOutcome;
          try {
            recoveredOutcome = turnSettlement.resolveUnsettled(
              directOutcome,
              recoveredMessages,
            );
          } catch (authorityError: any) {
            commitTurnTerminal({
              kind: "error",
              error: String(
                authorityError?.message || authorityError || "rpc_turn_failed",
              ),
            });
            return;
          }
          if (recoveredOutcome.kind === "complete") {
            commitTurnTerminal(recoveredOutcome);
            return;
          }
          const recoveredFailureMessage =
            recoveredOutcome.kind === "error"
              ? resolveRinTurnFailureMessage(
                  turnSession,
                  recoveredOutcome.resolution.messages,
                ) || recoveredOutcome.error
              : "";
          commitTurnTerminal({
            kind: "error",
            error:
              recoveredFailureMessage ||
              String(error?.message || error || "rpc_turn_failed"),
          });
          return;
        }
        const errorMessage =
          latestAutoRetryFailure?.finalError ||
          String(error?.message || error || "rpc_turn_failed");
        commitTurnTerminal({ kind: "error", error: errorMessage });
        throw error;
      } finally {
        turnSettlement.dispose();
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        turnCoordinator.closeTurn(trackedTurn);
      }
    })();
    turnCoordinator.setCompletion(trackedTurn, promise);
    promise.catch(() => {});
  };
  const startInterruptTurnTask = (
    requestTag: string,
    task: () => Promise<unknown>,
  ) =>
    turnCoordinator.runInterrupt(async (interrupt) => {
      const session = getSession();
      let abortFailed = false;
      let abortError: unknown;
      if (
        session.isStreaming ||
        session.isCompacting ||
        session.agent?.signal
      ) {
        try {
          await session.abort();
        } catch (error) {
          abortFailed = true;
          abortError = error;
        }
      }
      if (abortFailed) throw abortError;
      const activeTurnToSettle = turnCoordinator.completion;
      turnCoordinator.cancelActiveTurn();
      try {
        await activeTurnToSettle;
      } catch {}
      if (!turnCoordinator.isInterruptCurrent(interrupt)) {
        throw new Error("Turn interruption was cancelled.");
      }
      startTurnTask(requestTag, task, {
        forceTurnEvents: true,
        interrupt,
      });
    });
  const authState: {
    loginSeq: number;
    activeLogins: Map<
      string,
      {
        abort: AbortController;
        waits: Map<
          string,
          { resolve: (value: string) => void; reject: (error: Error) => void }
        >;
        nextWaitSeq: number;
      }
    >;
  } = {
    loginSeq: 0,
    activeLogins: new Map(),
  };
  const emitLoginEvent = (
    loginId: string,
    event: string,
    payload: Record<string, unknown> = {},
  ) => output({ type: "oauth_login_event", loginId, event, ...payload });
  const ensureLogin = (loginId: string) => {
    const login = authState.activeLogins.get(loginId);
    if (!login) throw new Error(`Unknown OAuth login: ${loginId}`);
    return login;
  };
  const waitForLoginInput = (
    loginId: string,
    kind: string,
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) => {
    const login = ensureLogin(loginId);
    const requestId = nextOAuthLoginRequestId(login, loginId, kind);
    emitLoginEvent(loginId, kind, { requestId, ...payload });
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const resolveInput = (value: string) => {
        cleanup();
        resolve(value);
      };
      const rejectInput = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        login.waits.delete(requestId);
        emitLoginEvent(loginId, "prompt_cancel", { requestId });
        rejectInput(new Error("OAuth login prompt cancelled"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      login.waits.set(requestId, {
        resolve: resolveInput,
        reject: rejectInput,
      });
    });
  };
  const finishLogin = (loginId: string) => {
    const login = authState.activeLogins.get(loginId);
    if (!login) return;
    for (const pending of login.waits.values())
      pending.reject(new Error("OAuth login cancelled"));
    authState.activeLogins.delete(loginId);
  };

  let unsubscribeSessionEvents: (() => void) | undefined;
  let restoreSessionAppendMessage: (() => void) | undefined;
  const bindCurrentSession = async () => {
    const session = getSession();
    turnCoordinator.resetAdmissions();
    await session.bindExtensions({
      uiContext: createExtensionUiContext(),
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => getSession().agent.waitForIdle(),
        newSession: async () => ({ cancelled: true }),
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
        switchSession: async () => ({ cancelled: true }),
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
    restoreSessionAppendMessage?.();
    const userMessageRequestTags = new WeakMap<object, string>();
    const sessionManager = session.sessionManager;
    const originalAppendMessage = sessionManager?.appendMessage;
    if (typeof originalAppendMessage === "function") {
      const wrappedAppendMessage = function (this: any, message: any) {
        const requestTag =
          message?.role === "user" && typeof message === "object"
            ? userMessageRequestTags.get(message)
            : undefined;
        const result = originalAppendMessage.call(this, message);
        const sessionLeafId = safeString(result).trim();
        if (message?.role === "user" && sessionLeafId) {
          if (requestTag) {
            const observedRole = turnCoordinator.observedRole(requestTag);
            if (observedRole) {
              sessionManager.appendCustomEntry?.("rin_request_identity", {
                requestId: requestTag,
                messageEntryId: sessionLeafId,
                observedRole,
              });
              turnCoordinator.observePersistedUser(requestTag);
            }
          }
          if (message && typeof message === "object") {
            userMessageRequestTags.delete(message);
          }
        }
        return result;
      };
      sessionManager.appendMessage = wrappedAppendMessage;
      restoreSessionAppendMessage = () => {
        if (sessionManager.appendMessage === wrappedAppendMessage) {
          sessionManager.appendMessage = originalAppendMessage;
        }
      };
    } else {
      restoreSessionAppendMessage = undefined;
    }
    unsubscribeSessionEvents = session.subscribe(async (event: any) => {
      const nativeSubmission = turnState.pendingNativeInputSubmission;
      if (event?.type === "agent_start" && nativeSubmission) {
        const ownerBarrier = observeNativeTerminalOwner(nativeSubmission);
        if (ownerBarrier) await ownerBarrier;
      }
      if (
        event?.type === "queue_update" &&
        nativeSubmission &&
        !nativeSubmission.admissionToken
      ) {
        nativeSubmission.admissionToken = turnCoordinator.admit({
          requestTag: nativeSubmission.requestTag,
          observedRole: "nonterminal",
        });
        observeNativeInput(nativeSubmission, "nonterminal");
      }
      let producerRequestTag = safeString(event?.requestTag).trim();
      if (
        event?.type === "message_start" &&
        event.message?.role === "user" &&
        nativeSubmission &&
        !nativeSubmission.outcome
      ) {
        const ownerBarrier = observeNativeTerminalOwner(nativeSubmission);
        if (ownerBarrier) await ownerBarrier;
      }
      if (event?.type === "message_start" && event.message?.role === "user") {
        const match = turnCoordinator.observeUserStart({
          requestTag: producerRequestTag,
          message: event.message,
        });
        producerRequestTag =
          match?.requestTag ||
          producerRequestTag ||
          safeString(nativeSubmission?.requestTag).trim();
      }
      const taggedEvent =
        producerRequestTag && !safeString(event?.requestTag).trim()
          ? { ...event, requestTag: producerRequestTag }
          : event;
      if (event?.type === "auto_retry_start") {
        latestAutoRetryFailure = undefined;
      }
      if (event?.type === "auto_retry_end") {
        const finalError = safeString(event.finalError).trim();
        latestAutoRetryFailure =
          event.success === false && finalError
            ? {
                attempt: Math.max(1, Math.trunc(Number(event.attempt || 0))),
                finalError,
              }
            : undefined;
      }
      if (event?.type === "message_start" && event.message?.role === "user") {
        if (producerRequestTag) {
          userMessageRequestTags.set(event.message, producerRequestTag);
        }
        output(taggedEvent);
        return;
      }
      output(taggedEvent);
    });
  };

  await bindCurrentSession();

  const commandHandlers = {
    extensionUi: createRpcExtensionUiCommandHandlers({
      resolvePendingExtensionUiRequest,
      done,
    }),
    turn: createRpcTurnCommandHandlers({
      getSession,
      rpcRequestTag,
      persistedNativeRequestOutcome,
      persistNativeRequestOutcome,
      nativeRequestReceiptState,
      nativeInputOutcome,
      turnCoordinator,
      waitForPersistedUserRequestTag,
      turnState,
      captureTurnScope,
      normalizeFrontendIdentity,
      observeNativeInput,
      startInterruptTurnTask,
      resumeInterruptedTurn,
      startTurnTask,
      abortInterruptedTurnAfterExecutionLoss,
      output,
      terminateProcess,
      getSessionState,
      runtime,
      done,
      run,
    }),
    resource: createRpcResourceCommandHandlers({
      getSession,
      turnCoordinator,
      normalizeFrontendIdentity,
      getResourceDiagnostics,
      getCommandArgumentCompletions,
      refreshPiSessionToolRegistry,
      getSlashCommands,
      isWorkerLocalSessionReplacementCommand,
      canInvokeRuntimeSlashCommand,
      runBuiltinCommand,
      createExtensionUiContext,
      SessionManager,
      safeString,
      runtime,
      done,
      run,
    }),
    auth: createRpcAuthCommandHandlers({
      getSession,
      getOAuthState,
      authState,
      deferOAuthLoginStart,
      loginSessionProvider,
      emitLoginEvent,
      waitForLoginInput,
      refreshSessionModels,
      finishLogin,
      ensureLogin,
      setSessionApiKey,
      logoutSessionProvider,
      done,
      run,
    }),
    session: createRpcSessionCommandHandlers({
      runPersistedSessionMutation,
      sessionAllModels,
      sessionAvailableModels,
      setSessionThinkingLevel,
      setPersistentSessionThinkingLevel,
      resetSessionModelOptionsFromSettings,
      getSessionEntries,
      getSessionLeafId,
      getSessionEntriesSince,
      fail,
      getSessionTree,
      SessionManager,
      bindCurrentSession,
      listBoundSessionPage,
      safeString,
      listBoundSessions,
      setSessionModel,
      renameBoundSession,
      runtime,
      getSession,
      done,
      run,
    }),
  };
  const handleCommand = createRpcCommandDispatcher(commandHandlers);

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
