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
import {
  captureTurnScope,
  readTurnMessages,
  type RinTurnScope,
} from "../session/turn-scope.js";
import { normalizeFrontendIdentity } from "../rin-frontend-sdk/frontend-identity.js";
import type { RinFrontendRetryFailure } from "../rin-frontend-sdk/types.js";
import {
  RIN_TURN_TERMINAL_ABSENT,
  RinTurnSettlementProjector,
  resolveRinTurnFailureMessage,
  resolveRinTurnTerminalOutcomeFromTurnResult,
  type RinTurnTerminalOutcome,
} from "../rin-frontend-sdk/turn-completion.js";
import {
  emitPiSessionEvent,
  refreshPiSessionToolRegistry,
  resumePiSessionTurn,
} from "../pi/session-host.js";
import { safeString } from "../text-utils.js";
import { rawErrorMessage } from "../rin-lib/user-facing-errors.js";
import {
  RpcTurnCoordinator,
  type RpcTurnInterrupt,
} from "./rpc-turn-coordinator.js";
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

async function resumeInterruptedTurn(session: any) {
  const messages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  if (!messages.length) return;
  if (isAssistantFailureMessage(messages.at(-1))) {
    // A persisted failure without a daemon terminal is not a settled result.
    // Pi owns retry policy for the new continuation; Rin only restores a
    // provider-valid context and never replays the accepted user input.
    discardInterruptedAssistantFailures(session);
    await resumePiSessionTurn(session);
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
    rinCommandResult: (result: unknown) =>
      output({
        type: "extension_ui_request",
        id: createExtensionUiRequestId(),
        method: "rinCommandResult",
        result,
      }),
    rinChatPresentation: (presentation: unknown) => {
      runtime.rinChatPresentation = presentation;
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
  let pendingNativeInputSubmission: NativeInputSubmission | undefined;
  let nativeInputAdmissionTail: Promise<void> = Promise.resolve();
  let gracefulSessionShutdown = false;
  let latestAutoRetryFailure: RinFrontendRetryFailure | undefined;
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
    if (pendingNativeInputSubmission === submission) {
      pendingNativeInputSubmission = undefined;
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
        if (gracefulSessionShutdown) {
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
  let loginSeq = 0;
  const activeLogins = new Map<
    string,
    {
      abort: AbortController;
      waits: Map<
        string,
        { resolve: (value: string) => void; reject: (error: Error) => void }
      >;
      nextWaitSeq: number;
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
    const login = activeLogins.get(loginId);
    if (!login) return;
    for (const pending of login.waits.values())
      pending.reject(new Error("OAuth login cancelled"));
    activeLogins.delete(loginId);
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
      const nativeSubmission = pendingNativeInputSubmission;
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
        output(withCompactionEventMetadata(session, taggedEvent));
        return;
      }
      output(withCompactionEventMetadata(session, taggedEvent));
    });
  };

  await bindCurrentSession();

  const handleCommand = async (command: any) => {
    const session = getSession();
    const id = command?.id;
    const type = String(command?.type || "unknown");
    switch (type) {
      case "extension_ui_response":
        resolvePendingExtensionUiRequest(command);
        return done(id, type);
      case "prompt": {
        const requestTag = rpcRequestTag(command.requestTag);
        const persistedOutcome = persistedNativeRequestOutcome(
          session,
          requestTag,
        );
        if (persistedOutcome) {
          return done(
            id,
            "prompt",
            nativeInputOutcome(session, "rejoined", requestTag, {
              originalOutcome: persistedOutcome,
              turnActive: turnCoordinator.isActive,
            }),
          );
        }
        if (
          requestTag &&
          nativeRequestReceiptState(session, requestTag) === "conflict"
        ) {
          return done(
            id,
            "prompt",
            nativeInputOutcome(session, "indeterminate", requestTag, {
              turnActive: turnCoordinator.isActive,
            }),
          );
        }
        turnCoordinator.assertAdmissionOpen();
        if (
          turnCoordinator.isActive &&
          requestTag &&
          requestTag === turnCoordinator.activeRequestTag
        ) {
          await waitForPersistedUserRequestTag(session, requestTag);
          const durableOutcome = persistedNativeRequestOutcome(
            session,
            requestTag,
          );
          if (!durableOutcome)
            throw new Error("rin_prompt_outcome_indeterminate");
          return done(
            id,
            "prompt",
            nativeInputOutcome(session, "rejoined", requestTag, {
              originalOutcome: durableOutcome,
              turnActive: true,
            }),
          );
        }
        const observedRole = turnCoordinator.observedRole(requestTag);
        if (requestTag && observedRole) {
          await waitForPersistedUserRequestTag(session, requestTag);
          const durableOutcome = persistedNativeRequestOutcome(
            session,
            requestTag,
          );
          if (!durableOutcome)
            throw new Error("rin_prompt_outcome_indeterminate");
          return done(
            id,
            "prompt",
            nativeInputOutcome(session, "rejoined", requestTag, {
              originalOutcome: durableOutcome,
              turnActive: turnCoordinator.isActive,
            }),
          );
        }

        const previousAdmission = nativeInputAdmissionTail;
        let releaseAdmission!: () => void;
        nativeInputAdmissionTail = new Promise<void>((resolve) => {
          releaseAdmission = resolve;
        });
        await previousAdmission;
        const serializedPersistedOutcome = persistedNativeRequestOutcome(
          session,
          requestTag,
        );
        if (serializedPersistedOutcome) {
          releaseAdmission();
          return done(
            id,
            "prompt",
            nativeInputOutcome(session, "rejoined", requestTag, {
              originalOutcome: serializedPersistedOutcome,
              turnActive: turnCoordinator.isActive,
            }),
          );
        }
        if (
          requestTag &&
          nativeRequestReceiptState(session, requestTag) === "conflict"
        ) {
          releaseAdmission();
          return done(
            id,
            "prompt",
            nativeInputOutcome(session, "indeterminate", requestTag, {
              turnActive: turnCoordinator.isActive,
            }),
          );
        }
        const serializedOutcome = turnCoordinator.observedRole(requestTag);
        if (
          requestTag &&
          (serializedOutcome || requestTag === turnCoordinator.activeRequestTag)
        ) {
          await waitForPersistedUserRequestTag(session, requestTag);
          const durableOutcome = persistedNativeRequestOutcome(
            session,
            requestTag,
          );
          releaseAdmission();
          if (!durableOutcome)
            throw new Error("rin_prompt_outcome_indeterminate");
          return done(
            id,
            "prompt",
            nativeInputOutcome(session, "rejoined", requestTag, {
              originalOutcome: durableOutcome,
              turnActive: turnCoordinator.isActive,
            }),
          );
        }

        captureTurnScope(session);
        const streamingBehavior =
          command.streamingBehavior === "followUp" ? "followUp" : "steer";
        const promptOptions: Record<string, unknown> = {
          images: command.images,
          streamingBehavior,
          source: command.source || "rpc",
        };
        if (typeof command.requestTag === "string") {
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
        let resolveObserved!: (outcome: NativeInputOutcome) => void;
        const observed = new Promise<NativeInputOutcome>((resolve) => {
          resolveObserved = resolve;
        });
        let resolvePromptTaskReady!: () => void;
        const promptTaskReady = new Promise<void>((resolve) => {
          resolvePromptTaskReady = resolve;
        });
        const submission: NativeInputSubmission = {
          requestTag,
          streamingBehavior,
          turnScope: captureTurnScope(session),
          promptTaskReady,
          resolvePromptTaskReady,
          resolveObserved,
          observed,
        };
        promptOptions.preflightResult = (accepted: boolean) => {
          if (!accepted) submission.resolveObserved("rejected");
        };
        let promptTask: Promise<unknown> | undefined;
        try {
          pendingNativeInputSubmission = submission;
          promptTask = session.prompt(command.message, promptOptions);
          submission.promptTask = promptTask;
          submission.resolvePromptTaskReady();
          const firstResult = await Promise.race([
            observed.then((outcome) => ({
              type: "observed" as const,
              outcome,
            })),
            promptTask.then(() => ({ type: "settled" as const })),
          ]);
          const outcome =
            firstResult.type === "observed"
              ? firstResult.outcome
              : "indeterminate";
          if (outcome === "nonterminal") await promptTask;
          if (
            requestTag &&
            (outcome === "terminalOwner" || outcome === "nonterminal")
          ) {
            await waitForPersistedUserRequestTag(session, requestTag);
          }
          if (
            (outcome === "rejected" || outcome === "indeterminate") &&
            !persistNativeRequestOutcome(session, requestTag, outcome)
          ) {
            throw new Error("rin_prompt_outcome_indeterminate");
          }
          releaseAdmission();
          observeNativeInput(submission, outcome);
          return done(
            id,
            "prompt",
            nativeInputOutcome(session, outcome, requestTag, {
              turnActive:
                outcome === "terminalOwner" || turnCoordinator.isActive,
            }),
          );
        } catch (error) {
          if (pendingNativeInputSubmission === submission) {
            pendingNativeInputSubmission = undefined;
          }
          releaseAdmission();
          if (submission.admissionToken) {
            turnCoordinator.removeAdmission(submission.admissionToken);
          }
          throw error;
        }
      }
      case "resume_interrupted_turn": {
        const requestTag = rpcRequestTag(command.requestTag);
        startInterruptTurnTask(
          requestTag,
          async () => await resumeInterruptedTurn(session),
        );
        return done(id, type, { resumed: true, requestTag });
      }
      case "clear_queue":
        turnCoordinator.clearTrackedAdmissions();
        return done(id, type, session.clearQueue());
      case "abort_interrupted_turn": {
        const requestTag = rpcRequestTag(command.requestTag);
        if (!requestTag) throw new Error("requestTag is required");
        startTurnTask(
          requestTag,
          async () => await abortInterruptedTurnAfterExecutionLoss(session),
          { forceTurnEvents: true },
        );
        await turnCoordinator.waitForIdle();
        return done(id, type, {
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
        });
      }
      case "abort":
        return run(id, type, () =>
          turnCoordinator.runInterrupt(
            async () => {
              output({
                type: "rpc_control_event",
                event: "abort_started",
                id,
              });
              const activeTurnToSettle = turnCoordinator.completion;
              try {
                Promise.resolve(session.abortCompaction?.()).catch(() => {});
              } catch {}
              let abortFailed = false;
              let abortError: unknown;
              try {
                await session.abort();
              } catch (error) {
                abortFailed = true;
                abortError = error;
              }
              if (abortFailed) throw abortError;
              turnCoordinator.cancelActiveTurn();
              try {
                await activeTurnToSettle;
              } catch {}
            },
            { invalidate: true },
          ),
        );
      case "shutdown_session":
        return turnCoordinator.runInterrupt(
          async () => {
            gracefulSessionShutdown = true;
            const activeTurnToSettle = turnCoordinator.completion;
            const frontendIdentity = normalizeFrontendIdentity(
              command.frontendIdentity,
            );
            if (frontendIdentity && session.sessionManager) {
              session.sessionManager.__rinFrontend = frontendIdentity;
            }
            turnCoordinator.cancelActiveTurn();
            try {
              await session.abort();
            } catch {}
            try {
              await activeTurnToSettle;
            } catch {}
            await runtime.dispose();
            output(done(id, type, { shutdown: true }));
            return process.exit(0);
          },
          { invalidate: true },
        );
      case "sleep_session":
        return turnCoordinator.runInterrupt(
          async () => {
            gracefulSessionShutdown = true;
            const activeTurnToSettle = turnCoordinator.completion;
            turnCoordinator.cancelActiveTurn();
            try {
              await session.abort();
            } catch {}
            try {
              await activeTurnToSettle;
            } catch {}
            session.dispose();
            output(done(id, type, { sleeping: true }));
            return process.exit(0);
          },
          { invalidate: true },
        );
      case "attach_session":
        return done(
          id,
          type,
          getSessionState(session, {
            turnActive: turnCoordinator.isActive,
          }),
        );
      case "get_state": {
        const trackedTurnActive = turnCoordinator.isActive;
        return done(id, type, {
          ...getSessionState(session, {
            turnActive: trackedTurnActive,
          }),
          piActiveRun: Boolean(session.agent?.signal),
          ...(trackedTurnActive
            ? {
                requestTag: turnCoordinator.activeRequestTag,
                turnGeneration: turnCoordinator.turnGeneration,
              }
            : {}),
        });
      }
      case "cycle_model":
        return run(
          id,
          type,
          () =>
            runPersistedSessionMutation(session, () => session.cycleModel()),
          (value) => value ?? null,
        );
      case "get_all_models":
        return done(id, type, { models: sessionAllModels(session) });
      case "get_available_models":
        return run(
          id,
          type,
          () => sessionAvailableModels(session),
          (models) => ({ models }),
        );
      case "get_oauth_state":
        return run(id, type, () => getOAuthState(session));
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
        return run(id, type, () => {
          const level = safeString(command.level).trim();
          return command.persistSettings === false
            ? setSessionThinkingLevel(session, level, {
                persistSettings: false,
              })
            : setPersistentSessionThinkingLevel(session, level);
        });
      case "reset_model_options_from_settings":
        return run(id, type, () =>
          resetSessionModelOptionsFromSettings(session),
        );
      case "cycle_thinking_level":
        return run(
          id,
          type,
          () =>
            runPersistedSessionMutation(session, () =>
              session.cycleThinkingLevel(),
            ),
          (level) => (level ? { level } : null),
        );
      case "get_available_thinking_levels":
        return done(id, type, {
          levels: Array.isArray(session?.getAvailableThinkingLevels?.())
            ? session.getAvailableThinkingLevels()
            : [],
        });
      case "set_steering_mode":
        return run(id, type, () =>
          runPersistedSessionMutation(session, () =>
            session.setSteeringMode(command.mode),
          ),
        );
      case "set_follow_up_mode":
        return run(id, type, () =>
          runPersistedSessionMutation(session, () =>
            session.setFollowUpMode(command.mode),
          ),
        );
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
          runPersistedSessionMutation(session, () =>
            session.setAutoCompactionEnabled(Boolean(command.enabled)),
          ),
        );
      case "set_auto_retry":
        return run(id, type, () =>
          runPersistedSessionMutation(session, () =>
            session.setAutoRetryEnabled(Boolean(command.enabled)),
          ),
        );
      case "abort_retry":
        return run(id, type, () => session.abortRetry());
      case "abort_compaction":
        return run(id, type, () => session.abortCompaction());
      case "bash":
        return run(id, type, () =>
          session.executeBash(command.command, undefined, {
            excludeFromContext: command.excludeFromContext,
            id,
          }),
        );
      case "abort_bash":
        return run(id, type, () => session.abortBash());
      case "get_session_stats":
        return done(id, type, session.getSessionStats());
      case "get_session_snapshot":
        return done(id, type, {
          entries: getSessionEntries(session),
          leafId: getSessionLeafId(session),
        });
      case "get_entries": {
        const result = getSessionEntriesSince(session, command.since);
        if (result.error) return fail(id, type, result.error);
        return done(id, type, {
          entries: result.entries,
          leafId: getSessionLeafId(session),
        });
      }
      case "get_tree":
        return done(id, type, {
          tree: getSessionTree(session),
          leafId: getSessionLeafId(session),
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
        if (turnCoordinator.isActive || session.agent?.signal) {
          throw new Error("rpc_turn_already_active");
        }
        startTurnTask(rpcRequestTag(command.requestTag), async () =>
          session.sendUserMessage(command.content, command.options),
        );
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
              throw new Error(
                "session replacement commands must be routed through the frontend",
              );
            }
            const frontendKind =
              normalizeFrontendIdentity(command.frontendIdentity)?.kind ||
              "rpc";
            if (
              commandName &&
              !canInvokeRuntimeSlashCommand(
                getSlashCommands(session),
                commandName,
                frontendKind,
              )
            ) {
              return { handled: false };
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
              turnCoordinator.assertAdmissionOpen();
              await session.prompt(commandLine);
              return { handled: true };
            }
            return builtinResult;
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
        const sessions = await listBoundSessions();
        return done(id, type, { sessions });
      }
      case "set_model": {
        const models = await sessionAvailableModels(session);
        const model = models.find(
          (m: any) =>
            m.provider === command.provider && m.id === command.modelId,
        );
        if (!model)
          throw new Error(
            `Model not found: ${command.provider}/${command.modelId}`,
          );
        const persistSettings = command.persistSettings !== false;
        const mutate = () =>
          setSessionModel(session, model, {
            persistSettings: persistSettings ? undefined : false,
          });
        if (persistSettings) {
          await runPersistedSessionMutation(session, mutate);
        } else {
          await mutate();
        }
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
        const authType =
          String(command.authType || "oauth").trim() === "api_key"
            ? "api_key"
            : "oauth";
        const loginId = `login_${++loginSeq}`;
        const abort = new AbortController();
        activeLogins.set(loginId, {
          abort,
          waits: new Map(),
          nextWaitSeq: 0,
        });
        // Let the start response reach the frontend before a provider can
        // synchronously emit its first auth prompt.
        deferOAuthLoginStart(async () => {
          try {
            await loginSessionProvider(session, providerId, {
              authType,
              onAuth: (info: { url: string; instructions?: string }) =>
                emitLoginEvent(loginId, "auth", {
                  url: info.url,
                  instructions: info.instructions,
                }),
              onDeviceCode: (info: {
                userCode: string;
                verificationUri: string;
                intervalSeconds?: number;
                expiresInSeconds?: number;
              }) =>
                emitLoginEvent(loginId, "device_code", {
                  userCode: info.userCode,
                  verificationUri: info.verificationUri,
                  intervalSeconds: info.intervalSeconds,
                  expiresInSeconds: info.expiresInSeconds,
                }),
              onPrompt: (prompt: {
                type?: string;
                message: string;
                placeholder?: string;
                allowEmpty?: boolean;
                signal?: AbortSignal;
              }) =>
                waitForLoginInput(
                  loginId,
                  "prompt",
                  {
                    promptType: prompt.type,
                    message: prompt.message,
                    placeholder: prompt.placeholder,
                    allowEmpty: prompt.allowEmpty,
                  },
                  prompt.signal,
                ),
              onSelect: (prompt: {
                message: string;
                options: readonly { id: string; label: string }[];
                signal?: AbortSignal;
              }) =>
                waitForLoginInput(
                  loginId,
                  "select",
                  {
                    message: prompt.message,
                    options: prompt.options,
                  },
                  prompt.signal,
                ),
              onProgress: (message: string) =>
                emitLoginEvent(loginId, "progress", { message }),
              onInfo: (info: { message: string; links?: unknown[] }) =>
                emitLoginEvent(loginId, "info", info),
              onManualCodeInput: (prompt: {
                message?: string;
                placeholder?: string;
                signal?: AbortSignal;
              }) =>
                waitForLoginInput(
                  loginId,
                  "manual_code",
                  {
                    message: prompt.message,
                    placeholder: prompt.placeholder,
                  },
                  prompt.signal,
                ),
              signal: abort.signal,
            });
            await refreshSessionModels(session);
            emitLoginEvent(loginId, "complete", {
              success: true,
              state: await getOAuthState(session),
            });
          } catch (error: any) {
            emitLoginEvent(loginId, "complete", {
              success: false,
              error: String(error?.message || error || "oauth_login_failed"),
            });
          } finally {
            finishLogin(loginId);
          }
        });
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
        await setSessionApiKey(session, providerId, key);
        return done(id, type, await getOAuthState(session));
      }
      case "oauth_logout": {
        const providerId = String(command.providerId || "").trim();
        if (!providerId) throw new Error("providerId is required");
        await logoutSessionProvider(session, providerId);
        return done(id, type, await getOAuthState(session));
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
