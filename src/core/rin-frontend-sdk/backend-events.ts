import { normalizeSessionRef } from "../session/ref.js";
import {
  extractAssistantFinalText,
  extractMessageText,
  extractTextBeforeFirstToolCall,
} from "../message-content.js";
import { safeString } from "../text-utils.js";
import type {
  RinFrontendBackendEvent,
  RinFrontendStatusPhase,
} from "./types.js";

function eventPayload(event: unknown): any {
  const value: any = event;
  if (value?.type === "ui") return value.payload;
  if (value?.type === "extension_ui_request") return value.payload;
  return value;
}

function statusPhase(value: unknown): RinFrontendStatusPhase {
  const phase = safeString(value).trim();
  if (
    phase === "idle" ||
    phase === "connecting" ||
    phase === "starting" ||
    phase === "sending" ||
    phase === "working" ||
    phase === "compacting"
  ) {
    return phase;
  }
  return "idle";
}

function assistantText(message: any) {
  return safeString(
    extractMessageText(message?.content, {
      includeThinking: false,
      trim: true,
    }),
  ).trim();
}

function assistantInterimText(message: any) {
  return safeString(
    extractTextBeforeFirstToolCall(message?.content, {
      includeThinking: false,
      trim: true,
    }),
  ).trim();
}

function isPiOverflowContinuation(payload: any) {
  return (
    safeString(payload?.type).trim() === "compaction_end" &&
    safeString(payload?.reason).trim() === "overflow" &&
    payload?.willRetry === true &&
    payload?.aborted !== true
  );
}

export type RinFrontendBackendEventTranslator = {
  translate(event: unknown): RinFrontendBackendEvent[];
  resetAssistantSegments(): void;
};

export function createRinFrontendBackendEventTranslator(): RinFrontendBackendEventTranslator {
  let latestAssistantText = "";
  let nativeContinuationPending = false;
  const deliveredAssistantInterimTexts = new Set<string>();

  const resetAssistantSegments = () => {
    latestAssistantText = "";
    deliveredAssistantInterimTexts.clear();
  };

  const takeInterim = (text: string) => {
    const trimmed = safeString(text).trim();
    if (!trimmed || deliveredAssistantInterimTexts.has(trimmed)) return null;
    deliveredAssistantInterimTexts.add(trimmed);
    return {
      type: "assistant_interim",
      text: trimmed,
    } satisfies RinFrontendBackendEvent;
  };

  return {
    resetAssistantSegments,
    translate(event: unknown) {
      const payload = eventPayload(event);
      if (!payload || typeof payload !== "object") return [];

      if (payload.type === "rpc_frontend_status") {
        const phase = statusPhase(payload.phase);
        return [
          {
            type: "status",
            phase,
            label: safeString(payload.label).trim() || undefined,
            connected:
              typeof payload.connected === "boolean"
                ? payload.connected
                : undefined,
            turnActive:
              typeof payload.turnActive === "boolean"
                ? payload.turnActive
                : undefined,
            isStreaming:
              typeof payload.isStreaming === "boolean"
                ? payload.isStreaming
                : undefined,
          },
        ];
      }

      if (payload.type === "extension_ui_request") {
        const method = safeString(payload.method).trim();
        if (method === "notify") {
          const text = safeString(payload.message).trim();
          if (!text || !text.startsWith("💡 自我整理：")) return [];
          const notifyType = safeString(payload.notifyType).trim();
          const level =
            notifyType === "warning" || notifyType === "error"
              ? notifyType
              : "info";
          return [{ type: "passive_notice", text, level }];
        }
        return [];
      }

      if (payload.type === "rpc_turn_event") {
        if (payload.event === "start" || payload.event === "heartbeat") {
          return [
            {
              type: "turn_accepted",
              requestTag: safeString(payload.requestTag).trim() || undefined,
            },
          ];
        }
        if (payload.event === "complete") {
          const session = normalizeSessionRef(payload);
          const finalText =
            safeString(payload.finalText).trim() ||
            safeString(latestAssistantText).trim();
          const events: RinFrontendBackendEvent[] = [];
          if (finalText) {
            latestAssistantText = finalText;
            events.push({
              type: "assistant_final",
              text: finalText,
              result: payload.result,
              sessionId: session.sessionId,
              sessionFile: session.sessionFile,
              requestTag: safeString(payload.requestTag).trim() || undefined,
            });
          }
          events.push({
            type: "turn_complete",
            finalText,
            result: payload.result,
            sessionId: session.sessionId,
            sessionFile: session.sessionFile,
            requestTag: safeString(payload.requestTag).trim() || undefined,
          });
          return events;
        }
        if (payload.event === "error") {
          if (nativeContinuationPending) {
            return [{ type: "turn_continuing", reason: "overflow" }];
          }
          const session = normalizeSessionRef(payload);
          return [
            {
              type: "turn_error",
              error: safeString(payload.error).trim() || "rpc_turn_failed",
              sessionId: session.sessionId,
              sessionFile: session.sessionFile,
              requestTag: safeString(payload.requestTag).trim() || undefined,
            },
          ];
        }
      }

      switch (payload.type) {
        case "agent_start":
          resetAssistantSegments();
          return [{ type: "turn_accepted" }];
        case "agent_end":
          if (!latestAssistantText || nativeContinuationPending) return [];
          return [
            {
              type: "turn_complete",
              finalText: latestAssistantText,
            },
          ];
        case "message_update":
          if (payload?.message?.role !== "assistant") return [];
          latestAssistantText =
            assistantText(payload.message) || latestAssistantText;
          return latestAssistantText
            ? [{ type: "assistant_stream", text: latestAssistantText }]
            : [];
        case "message_end": {
          if (payload?.message?.role !== "assistant") return [];
          const text = assistantText(payload.message);
          if (text) latestAssistantText = text;
          const finalText = extractAssistantFinalText(payload.message);
          if (finalText) {
            latestAssistantText = finalText;
            nativeContinuationPending = false;
            return [{ type: "assistant_final", text: finalText }];
          }
          const interim = takeInterim(assistantInterimText(payload.message));
          return interim ? [interim] : [];
        }
        case "rin_working_start":
          return [{ type: "external_working_start" }];
        case "rin_working_end":
          return [{ type: "external_working_end" }];
        case "tool_execution_start":
        case "tool_execution_end":
          return [{ type: "turn_accepted" }];
        case "compaction_start":
          return [{ type: "external_working_start" }];
        case "compaction_end": {
          const events: RinFrontendBackendEvent[] = [
            { type: "external_working_end" },
          ];
          if (isPiOverflowContinuation(payload)) {
            nativeContinuationPending = true;
            events.push(
              { type: "turn_accepted" },
              { type: "turn_continuing", reason: "overflow" },
            );
          }
          return events;
        }
        default:
          return [];
      }
    },
  };
}
