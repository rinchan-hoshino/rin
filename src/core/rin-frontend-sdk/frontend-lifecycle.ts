import {
  formatCompactionSummaryCollapsedText,
  type CompactionSummaryCollapsedTextOptions,
} from "./compaction-summary-format.js";
import type { RinFrontendBackendEvent } from "./types.js";

export type RinFrontendLifecyclePhase =
  | "idle"
  | "working"
  | "compacting"
  | "retrying";

export type RinFrontendInterruptIntent =
  | "stop_turn"
  | "cancel_retry"
  | "cancel_compaction";

export interface RinFrontendLifecycleStateTarget {
  turnActive?: boolean;
  isStreaming?: boolean;
  workingVisible?: boolean;
  isCompacting?: boolean;
  compactionReason?: string;
  retryAttempt?: number;
  maxRetryAttempts?: number;
  retryDelayMs?: number;
  retryError?: string;
}

export interface RinFrontendLifecycleState {
  phase: RinFrontendLifecyclePhase;
  turnActive: boolean;
  isStreaming: boolean;
  workingVisible: boolean;
  isCompacting: boolean;
  compactionReason: string;
  retryAttempt: number;
  maxRetryAttempts: number;
  retryDelayMs: number;
  retryError: string;
}

interface LifecycleEventBase {
  terminalEventId?: string;
  requestTag?: string;
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
      kind: "working_visibility";
      visible: boolean;
    })
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

function optionalText(value: unknown): string | undefined {
  const text = safeString(value).trim();
  return text || undefined;
}

