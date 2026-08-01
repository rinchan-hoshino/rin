import {
  applyRinFrontendLifecycleEvent,
  projectRinFrontendLifecycleEvent,
  shouldRefreshRinFrontendLifecycleStatus,
  type RinFrontendLifecycleEvent,
} from "./frontend-lifecycle.js";

export type RinRpcSessionEventTarget = {
  activeTurn?: unknown;
  isCompacting?: boolean;
  compactionReason?: string;
  retryAttempt?: number;
  maxRetryAttempts?: number;
  retryDelayMs?: number;
  retryError?: string;
  handleSessionUnavailable?: () => void;
  handleSessionRecovered?: () => void;
  applyQueueUpdate?: (payload: any) => void;
  emitEvent?: (payload: any) => void;
  emitFrontendStatus?: (force?: boolean) => void;
  setTurnActive?: (active: boolean) => void;
  setAgentStreaming?: (streaming: boolean) => void;
  setBackendWorking?: (working: boolean) => void;
  turnActive?: boolean;
  remoteTurnRunning?: boolean;
  isStreaming?: boolean;
};

export type RinRpcSessionEventRefresh = {
  refreshMessages: () => Promise<any> | any;
  refreshMessagesAndSession: () => Promise<any> | any;
};

function setTargetTurnActive(
  target: RinRpcSessionEventTarget,
  active: boolean,
) {
  target.turnActive = active;
  if (typeof target.setTurnActive === "function") {
    target.setTurnActive(active);
  }
}

function setTargetAgentStreaming(
  target: RinRpcSessionEventTarget,
  streaming: boolean,
) {
  target.isStreaming = streaming;
  if (typeof target.setAgentStreaming === "function") {
    target.setAgentStreaming(streaming);
  }
}

function applyLifecycleState(
  target: RinRpcSessionEventTarget,
  payload: any,
): RinFrontendLifecycleEvent | null {
  const event = projectRinFrontendLifecycleEvent(payload);
  if (!event) return null;
  if (target.turnActive !== true && target.remoteTurnRunning === true) {
    target.turnActive = true;
  }
  const state = applyRinFrontendLifecycleEvent(target, event);
  setTargetTurnActive(target, state.turnActive);
  setTargetAgentStreaming(target, state.isStreaming);
  return event;
}

export async function handleRinRpcSessionEvent(
  target: RinRpcSessionEventTarget,
  payload: any,
  refresh: RinRpcSessionEventRefresh,
) {
  if (!payload || typeof payload !== "object") return;
  if (payload.type === "session_recovering") {
    target.handleSessionUnavailable?.();
    target.emitEvent?.(payload);
    return;
  }
  if (payload.type === "session_recovered") {
    target.handleSessionRecovered?.();
    target.emitEvent?.(payload);
    return;
  }

  const lifecycleEvent = applyLifecycleState(target, payload);
  if (
    payload.type === "rpc_turn_event" &&
    (payload.event === "error" || payload.event === "complete")
  ) {
    target.activeTurn = null;
  }
  if (payload.type === "compaction_end" || payload.type === "agent_end") {
    void refresh.refreshMessagesAndSession();
  }
  if (
    payload.type === "rpc_turn_event" &&
    (payload.event === "error" || payload.event === "complete")
  ) {
    void refresh.refreshMessagesAndSession();
  }
  if (payload.type === "worker_exit") {
    target.handleSessionUnavailable?.();
  }
  if (payload.type === "queue_update") {
    target.applyQueueUpdate?.(payload);
  }
  if (
    payload.type === "message_end" ||
    payload.type === "tool_execution_end" ||
    payload.type === "compaction_message"
  ) {
    void refresh.refreshMessages();
  }
  target.emitEvent?.(payload);
  if (typeof payload.working === "boolean") {
    target.setBackendWorking?.(payload.working);
  }
  if (
    lifecycleEvent &&
    shouldRefreshRinFrontendLifecycleStatus(lifecycleEvent)
  ) {
    target.emitFrontendStatus?.(true);
  }
}
