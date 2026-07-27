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
  type RinTodoItem,
} from "../rin-lib/todo-state.js";
import { safeString } from "../text-utils.js";
import {
  resolveRinFrontendCommandResponses,
  type RinFrontendCommandResponses,
} from "./command-responses.js";
import {
  isRinFrontendLifecyclePresentationEvent,
  RinFrontendLifecycleTerminalGate,
  projectRinFrontendLifecycleEvent,
  renderRinFrontendLifecycleEvent,
} from "./frontend-lifecycle.js";
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
    phase === "compacting" ||
    phase === "retrying"
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

function completedAssistantSummary(payload: any) {
  const event = payload?.assistantMessageEvent;
  if (event?.type !== "thinking_end") return "";
  return safeString(event.content).trim();
}

type TodoNotice = {
  text: string;
  todos: RinTodoItem[];
  error?: string;
  sourceEventId?: string;
};

type ActiveToolBatch = {
  pendingToolCallIds: Set<string>;
  latestTodoNotice: TodoNotice | null;
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

function todoNoticeFromDetails(details: unknown): TodoNotice | null {
  const value =
    details && typeof details === "object" ? (details as any) : null;
  if (!value) return null;
  const todos = normalizeRinTodoItems(value.todos);
  if (!todos) return null;
  const checklist = todos.length ? formatRinTodoChecklistContent(todos) : "";
  const error = safeString(value.error).trim();
  return {
    text: error
      ? `Error: ${error}${checklist ? `\n${checklist}` : ""}`
      : checklist,
    todos,
    ...(error ? { error } : {}),
  };
}

function todoNoticeFromToolResult(result: unknown): TodoNotice | null {
  const value = result && typeof result === "object" ? (result as any) : null;
  return value
    ? todoNoticeFromDetails(value.details) || todoNoticeFromDetails(value)
    : null;
}

function collectNestedTodoNotices(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): TodoNotice[] {
  if (depth > 6 || !value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      collectNestedTodoNotices(item, depth + 1, seen),
    );
  }

  const record = value as Record<string, any>;
  const notices: TodoNotice[] = [];
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

function toolExecutionTodoNotice(payload: any): TodoNotice | null {
  if (isTodoToolName(payload?.toolName)) {
    return todoNoticeFromToolResult(payload?.result);
  }
  const notices = collectNestedTodoNotices(payload?.result);
  return notices.length ? notices[notices.length - 1] : null;
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
    latestTodoNotice: null,
  } satisfies ActiveToolBatch;
}

function todoPassiveNotice(notice: TodoNotice) {
  return {
    type: "passive_notice",
    text: notice.text,
    level: "info",
    deferDuringTurn: false,
    noticeKind: "todo",
    todoItems: notice.todos.map((todo) => ({ ...todo })),
    ...(notice.error ? { todoError: notice.error } : {}),
    ...(notice.sourceEventId ? { sourceEventId: notice.sourceEventId } : {}),
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
  const lifecycleTerminalGate = new RinFrontendLifecycleTerminalGate();
  let latestDeliveredAssistantSummary = "";
  const deliveredAssistantInterimTexts = new Set<string>();

  const resetAssistantSegments = () => {
    latestAssistantText = "";
    latestAssistantFinalText = "";
    activeToolBatch = null;
    latestDeliveredAssistantSummary = "";
    deliveredAssistantInterimTexts.clear();
  };

  const takeSummary = (text: string, requestTag = "") => {
    const trimmed = safeString(text).trim();
    if (!trimmed || latestDeliveredAssistantSummary === trimmed) return null;
    latestDeliveredAssistantSummary = trimmed;
    return {
      type: "assistant_summary",
      text: trimmed,
      ...(requestTag ? { requestTag } : {}),
    } satisfies RinFrontendBackendEvent;
  };

  const takeInterim = (text: string, requestTag = "") => {
    const trimmed = safeString(text).trim();
    if (!trimmed || deliveredAssistantInterimTexts.has(trimmed)) return null;
    deliveredAssistantInterimTexts.add(trimmed);
    return {
      type: "assistant_interim",
      text: trimmed,
      ...(requestTag ? { requestTag } : {}),
    } satisfies RinFrontendBackendEvent;
  };

  return {
    resetAssistantSegments,
    translate(event: unknown) {
      const payload = eventPayload(event);
      if (!payload || typeof payload !== "object") return [];
      const requestTag = safeString(payload.requestTag).trim();
      const normalizedLifecyclePayload =
        payload.type === "rpc_turn_event"
          ? { ...payload, ...normalizeSessionRef(payload) }
          : payload;
      const lifecycleEvent = projectRinFrontendLifecycleEvent(
        normalizedLifecyclePayload,
      );
      if (lifecycleEvent && !lifecycleTerminalGate.accept(lifecycleEvent)) {
        return [];
      }
      const renderLifecycle = () =>
        lifecycleEvent
          ? renderRinFrontendLifecycleEvent(lifecycleEvent, {
              compactionStartText: commandResponses.compactionStart,
              expandHintText: options.compactionExpandHintText,
              expandKeyText: options.compactionExpandKeyText,
              lineTemplate: commandResponses.compactionSummaryLine,
              textTemplate: commandResponses.compactionSummaryText,
            })
          : [];

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

      if (
        lifecycleEvent &&
        isRinFrontendLifecyclePresentationEvent(lifecycleEvent)
      ) {
        return renderLifecycle();
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
          const finalText = safeString(payload.finalText).trim();
          if (finalText) {
            latestAssistantText = finalText;
            latestAssistantFinalText = finalText;
          }
          return renderLifecycle();
        }
        if (payload.event === "error") return renderLifecycle();
      }

      switch (payload.type) {
        case "agent_start":
          resetAssistantSegments();
          return [
            {
              type: "turn_accepted",
              ...(requestTag ? { requestTag } : {}),
            },
          ];
        case "message_start":
          if (payload?.message?.role !== "user") return [];
          return [
            {
              type: "user_message_start",
              text: safeString(
                extractMessageText(payload.message?.content, {
                  includeThinking: false,
                  trim: true,
                }),
              ).trim(),
              ...(requestTag ? { requestTag } : {}),
            },
          ];
        case "agent_end":
        case "agent_settled":
          return [];
        case "message_update": {
          if (payload?.message?.role !== "assistant") return [];
          latestAssistantText =
            assistantText(payload.message) || latestAssistantText;
          const events: RinFrontendBackendEvent[] = [];
          const summary = takeSummary(
            completedAssistantSummary(payload),
            requestTag,
          );
          if (summary) events.push(summary);
          if (latestAssistantText) {
            events.push({
              type: "assistant_stream",
              text: latestAssistantText,
              ...(requestTag ? { requestTag } : {}),
            });
          }
          return events;
        }
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
            return [
              {
                type: "assistant_final",
                text: finalText,
                ...(requestTag ? { requestTag } : {}),
              },
            ];
          }
          const interim = takeInterim(
            assistantInterimText(payload.message),
            requestTag,
          );
          return interim ? [interim] : [];
        }
        case "tool_execution_start":
          return [
            {
              type: "turn_accepted",
              ...(requestTag ? { requestTag } : {}),
            },
          ];
        case "tool_execution_end": {
          const events: RinFrontendBackendEvent[] = [
            {
              type: "turn_accepted",
              ...(requestTag ? { requestTag } : {}),
            },
          ];
          const todoNotice = toolExecutionTodoNotice(payload);
          const currentBatch = activeToolBatch;
          const id = toolCallId(payload.toolCallId);
          if (todoNotice && id) todoNotice.sourceEventId = id;
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
        default:
          return [];
      }
    },
  };
}
