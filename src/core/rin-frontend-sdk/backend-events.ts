import { normalizeSessionRef } from "../session/ref.js";
import {
  extractAssistantFinalText,
  extractMessageText,
  extractTextBeforeFirstToolCall,
  extractToolCallParts,
  isAssistantFailedMessage,
} from "../message-content.js";
import {
  formatRinTodoChecklistContent,
  normalizeRinTodoItems,
} from "../rin-lib/todo-state.js";
import { safeString } from "../text-utils.js";
import {
  resolveRinFrontendCommandResponses,
  type RinFrontendCommandResponses,
} from "./command-responses.js";
import { formatCompactionSummaryCollapsedText } from "./compaction-summary-format.js";
import type {
  RinFrontendBackendEvent,
  RinFrontendStatusPhase,
} from "./types.js";

function eventPayload(event: unknown): any {
  const value: any = event;
  if (value?.type === "ui") return value.payload;
  if (value?.type === "extension_ui_request") return value.payload || value;
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

type ActiveToolBatch = {
  pendingToolCallIds: Set<string>;
  latestTodoNotice: string;
};

const NESTED_TOOL_RESULT_KEYS = [
  "result",
  "results",
  "toolResult",
  "toolResults",
  "tool_result",
  "tool_results",
  "output",
  "outputs",
  "items",
  "content",
  "details",
];

function normalizeToolName(value: unknown) {
  return safeString(value).trim();
}

function isTodoToolName(value: unknown) {
  const name = normalizeToolName(value);
  return Boolean(name && (name === "todo" || /(?:^|[./:])todo$/.test(name)));
}

function toolCallId(value: unknown) {
  return safeString(value).trim();
}

function toolNameFromRecord(value: Record<string, any>) {
  return (
    value.toolName ||
    value.name ||
    value.recipient_name ||
    value.recipientName ||
    ""
  );
}

function todoNoticeFromDetails(details: unknown) {
  const value =
    details && typeof details === "object" ? (details as any) : null;
  if (!value) return "";
  const todos = normalizeRinTodoItems(value.todos);
  if (!todos) return "";
  const checklist = formatRinTodoChecklistContent(todos);
  const error = safeString(value.error).trim();
  return error ? `Error: ${error}\n${checklist}` : checklist;
}

function todoNoticeFromToolResult(result: unknown) {
  const value = result && typeof result === "object" ? (result as any) : null;
  return value
    ? todoNoticeFromDetails(value.details) || todoNoticeFromDetails(value)
    : "";
}

function collectNestedTodoNotices(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): string[] {
  if (depth > 6 || !value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      collectNestedTodoNotices(item, depth + 1, seen),
    );
  }

  const record = value as Record<string, any>;
  const notices: string[] = [];
  if (isTodoToolName(toolNameFromRecord(record))) {
    const notice = todoNoticeFromToolResult(
      record.result ?? record.toolResult ?? record.output ?? record,
    );
    if (notice) notices.push(notice);
  }

  for (const key of NESTED_TOOL_RESULT_KEYS) {
    if (key in record) {
      notices.push(...collectNestedTodoNotices(record[key], depth + 1, seen));
    }
  }
  return notices;
}

function toolExecutionTodoNotice(payload: any) {
  if (isTodoToolName(payload?.toolName)) {
    return todoNoticeFromToolResult(payload?.result);
  }
  const notices = collectNestedTodoNotices(payload?.result);
  return notices.length ? notices[notices.length - 1] : "";
}

function activeToolBatchFromAssistantMessage(message: any) {
  const toolCalls = extractToolCallParts(message?.content);
  if (!toolCalls.length) return null;

  return {
    pendingToolCallIds: new Set(
      toolCalls
        .map((part: any) => toolCallId(part.id || part.toolCallId))
        .filter(Boolean),
    ),
    latestTodoNotice: "",
  } satisfies ActiveToolBatch;
}

function todoPassiveNotice(text: string) {
  return {
    type: "passive_notice",
    text,
    level: "info",
    deferDuringTurn: false,
    noticeKind: "todo",
  } satisfies RinFrontendBackendEvent;
}

