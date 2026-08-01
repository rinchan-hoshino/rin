import {
  formatCompactionSummaryCollapsedText,
  type CompactionSummaryCollapsedTextOptions,
} from "./compaction-summary-format.js";
import type {
  RinChatDeliveryContext,
  RinFrontendBackendEvent,
} from "./types.js";

export type RinFrontendInterruptIntent =
  | "stop_turn"
  | "cancel_retry"
  | "cancel_compaction";

export interface RinFrontendLifecycleStateTarget {
  turnActive?: boolean;
  isStreaming?: boolean;
  isCompacting?: boolean;
  compactionReason?: string;
  retryAttempt?: number;
  maxRetryAttempts?: number;
  retryDelayMs?: number;
  retryError?: string;
}

export interface RinFrontendLifecycleState {
  turnActive: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  compactionReason: string;
  retryAttempt: number;
  maxRetryAttempts: number;
  retryDelayMs: number;
  retryError: string;
}

interface LifecycleEventBase {
  requestTag?: string;
  chatDeliveryContext?: RinChatDeliveryContext;
  terminalRecord?: {
    terminalId: string;
    state: "complete" | "error" | "interrupted";
    terminalAt?: string;
  };
  turnGeneration?: number;
  sessionId?: string;
  sessionFile?: string;
}

export type RinFrontendLifecycleEvent =
  | (LifecycleEventBase & {
      kind: "turn_started";
      source: "start" | "heartbeat";
    })
  | (LifecycleEventBase & { kind: "agent_started" })
  | (LifecycleEventBase & {
      kind: "agent_stopped";
      settled: boolean;
    })
  | (LifecycleEventBase & { kind: "agent_settled" })
  | (LifecycleEventBase & {
      kind: "compaction_started";
      reason: string;
    })
  | (LifecycleEventBase & {
      kind: "compaction_finished";
      reason: string;
      result?: any;
      tokensBefore?: number;
      aborted: boolean;
      willRetry: boolean;
      errorMessage: string;
    })
  | (LifecycleEventBase & {
      kind: "retry_scheduled";
      source: "agent" | "summarization";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    })
  | (LifecycleEventBase & {
      kind: "summarization_retry_started";
      source: "compaction" | "branchSummary";
      reason: string;
    })
  | (LifecycleEventBase & { kind: "summarization_retry_finished" })
  | (LifecycleEventBase & {
      kind: "retry_finished";
      success: boolean;
      attempt: number;
      finalError: string;
    })
  | (LifecycleEventBase & {
      kind: "turn_terminal";
      outcome: "complete";
      finalText: string;
      result?: any;
      sessionId?: string;
      sessionFile?: string;
    })
  | (LifecycleEventBase & {
      kind: "turn_terminal";
      outcome: "error" | "aborted";
      error: string;
      sessionId?: string;
      sessionFile?: string;
    });

export interface RinFrontendLifecycleRenderOptions extends CompactionSummaryCollapsedTextOptions {
  compactionStartText?: string;
}

export interface RinFrontendInterruptClient {
  abort(): Promise<unknown>;
  abortRetry?(): Promise<unknown>;
  abortCompaction?(): Promise<unknown>;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeNumber(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalChatDeliveryContext(
  value: unknown,
): RinChatDeliveryContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const turnId = safeString((value as any).turnId).trim();
  const chatKey = safeString((value as any).chatKey).trim();
  const messageId = safeString((value as any).messageId).trim();
  if (!turnId || !chatKey || !messageId) return;
  return { turnId, chatKey, messageId };
}

function optionalTerminalRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const terminalId = safeString((value as any).terminalId).trim();
  const state = safeString((value as any).state).trim() as
    | "complete"
    | "error"
    | "interrupted";
  if (
    !terminalId ||
    (state !== "complete" && state !== "error" && state !== "interrupted")
  ) {
    return;
  }
  const terminalAt = safeString((value as any).terminalAt).trim();
  return {
    terminalId,
    state,
    ...(terminalAt ? { terminalAt } : {}),
  };
}

function optionalText(value: unknown): string | undefined {
  const text = safeString(value).trim();
  return text || undefined;
}

