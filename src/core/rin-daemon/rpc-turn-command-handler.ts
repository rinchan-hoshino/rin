import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { extractPiContinuableToolCallParts } from "../pi/tool-continuation.js";
import { resumePiSessionTurn } from "../pi/session-host.js";
import type { ProcessTermination } from "../platform/process-lifetime.js";
import { normalizeFrontendIdentity } from "../rin-lib/frontend-identity.js";
import { createInterruptedToolResultMessage } from "../rin-lib/interruption.js";
import { safeString } from "../text-utils.js";
import { captureTurnScope, type RinTurnScope } from "../session/turn-scope.js";
import type { RinTurnTerminalOutcome } from "../session/turn-completion.js";
import {
  rpcDone as done,
  rpcRun as run,
  type RpcCommandRequest,
} from "./rpc-command-handler-context.js";
import {
  RpcTurnCoordinator,
  type RpcTurnInterrupt,
} from "./rpc-turn-coordinator.js";
import { getSessionState } from "./worker-helpers.js";
import { getSessionEntries } from "./rpc-session-command-handler.js";

export function stableJson(value: any) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function rpcRequestTag(value: unknown) {
  return typeof value === "string" ? value : "";
}

export type NativeInputOutcome =
  | "terminalOwner"
  | "nonterminal"
  | "rejected"
  | "indeterminate";

export function nativeInputOutcome(
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

export function persistedNativeIdentityOutcome(
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

export function persistedNativeRequestOutcome(
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

export function nativeRequestReceiptState(
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

export function persistNativeRequestOutcome(
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

export function hasPersistedUserRequestTag(session: any, requestTag: string) {
  return Boolean(
    requestTag && persistedNativeIdentityOutcome(session, requestTag),
  );
}

export async function waitForPersistedUserRequestTag(
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

export function ensureInterruptedAssistantPersisted(
  session: any,
  message: any,
) {
  const manager = session?.sessionManager;
  if (typeof manager?.appendMessage !== "function") return;
  const serialized = stableJson(message);
  const persisted = getSessionEntries(session).some(
    (entry: any) =>
      entry?.type === "message" && stableJson(entry.message) === serialized,
  );
  if (!persisted) manager.appendMessage(message);
}

export function appendInterruptedToolResults(
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

export function isAssistantFailureMessage(message: any) {
  if (safeString(message?.role).trim() !== "assistant") return false;
  const stopReason = safeString(message?.stopReason).trim();
  return stopReason === "error" || stopReason === "aborted";
}

export function discardInterruptedAssistantFailures(session: any) {
  const messages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  while (isAssistantFailureMessage(messages.at(-1))) messages.pop();
}

export async function resumeInterruptedTurn(
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

export function captureTurnScopeBeforeUserMessage(
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

type NativeInputSubmission = {
  requestTag: string;
  streamingBehavior: "steer" | "followUp";
  promptTask?: Promise<unknown>;
  promptTaskReady: Promise<void>;
  resolvePromptTaskReady: () => void;
  turnScope: RinTurnScope;
  admissionToken?: ReturnType<
    RpcTurnCoordinator<RinTurnTerminalOutcome>["admit"]
  >;
  outcome?: NativeInputOutcome;
  resolveObserved: (outcome: NativeInputOutcome) => void;
  observed: Promise<NativeInputOutcome>;
};

export type RpcTurnCommandContext = {
  getSession: () => AgentSession;
  turnCoordinator: RpcTurnCoordinator<RinTurnTerminalOutcome>;
  turnState: {
    pendingNativeInputSubmission?: NativeInputSubmission;
    nativeInputAdmissionTail: Promise<void>;
    gracefulSessionShutdown: boolean;
  };
  observeNativeInput: (
    submission: NativeInputSubmission,
    outcome: NativeInputOutcome,
  ) => void;
  startInterruptTurnTask: (
    requestTag: string,
    task: () => Promise<unknown>,
  ) => Promise<unknown>;
  startTurnTask: (
    requestTag: string,
    task: () => Promise<unknown>,
    options?: {
      forceTurnEvents?: boolean;
      interrupt?: RpcTurnInterrupt;
      turnScope?: RinTurnScope;
    },
  ) => void;
  output: (value: unknown) => void;
  terminateProcess: ProcessTermination;
  runtime: { dispose: () => void | Promise<void> };
};

export function createRpcTurnCommandHandlers(context: RpcTurnCommandContext) {
  const {
    getSession,
    turnCoordinator,
    turnState,
    observeNativeInput,
    startInterruptTurnTask,
    startTurnTask,
    output,
    terminateProcess,
    runtime,
  } = context;
  return {
    async prompt({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
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

        const previousAdmission = turnState.nativeInputAdmissionTail;
        let releaseAdmission!: () => void;
        turnState.nativeInputAdmissionTail = new Promise<void>((resolve) => {
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
          turnState.pendingNativeInputSubmission = submission;
          promptTask = session.prompt(
            command.message as Parameters<AgentSession["prompt"]>[0],
            promptOptions,
          );
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
          if (turnState.pendingNativeInputSubmission === submission) {
            turnState.pendingNativeInputSubmission = undefined;
          }
          releaseAdmission();
          if (submission.admissionToken) {
            turnCoordinator.removeAdmission(submission.admissionToken);
          }
          throw error;
        }
      }
    },
    async resume_interrupted_turn({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
        const requestTag = rpcRequestTag(command.requestTag);
        startInterruptTurnTask(
          requestTag,
          async () =>
            await resumeInterruptedTurn(
              session,
              command as Parameters<typeof resumeInterruptedTurn>[1],
            ),
        );
        return done(id, type, { resumed: true, requestTag });
      }
    },
    async clear_queue({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      turnCoordinator.clearTrackedAdmissions();
      return done(id, type, session.clearQueue());
    },
    async abort_interrupted_turn({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
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
    },
    async abort({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

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
    },
    async shutdown_session({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return turnCoordinator.runInterrupt(
        async () => {
          turnState.gracefulSessionShutdown = true;
          const activeTurnToSettle = turnCoordinator.completion;
          const frontendIdentity = normalizeFrontendIdentity(
            command.frontendIdentity,
          );
          if (frontendIdentity && session.sessionManager) {
            const manager =
              session.sessionManager as typeof session.sessionManager & {
                __rinFrontend?: ReturnType<typeof normalizeFrontendIdentity>;
              };
            manager.__rinFrontend = frontendIdentity;
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
          return terminateProcess(0);
        },
        { invalidate: true },
      );
    },
    async sleep_session({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return turnCoordinator.runInterrupt(
        async () => {
          turnState.gracefulSessionShutdown = true;
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
          return terminateProcess(0);
        },
        { invalidate: true },
      );
    },
    async attach_session({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(
        id,
        type,
        getSessionState(session, {
          turnActive: turnCoordinator.isActive,
        }),
      );
    },
    async get_state({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
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
    },
    async send_user_message({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      if (turnCoordinator.isActive || session.agent?.signal) {
        throw new Error("rpc_turn_already_active");
      }
      startTurnTask(rpcRequestTag(command.requestTag), async () =>
        session.sendUserMessage(
          command.content as Parameters<AgentSession["sendUserMessage"]>[0],
          command.options as Parameters<AgentSession["sendUserMessage"]>[1],
        ),
      );
      return done(id, type, { sent: true });
    },
  };
}

export type RpcTurnCommandHandlers = ReturnType<
  typeof createRpcTurnCommandHandlers
>;
