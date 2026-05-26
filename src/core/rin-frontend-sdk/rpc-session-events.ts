export type RinRpcSessionEventTarget = {
  activeTurn?: unknown;
  isCompacting?: boolean;
  compactionReason?: string;
  retryAttempt?: number;
  handleSessionUnavailable?: () => void;
  handleSessionRecovered?: () => void;
  applyQueueUpdate?: (payload: any) => void;
  emitEvent?: (payload: any) => void;
  emitFrontendStatus?: (force?: boolean) => void;
  setRemoteTurnRunning?: (running: boolean) => void;
  isStreaming?: boolean;
};

export type RinRpcSessionEventRefresh = {
  refreshMessages: () => Promise<any> | any;
  refreshMessagesAndSession: () => Promise<any> | any;
};

export async function handleRinRpcSessionEvent(
  target: RinRpcSessionEventTarget,
  payload: any,
  refresh: RinRpcSessionEventRefresh,
) {
  if (!payload || typeof payload !== "object") return;
  const setRemoteTurnRunning = (running: boolean) => {
    if (typeof target.setRemoteTurnRunning === "function") {
      target.setRemoteTurnRunning(running);
    } else {
      target.isStreaming = running;
    }
  };
  const finishRemoteTurn = () => {
    target.activeTurn = null;
    setRemoteTurnRunning(false);
  };
  const emitFrontendStatus = () => {
    if (typeof target.emitFrontendStatus === "function") {
      target.emitFrontendStatus(true);
    }
  };
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
  if (payload.type === "agent_start") {
    setRemoteTurnRunning(true);
  }
  if (
    payload.type === "rpc_turn_event" &&
    (payload.event === "start" || payload.event === "heartbeat")
  ) {
    setRemoteTurnRunning(true);
  }
  if (payload.type === "compaction_start") {
    target.isCompacting = true;
    target.compactionReason = String(payload.reason || "").trim();
  }
  if (payload.type === "compaction_end") {
    target.isCompacting = false;
    target.compactionReason = "";
    void refresh.refreshMessagesAndSession();
  }
  if (payload.type === "auto_retry_start") {
    target.retryAttempt = Number(payload.attempt || 1);
  }
  if (payload.type === "auto_retry_end") target.retryAttempt = 0;
  if (payload.type === "agent_end") {
    void refresh.refreshMessagesAndSession();
  }
  if (payload.type === "rpc_turn_event" && payload.event === "error") {
    finishRemoteTurn();
    void refresh.refreshMessagesAndSession();
  }
  if (payload.type === "rpc_turn_event" && payload.event === "complete") {
    finishRemoteTurn();
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
  if (
    payload.type === "compaction_start" ||
    payload.type === "compaction_end"
  ) {
    emitFrontendStatus();
  }
}