function requestTagOf(payload: any): LifecycleEventBase {
  const requestTag = optionalText(payload?.requestTag);
  const turnGeneration = safeNumber(payload?.turnGeneration);
  const sessionId = optionalText(payload?.sessionId);
  const sessionFile = optionalText(payload?.sessionFile);
  return {
    ...(requestTag ? { requestTag } : {}),
    ...(turnGeneration > 0 ? { turnGeneration } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

export function createRinFrontendLifecycleState(
  initial: Partial<RinFrontendLifecycleState> = {},
): RinFrontendLifecycleState {
  return {
    turnActive: false,
    isStreaming: false,
    isCompacting: false,
    compactionReason: "",
    retryAttempt: 0,
    maxRetryAttempts: 0,
    retryDelayMs: 0,
    retryError: "",
    ...initial,
  };
}

export function applyRinFrontendLifecycleEvent(
  target: RinFrontendLifecycleStateTarget,
  event: RinFrontendLifecycleEvent,
): RinFrontendLifecycleState {
  const state = createRinFrontendLifecycleState({
    turnActive: target.turnActive === true,
    isStreaming: target.isStreaming === true,
    isCompacting: target.isCompacting === true,
    compactionReason: safeString(target.compactionReason),
    retryAttempt: safeNumber(target.retryAttempt),
    maxRetryAttempts: safeNumber(target.maxRetryAttempts),
    retryDelayMs: safeNumber(target.retryDelayMs),
    retryError: safeString(target.retryError),
  });
  reduceRinFrontendLifecycleState(state, event);
  target.turnActive = state.turnActive;
  target.isStreaming = state.isStreaming;
  target.isCompacting = state.isCompacting;
  target.compactionReason = state.compactionReason;
  target.retryAttempt = state.retryAttempt;
  target.maxRetryAttempts = state.maxRetryAttempts;
  target.retryDelayMs = state.retryDelayMs;
  target.retryError = state.retryError;
  return state;
}

export function projectRinFrontendLifecycleEvent(
  payload: any,
): RinFrontendLifecycleEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const requestTag = requestTagOf(payload);
  switch (payload.type) {
    case "agent_start":
      return { kind: "agent_started", ...requestTag };
    case "agent_end":
      return {
        kind: "agent_stopped",
        settled: payload.settled !== false,
        ...requestTag,
      };
    case "agent_settled":
      return { kind: "agent_settled", ...requestTag };
    case "compaction_start":
      return {
        kind: "compaction_started",
        reason: safeString(payload.reason),
        ...requestTag,
      };
    case "compaction_end":
      return {
        kind: "compaction_finished",
        reason: safeString(payload.reason),
        result: payload.result,
        tokensBefore: safeNumber(
          payload.tokensBefore ?? payload.result?.tokensBefore,
        ),
        aborted: payload.aborted === true,
        willRetry: payload.willRetry === true,
        errorMessage: safeString(payload.errorMessage).trim(),
        ...requestTag,
      };
    case "auto_retry_start":
      return {
        kind: "retry_scheduled",
        source: "agent",
        attempt: safeNumber(payload.attempt),
        maxAttempts: safeNumber(payload.maxAttempts),
        delayMs: safeNumber(payload.delayMs),
        errorMessage: safeString(payload.errorMessage).trim(),
        ...requestTag,
      };
    case "auto_retry_end":
      return {
        kind: "retry_finished",
        success: payload.success === true,
        attempt: safeNumber(payload.attempt),
        finalError: safeString(payload.finalError).trim(),
        ...requestTag,
      };
    case "summarization_retry_scheduled":
      return {
        kind: "retry_scheduled",
        source: "summarization",
        attempt: safeNumber(payload.attempt),
        maxAttempts: safeNumber(payload.maxAttempts),
        delayMs: safeNumber(payload.delayMs),
        errorMessage: safeString(payload.errorMessage).trim(),
        ...requestTag,
      };
    case "summarization_retry_attempt_start":
      return {
        kind: "summarization_retry_started",
        source:
          payload.source === "branchSummary" ? "branchSummary" : "compaction",
        reason: safeString(payload.reason),
        ...requestTag,
      };
    case "summarization_retry_finished":
      return { kind: "summarization_retry_finished", ...requestTag };
    case "rpc_turn_event":
      if (payload.event === "start" || payload.event === "heartbeat") {
        return {
          kind: "turn_started",
          source: payload.event,
          ...requestTag,
        };
      }
      if (payload.event === "complete") {
        return {
          kind: "turn_terminal",
          outcome: "complete",
          finalText: safeString(payload.finalText).trim(),
          result: payload.result,
          sessionId: optionalText(payload.sessionId),
          sessionFile: optionalText(payload.sessionFile),
          chatDeliveryContext: optionalChatDeliveryContext(
            payload.chatDeliveryContext,
          ),
          terminalRecord: optionalTerminalRecord(payload.terminalRecord),
          ...requestTag,
        };
      }
      if (payload.event === "error") {
        return {
          kind: "turn_terminal",
          outcome: "error",
          error: safeString(payload.error).trim() || "rpc_turn_failed",
          sessionId: optionalText(payload.sessionId),
          sessionFile: optionalText(payload.sessionFile),
          chatDeliveryContext: optionalChatDeliveryContext(
            payload.chatDeliveryContext,
          ),
          terminalRecord: optionalTerminalRecord(payload.terminalRecord),
          ...requestTag,
        };
      }
      return null;
    case "frontend_turn_aborted":
      return {
        kind: "turn_terminal",
        outcome: "aborted",
        error: safeString(payload.error).trim() || "chat_turn_aborted",
        sessionId: optionalText(payload.sessionId),
        sessionFile: optionalText(payload.sessionFile),
        ...requestTag,
      };
    default:
      return null;
  }
}

function clearRetry(state: RinFrontendLifecycleState) {
  state.retryAttempt = 0;
  state.maxRetryAttempts = 0;
  state.retryDelayMs = 0;
  state.retryError = "";
}

export function reduceRinFrontendLifecycleState(
  state: RinFrontendLifecycleState,
  event: RinFrontendLifecycleEvent,
): RinFrontendLifecycleState {
  switch (event.kind) {
    case "turn_started":
      state.turnActive = true;
      break;
    case "agent_started":
      state.turnActive = true;
      state.isStreaming = true;
      clearRetry(state);
      break;
    case "agent_stopped":
      state.isStreaming = false;
      clearRetry(state);
      break;
    case "agent_settled":
      state.isStreaming = false;
      state.isCompacting = false;
      state.compactionReason = "";
      clearRetry(state);
      break;
    case "compaction_started":
      state.isCompacting = true;
      state.compactionReason = event.reason;
      clearRetry(state);
      break;
    case "compaction_finished":
      state.isCompacting = false;
      state.compactionReason = "";
      clearRetry(state);
      break;
    case "retry_scheduled":
      state.retryAttempt = event.attempt;
      state.maxRetryAttempts = event.maxAttempts;
      state.retryDelayMs = event.delayMs;
      state.retryError = event.errorMessage;
      break;
    case "summarization_retry_started":
      clearRetry(state);
      break;
    case "summarization_retry_finished":
    case "retry_finished":
      clearRetry(state);
      break;
    case "turn_terminal":
      state.turnActive = false;
      state.isStreaming = false;
      state.isCompacting = false;
      state.compactionReason = "";
      clearRetry(state);
      break;
  }
  return state;
}

function withRequestTag<T extends Record<string, unknown>>(
  event: RinFrontendLifecycleEvent,
  value: T,
): T & { requestTag?: string } {
  return event.requestTag ? { ...value, requestTag: event.requestTag } : value;
}

function retryStatusText(
  event: Extract<RinFrontendLifecycleEvent, { kind: "retry_scheduled" }>,
) {
  const seconds = Math.ceil(event.delayMs / 1000);
  return `Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s... (/abort to stop)`;
}

export function shouldRefreshRinFrontendLifecycleStatus(
  event: RinFrontendLifecycleEvent,
): boolean {
  return (
    event.kind === "agent_stopped" ||
    event.kind === "agent_settled" ||
    event.kind === "compaction_started" ||
    event.kind === "compaction_finished" ||
    event.kind === "retry_scheduled" ||
    event.kind === "summarization_retry_started" ||
    event.kind === "summarization_retry_finished" ||
    event.kind === "retry_finished"
  );
}

export function isRinFrontendLifecyclePresentationEvent(
  event: RinFrontendLifecycleEvent,
): boolean {
  return (
    event.kind !== "agent_stopped" &&
    event.kind !== "agent_settled" &&
    shouldRefreshRinFrontendLifecycleStatus(event)
  );
}

export function renderRinFrontendLifecycleEvent(
  event: RinFrontendLifecycleEvent,
  options: RinFrontendLifecycleRenderOptions = {},
): RinFrontendBackendEvent[] {
  switch (event.kind) {
    case "turn_started":
      return [withRequestTag(event, { type: "turn_accepted" })];
    case "agent_started":
    case "agent_stopped":
    case "agent_settled":
      return [];
    case "compaction_started":
      return [
        {
          type: "compaction_start_notice",
          text:
            safeString(options.compactionStartText).trim() ||
            "Compacting context...",
        },
      ];
    case "compaction_finished": {
      if (event.aborted) {
        return [
          withRequestTag(event, {
            type: "passive_notice",
            text:
              event.reason === "manual"
                ? "Compaction cancelled"
                : "Auto-compaction cancelled",
            level: event.reason === "manual" ? "error" : "info",
            deferDuringTurn: false,
            noticeKind: "lifecycle_error",
          }),
        ];
      }
      if (event.errorMessage) {
        return [
          withRequestTag(event, {
            type: "passive_notice",
            text: event.errorMessage,
            level: "error",
            deferDuringTurn: false,
            noticeKind: "lifecycle_error",
          }),
        ];
      }
      const summary = formatCompactionSummaryCollapsedText(
        event.tokensBefore,
        options,
      );
      return summary
        ? [
            withRequestTag(event, {
              type: "passive_notice",
              text: summary,
              level: "info",
              deferDuringTurn: false,
              noticeKind: "compaction_end",
            }),
          ]
        : [];
    }
    case "retry_scheduled": {
      const events: RinFrontendBackendEvent[] = [];
      if (event.source === "summarization" && event.errorMessage) {
        events.push(
          withRequestTag(event, {
            type: "passive_notice",
            text: event.errorMessage,
            level: "error",
            deferDuringTurn: false,
            noticeKind: "lifecycle_error",
          }),
        );
      }
      events.push(
        withRequestTag(event, {
          type: "assistant_summary",
          text: retryStatusText(event),
        }),
      );
      return events;
    }
    case "summarization_retry_started":
      return [
        withRequestTag(event, {
          type: "assistant_summary",
          text:
            event.source === "branchSummary"
              ? "Summarizing branch..."
              : "Compacting context...",
        }),
      ];
    case "summarization_retry_finished":
    case "retry_finished":
      return [];
    case "turn_terminal":
      if (event.outcome === "complete") {
        const terminal: RinFrontendBackendEvent = {
          type: "turn_complete",
          finalText: event.finalText,
          result: event.result,
          sessionId: event.sessionId,
          sessionFile: event.sessionFile,
          requestTag: event.requestTag,
          ...(event.chatDeliveryContext
            ? { chatDeliveryContext: event.chatDeliveryContext }
            : {}),
          ...(event.terminalRecord
            ? { terminalRecord: event.terminalRecord }
            : {}),
        };
        return event.finalText
          ? [
              {
                type: "assistant_final",
                text: event.finalText,
                result: event.result,
                sessionId: event.sessionId,
                sessionFile: event.sessionFile,
                requestTag: event.requestTag,
                ...(event.chatDeliveryContext
                  ? { chatDeliveryContext: event.chatDeliveryContext }
                  : {}),
                ...(event.terminalRecord
                  ? { terminalRecord: event.terminalRecord }
                  : {}),
              },
              terminal,
            ]
          : [terminal];
      }
      return [
        {
          type: "turn_error",
          error: event.error,
          sessionId: event.sessionId,
          sessionFile: event.sessionFile,
          requestTag: event.requestTag,
          ...(event.chatDeliveryContext
            ? { chatDeliveryContext: event.chatDeliveryContext }
            : {}),
          ...(event.terminalRecord
            ? { terminalRecord: event.terminalRecord }
            : {}),
        },
      ];
  }
}

export async function executeRinFrontendInterruptIntent(
  client: RinFrontendInterruptClient,
  intent: RinFrontendInterruptIntent,
): Promise<void> {
  switch (intent) {
    case "stop_turn":
      await client.abort();
      return;
    case "cancel_retry":
      if (typeof client.abortRetry !== "function") {
        throw new Error("Frontend client cannot cancel retry");
      }
      await client.abortRetry();
      return;
    case "cancel_compaction":
      if (typeof client.abortCompaction !== "function") {
        throw new Error("Frontend client cannot cancel compaction");
      }
      await client.abortCompaction();
      return;
  }
}
