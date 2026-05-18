export async function handleRpcSessionEvent(
  target: any,
  payload: any,
  refreshMessages: () => Promise<any>,
  refreshMessagesAndSession: () => Promise<any>,
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
    target.emitEvent(payload);
    return;
  }
  if (payload.type === "session_recovered") {
    target.handleSessionRecovered?.();
    target.emitEvent(payload);
    return;
  }
  if (payload.type === "agent_start") {
    setRemoteTurnRunning(true);
  }
  if (payload.type === "rin_working_start") {
    target.rinWorking = true;
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
  }
  if (payload.type === "rin_working_end") {
    target.rinWorking = false;
    if (!target.isCompacting) setRemoteTurnRunning(false);
  }
  if (payload.type === "compaction_end") {
    target.isCompacting = false;
    if (target.rinWorking === false) setRemoteTurnRunning(false);
    void refreshMessagesAndSession();
  }
  if (payload.type === "auto_retry_start")
    target.retryAttempt = Number(payload.attempt || 1);
  if (payload.type === "auto_retry_end") target.retryAttempt = 0;
  if (payload.type === "agent_end") {
    finishRemoteTurn();
    void refreshMessagesAndSession();
  }
  if (
    payload.type === "rpc_turn_event" &&
    (payload.event === "complete" || payload.event === "error")
  ) {
    finishRemoteTurn();
    void refreshMessagesAndSession();
  }
  if (payload.type === "worker_exit") {
    if (typeof target.handleSessionUnavailable === "function") {
      target.handleSessionUnavailable();
    } else {
      finishRemoteTurn();
      void refreshMessagesAndSession();
    }
  }
  if (payload.type === "queue_update") {
    target.applyQueueUpdate?.(payload);
  }
  if (
    payload.type === "message_end" ||
    payload.type === "tool_execution_end" ||
    payload.type === "compaction_message"
  ) {
    void refreshMessages();
  }
  target.emitEvent(payload);
  if (
    payload.type === "rin_working_start" ||
    payload.type === "rin_working_end" ||
    payload.type === "compaction_start" ||
    payload.type === "compaction_end"
  ) {
    emitFrontendStatus();
  }
}
