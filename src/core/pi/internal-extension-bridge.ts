import { normalizeFrontendIdentity } from "../rin-frontend-sdk/frontend-identity.js";
import { getPiExtensionRunner } from "./session-host.js";

type RinCapabilityBridgeSet = {
  hasHandlers: (eventName: string) => boolean;
  emit: (event: any) => Promise<any>;
};

const RIN_EXTENSION_RUNNER_EVENTS = new Set<string>([
  "context",
  "session_before_compact",
]);
const RIN_EXTENSION_RUNNER_BEFORE_EVENTS = new Set<string>([
  "context",
  "session_before_compact",
]);
const RIN_EXTENSION_RUNNER_PATCH_KEY = Symbol.for(
  "rin.capabilityExtensionRunnerPatch",
);

type RinExtensionRunnerPatchState = {
  capabilitySet: RinCapabilityBridgeSet;
  session: any;
  originalHasHandlers: (eventName: string) => boolean;
  originalEmit: (event: any) => Promise<any>;
  originalEmitContext?: (messages: any[]) => Promise<any[]>;
};

export function withRinEventMetadata(event: any, session: any) {
  if (!event || typeof event !== "object") return event;
  const type = String(event?.type || "").trim();
  const frontend = normalizeFrontendIdentity(
    event.frontend ?? session?.sessionManager?.__rinFrontend,
  );
  const next = frontend ? { ...event, frontend } : event;
  if (type !== "session_before_compact" || next.reason) {
    return next;
  }
  return {
    ...next,
    reason: String(session?.__rinCurrentCompactionReason || "").trim(),
  };
}

export function attachRinCapabilityExtensionBridge(
  session: any,
  capabilitySet: RinCapabilityBridgeSet,
) {
  const runner = getPiExtensionRunner(session);
  if (!runner || typeof runner !== "object") return;
  const existing = runner[RIN_EXTENSION_RUNNER_PATCH_KEY] as
    | RinExtensionRunnerPatchState
    | undefined;
  if (existing) {
    existing.capabilitySet = capabilitySet;
    existing.session = session;
    return;
  }
  if (
    typeof runner.hasHandlers !== "function" ||
    typeof runner.emit !== "function"
  ) {
    return;
  }

  const state: RinExtensionRunnerPatchState = {
    capabilitySet,
    session,
    originalHasHandlers: runner.hasHandlers.bind(runner),
    originalEmit: runner.emit.bind(runner),
    originalEmitContext:
      typeof runner.emitContext === "function"
        ? runner.emitContext.bind(runner)
        : undefined,
  };
  runner[RIN_EXTENSION_RUNNER_PATCH_KEY] = state;

  runner.hasHandlers = (eventName: string) => {
    const type = String(eventName || "").trim();
    return (
      state.originalHasHandlers(eventName) ||
      (RIN_EXTENSION_RUNNER_EVENTS.has(type) &&
        state.capabilitySet.hasHandlers(type))
    );
  };

  if (state.originalEmitContext) {
    runner.emitContext = async (messages: any[]) => {
      const result = await state.originalEmitContext?.(messages);
      const currentMessages = Array.isArray(result) ? result : messages;
      if (!state.capabilitySet.hasHandlers("context")) {
        return currentMessages;
      }
      const rinResult = await state.capabilitySet.emit(
        withRinEventMetadata(
          { type: "context", messages: currentMessages },
          state.session,
        ),
      );
      return Array.isArray(rinResult?.messages)
        ? rinResult.messages
        : currentMessages;
    };
  }

  runner.emit = async (event: any) => {
    const type = String(event?.type || "").trim();
    const emitAndBridge = async () => {
      const result = await state.originalEmit(event);
      if (
        !RIN_EXTENSION_RUNNER_EVENTS.has(type) ||
        !state.capabilitySet.hasHandlers(type)
      ) {
        return result;
      }
      if (
        RIN_EXTENSION_RUNNER_BEFORE_EVENTS.has(type) &&
        (result?.cancel || result?.compaction)
      ) {
        return result;
      }
      const rinEvent =
        type === "context" && Array.isArray(result?.messages)
          ? { ...event, messages: result.messages }
          : event;
      const rinResult = await state.capabilitySet.emit(
        withRinEventMetadata(rinEvent, state.session),
      );
      if (!RIN_EXTENSION_RUNNER_BEFORE_EVENTS.has(type)) {
        return result || rinResult;
      }
      if (type === "context" && result && rinResult) {
        return { ...result, ...rinResult };
      }
      if (rinResult?.cancel || rinResult?.compaction) {
        return rinResult;
      }
      return result || rinResult;
    };
    if (type === "agent_settled") {
      const startObserver = (
        owner: "extension" | "capability",
        observer: () => unknown,
      ) => {
        let observation: Promise<unknown>;
        try {
          observation = Promise.resolve(observer());
        } catch (error) {
          observation = Promise.reject(error);
        }
        void observation.catch((error) => {
          console.error(`[rin] agent_settled ${owner} observer failed`, error);
        });
      };
      startObserver("extension", () => state.originalEmit(event));
      if (state.capabilitySet.hasHandlers(type)) {
        startObserver("capability", () =>
          state.capabilitySet.emit(withRinEventMetadata(event, state.session)),
        );
      }
      return undefined;
    }
    return emitAndBridge();
  };
}