export type RinFrontendBackendEventTranslator = {
  translate(event: unknown): RinFrontendBackendEvent[];
  resetAssistantSegments(): void;
};

export function createRinFrontendBackendEventTranslator(
  options: {
    commandResponses?: Partial<RinFrontendCommandResponses>;
    compactionExpandHintText?: string | false | null;
    compactionExpandKeyText?: string;
  } = {},
): RinFrontendBackendEventTranslator {
  const commandResponses = resolveRinFrontendCommandResponses(
    options.commandResponses,
  );
  let latestAssistantText = "";
  let latestAssistantFinalText = "";
  let activeToolBatch: ActiveToolBatch | null = null;
  const deliveredAssistantInterimTexts = new Set<string>();

  const resetAssistantSegments = () => {
    latestAssistantText = "";
    latestAssistantFinalText = "";
    activeToolBatch = null;
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
        if (payload.method === "setWorkingVisible") {
          return [
            { type: "working_visible", visible: Boolean(payload.visible) },
          ];
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
          const finalText = safeString(payload.finalText).trim();
          const events: RinFrontendBackendEvent[] = [];
          if (finalText) {
            latestAssistantText = finalText;
            latestAssistantFinalText = finalText;
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
        case "agent_end":
          return [];
        case "message_update":
          if (payload?.message?.role !== "assistant") return [];
          latestAssistantText =
            assistantText(payload.message) || latestAssistantText;
          return latestAssistantText
            ? [{ type: "assistant_stream", text: latestAssistantText }]
            : [];
        case "message_end": {
          if (payload?.message?.role !== "assistant") return [];
          if (isAssistantFailedMessage(payload.message)) return [];
          const nextToolBatch = activeToolBatchFromAssistantMessage(
            payload.message,
          );
          activeToolBatch = nextToolBatch;
          const text = assistantText(payload.message);
          if (text) latestAssistantText = text;
          const finalText = extractAssistantFinalText(payload.message);
          if (finalText) {
            activeToolBatch = null;
            latestAssistantText = finalText;
            latestAssistantFinalText = finalText;
            return [{ type: "assistant_final", text: finalText }];
          }
          const interim = takeInterim(assistantInterimText(payload.message));
          return interim ? [interim] : [];
        }
        case "tool_execution_start":
          return [{ type: "turn_accepted" }];
        case "tool_execution_end": {
          const events: RinFrontendBackendEvent[] = [{ type: "turn_accepted" }];
          const todoNotice = toolExecutionTodoNotice(payload);
          const currentBatch = activeToolBatch;
          const id = toolCallId(payload.toolCallId);
          if (currentBatch?.pendingToolCallIds.has(id)) {
            currentBatch.pendingToolCallIds.delete(id);
            if (todoNotice) currentBatch.latestTodoNotice = todoNotice;
            if (currentBatch.pendingToolCallIds.size === 0) {
              const finalNotice = currentBatch.latestTodoNotice;
              activeToolBatch = null;
              if (finalNotice) events.push(todoPassiveNotice(finalNotice));
            }
            return events;
          }
          if (todoNotice) events.push(todoPassiveNotice(todoNotice));
          return events;
        }
        case "compaction_start":
          return [
            {
              type: "compaction_start_notice",
              text: commandResponses.compactionStart,
            },
            { type: "external_working_start" },
          ];
        case "compaction_end": {
          const events: RinFrontendBackendEvent[] = [];
          const notice = formatCompactionSummaryCollapsedText(
            payload.tokensBefore ?? payload.result?.tokensBefore,
            {
              expandHintText: options.compactionExpandHintText,
              expandKeyText: options.compactionExpandKeyText,
              lineTemplate: commandResponses.compactionSummaryLine,
              textTemplate: commandResponses.compactionSummaryText,
            },
          );
          if (notice) {
            events.push({
              type: "passive_notice",
              text: notice,
              level: "info",
              deferDuringTurn: false,
              noticeKind: "compaction_end",
            });
          }
          events.push({ type: "external_working_end" });
          return events;
        }
        default:
          return [];
      }
    },
  };
}
