import {
  requestProcessTermination,
  type ProcessTermination,
} from "../platform/process-lifetime.js";
import { parseJsonl } from "../rin-lib/common.js";
import { fail } from "../rin-lib/rpc.js";
import { captureTurnScope, readTurnMessages } from "../session/turn-scope.js";
type RetryFailure = { attempt: number; finalError: string };
import {
  RIN_TURN_TERMINAL_ABSENT,
  RinTurnSettlementProjector,
  resolveRinTurnFailureMessage,
  resolveRinTurnTerminalOutcomeFromTurnResult,
  type RinTurnTerminalOutcome,
} from "../session/turn-completion.js";
import { safeString } from "../text-utils.js";
import {
  RpcTurnCoordinator,
  type RpcTurnInterrupt,
} from "./rpc-turn-coordinator.js";
import { createRpcAuthCommandHandlers } from "./rpc-auth-command-handler.js";
import { createRpcCommandDispatcher } from "./rpc-command-dispatcher.js";
import { createRpcExtensionUiCommandHandlers } from "./rpc-extension-ui-command-handler.js";
import { createRpcResourceCommandHandlers } from "./rpc-resource-command-handler.js";
import { createRpcSessionCommandHandlers } from "./rpc-session-command-handler.js";
import {
  captureTurnScopeBeforeUserMessage,
  createRpcTurnCommandHandlers,
  type NativeInputOutcome,
} from "./rpc-turn-command-handler.js";

export { abortInterruptedTurnAfterExecutionLoss } from "./rpc-turn-command-handler.js";
export {
  deferOAuthLoginStart,
  loginSessionProvider,
  nextOAuthLoginRequestId,
  setSessionApiKey,
} from "./rpc-auth-command-handler.js";
import { writeJsonLine } from "./worker-helpers.js";

const TURN_HEARTBEAT_INTERVAL_MS = 2_000;
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
    }),
    turn: createRpcTurnCommandHandlers({
      getSession,
      turnCoordinator,
      turnState,
      observeNativeInput,
      startInterruptTurnTask,
      startTurnTask,
      output,
      terminateProcess,
      runtime,
    }),
    resource: createRpcResourceCommandHandlers({
      getSession,
      turnCoordinator,
      createExtensionUiContext,
      SessionManager,
      runtime,
    }),
    auth: createRpcAuthCommandHandlers({ getSession, output }),
    session: createRpcSessionCommandHandlers({
      SessionManager,
      bindCurrentSession,
      runtime,
      getSession,
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
