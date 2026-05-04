import { normalizeSessionRef } from "../session/ref.js";
import {
  countToolCalls,
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

export type RinFrontendBackendEventTranslator = {
  translate(event: unknown): RinFrontendBackendEvent[];
  resetAssistantSegments(): void;
};

export function createRinFrontendBackendEventTranslator(): RinFrontendBackendEventTranslator {
  let latestAssistantText = "";
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
          if (countToolCalls(payload.message?.content) <= 0) {
            return text ? [{ type: "assistant_final", text }] : [];
          }
          const interim = takeInterim(assistantInterimText(payload.message));
          return interim ? [interim] : [];
        }
        case "tool_execution_start":
        case "tool_execution_end":
        case "compaction_start":
        case "compaction_end":
          return [{ type: "turn_accepted" }];
        default:
          return [];
      }
    },
  };
}
