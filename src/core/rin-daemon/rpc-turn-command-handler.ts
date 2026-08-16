import type {
  RpcCommandRequest,
  RpcDone,
  RpcRun,
} from "./rpc-command-handler-context.js";

type NativeInputOutcome =
  | "terminalOwner"
  | "nonterminal"
  | "rejected"
  | "indeterminate";

type NativeInputSubmission = {
  requestTag: string;
  streamingBehavior: "steer" | "followUp";
  promptTask?: Promise<unknown>;
  promptTaskReady: Promise<void>;
  resolvePromptTaskReady: () => void;
  turnScope: any;
  admissionToken?: any;
  outcome?: NativeInputOutcome;
  resolveObserved: (outcome: NativeInputOutcome) => void;
  observed: Promise<NativeInputOutcome>;
};

export type RpcTurnCommandContext = {
  getSession: () => any;
  rpcRequestTag: (...args: any[]) => any;
  persistedNativeRequestOutcome: (...args: any[]) => any;
  persistNativeRequestOutcome: (...args: any[]) => any;
  nativeRequestReceiptState: (...args: any[]) => any;
  nativeInputOutcome: (...args: any[]) => any;
  turnCoordinator: any;
  waitForPersistedUserRequestTag: (...args: any[]) => any;
  turnState: {
    pendingNativeInputSubmission?: any;
    nativeInputAdmissionTail: Promise<void>;
    gracefulSessionShutdown: boolean;
  };
  captureTurnScope: (...args: any[]) => any;
  normalizeFrontendIdentity: (...args: any[]) => any;
  observeNativeInput: (...args: any[]) => any;
  startInterruptTurnTask: (...args: any[]) => any;
  resumeInterruptedTurn: (...args: any[]) => any;
  startTurnTask: (...args: any[]) => any;
  abortInterruptedTurnAfterExecutionLoss: (...args: any[]) => any;
  output: (...args: any[]) => any;
  terminateProcess: (...args: any[]) => any;
  getSessionState: (...args: any[]) => any;
  runtime: any;
  done: RpcDone;
  run: RpcRun;
};

export function createRpcTurnCommandHandlers(context: RpcTurnCommandContext) {
  const {
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
          async () => await resumeInterruptedTurn(session, command),
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
        session.sendUserMessage(command.content, command.options),
      );
      return done(id, type, { sent: true });
    },
  };
}

export type RpcTurnCommandHandlers = ReturnType<
  typeof createRpcTurnCommandHandlers
>;