function requestTagOf(payload: any): LifecycleEventBase {
  const terminalEventId = optionalText(payload?.terminalEventId);
  const requestTagPresent =
    Object.prototype.hasOwnProperty.call(payload || {}, "requestTag") &&
    payload.requestTag != null;
  const requestTag = requestTagPresent
    ? safeString(payload.requestTag)
    : undefined;
  const turnGeneration = safeNumber(payload?.turnGeneration);
  const sessionId = optionalText(payload?.sessionId);
  const sessionFile = optionalText(payload?.sessionFile);
  return {
    ...(terminalEventId ? { terminalEventId } : {}),
    ...(requestTagPresent ? { requestTag } : {}),
    ...(turnGeneration > 0 ? { turnGeneration } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

export function createRinFrontendLifecycleState(
  initial: Partial<RinFrontendLifecycleState> = {},
): RinFrontendLifecycleState {
  return {
    phase: "idle",
    turnActive: false,
    isStreaming: false,
    workingVisible: false,
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
    workingVisible: target.workingVisible === true,
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
  target.workingVisible = state.workingVisible;
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
    case "working_visibility":
      return {
        kind: "working_visibility",
        visible: payload.visible === true,
        ...requestTag,
      };
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

function phaseAfterTransientWork(
  state: RinFrontendLifecycleState,
): RinFrontendLifecyclePhase {
  if (state.isCompacting) return "compacting";
  return state.turnActive ? "working" : "idle";
}

export function reduceRinFrontendLifecycleState(
  state: RinFrontendLifecycleState,
  event: RinFrontendLifecycleEvent,
): RinFrontendLifecycleState {
  switch (event.kind) {
    case "turn_started":
      state.turnActive = true;
      if (state.phase === "idle") state.phase = "working";
      break;
    case "agent_started":
      state.turnActive = true;
      state.isStreaming = true;
      state.phase = "working";
      clearRetry(state);
      break;
    case "agent_stopped":
      state.isStreaming = false;
      clearRetry(state);
      state.phase = phaseAfterTransientWork(state);
      break;
    case "agent_settled":
      state.isStreaming = false;
      state.isCompacting = false;
      state.compactionReason = "";
      clearRetry(state);
      state.phase = phaseAfterTransientWork(state);
      break;
    case "working_visibility":
      state.workingVisible = event.visible;
      break;
    case "compaction_started":
      state.isCompacting = true;
      state.compactionReason = event.reason;
      clearRetry(state);
      state.phase = "compacting";
      break;
    case "compaction_finished":
      state.isCompacting = false;
      state.compactionReason = "";
      clearRetry(state);
      state.phase = phaseAfterTransientWork(state);
      break;
    case "retry_scheduled":
      state.retryAttempt = event.attempt;
      state.maxRetryAttempts = event.maxAttempts;
      state.retryDelayMs = event.delayMs;
      state.retryError = event.errorMessage;
      state.phase = "retrying";
      break;
    case "summarization_retry_started":
      clearRetry(state);
      state.phase = state.isCompacting ? "compacting" : "working";
      break;
    case "summarization_retry_finished":
    case "retry_finished":
      clearRetry(state);
      state.phase = phaseAfterTransientWork(state);
      break;
    case "turn_terminal":
      state.turnActive = false;
      state.isStreaming = false;
      state.workingVisible = false;
      state.isCompacting = false;
      state.compactionReason = "";
      clearRetry(state);
      state.phase = "idle";
      break;
  }
  return state;
}

function withRequestTag<T extends Record<string, unknown>>(
  event: RinFrontendLifecycleEvent,
  value: T,
): T & { requestTag?: string } {
  return Object.prototype.hasOwnProperty.call(event, "requestTag")
    ? { ...value, requestTag: event.requestTag }
    : value;
}

function retryStatusText(
  event: Extract<RinFrontendLifecycleEvent, { kind: "retry_scheduled" }>,
) {
  const seconds = Math.ceil(event.delayMs / 1000);
  return `Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s... (/abort to stop)`;
}

const MAX_FRONTEND_TERMINAL_IDENTITIES = 4_096;

export class RinFrontendLifecycleTerminalGate {
  private readonly terminalIdentities = new Set<string>();

  private terminalIdentity(event: RinFrontendLifecycleEvent): string {
    const session = event.sessionId || event.sessionFile || "session";
    if (event.terminalEventId) {
      return `${session}:terminal:${event.terminalEventId}`;
    }
    if (event.turnGeneration && event.turnGeneration > 0) {
      return `${session}:generation:${event.turnGeneration}`;
    }
    if (event.requestTag) return `${session}:request:${event.requestTag}`;
    return `${session}:identityless`;
  }

  accept(event: RinFrontendLifecycleEvent): boolean {
    if (event.kind !== "turn_terminal") return true;
    const identity = this.terminalIdentity(event);
    if (this.terminalIdentities.has(identity)) return false;
    this.terminalIdentities.add(identity);
    while (this.terminalIdentities.size > MAX_FRONTEND_TERMINAL_IDENTITIES) {
      const oldestIdentity = this.terminalIdentities.values().next().value;
      if (!oldestIdentity) break;
      this.terminalIdentities.delete(oldestIdentity);
    }
    return true;
  }
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
    event.kind === "working_visibility" ||
    (event.kind !== "agent_stopped" &&
      event.kind !== "agent_settled" &&
      shouldRefreshRinFrontendLifecycleStatus(event))
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
      return [{ type: "status", phase: "working" }];
    case "agent_stopped":
      return [{ type: "status", phase: "working" }];
    case "agent_settled":
      return [{ type: "status", phase: "working" }];
    case "working_visibility":
      return [{ type: "working_visible", visible: event.visible }];
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
    case "turn_terminal": {
      const terminalEventIdentity = event.terminalEventId
        ? { terminalEventId: event.terminalEventId }
        : {};
      if (event.outcome === "complete") {
        const terminal: RinFrontendBackendEvent = {
          type: "turn_complete",
          finalText: event.finalText,
          result: event.result,
          sessionId: event.sessionId,
          sessionFile: event.sessionFile,
          ...terminalEventIdentity,
          ...(Object.prototype.hasOwnProperty.call(event, "requestTag")
            ? { requestTag: event.requestTag }
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
                ...terminalEventIdentity,
                ...(Object.prototype.hasOwnProperty.call(event, "requestTag")
                  ? { requestTag: event.requestTag }
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
          ...terminalEventIdentity,
          ...(Object.prototype.hasOwnProperty.call(event, "requestTag")
            ? { requestTag: event.requestTag }
            : {}),
        },
      ];
    }
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
