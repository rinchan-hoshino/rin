import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import { type TruncationResult } from "@mariozechner/pi-coding-agent";
import {
  buildUserFacingTextResult,
  formatHiddenResultsNotice,
  formatToolDuration,
  prepareTruncatedText,
  renderTextToolResult,
} from "../pi/render-utils.js";

import {
  appendTranscriptArchiveEntry,
  loadRecentTranscriptSessions,
  searchTranscriptArchive,
} from "./transcripts.js";
import { readSessionMetadata } from "../session/metadata.js";

type MemoryToolDetails = {
  truncation?: TruncationResult;
  emptyMessage?: string;
  hiddenCount?: number;
  totalResults?: number;
  userText?: string;
  phase?: "search" | "recent" | "summarize";
};

type MemoryRenderState = {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
};

const searchMemoryParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Optional search query for past sessions. Leave it empty to browse recent sessions directly. For broad recall, prefer a few distinctive keywords joined by OR; use quoted phrases for exact wording when needed. If you do not have a good search phrase yet, call search_memory without a query first.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 8,
      description:
        "Maximum number of session-level memory results to return. Defaults to 8.",
    }),
  ),
});

async function archiveMessageTranscript(message: any, ctx: any) {
  if (!message || typeof message !== "object") return;
  const session = readSessionMetadata(ctx);
  await appendTranscriptArchiveEntry(
    {
      id: String(message?.id || "").trim(),
      timestamp:
        String(message?.timestamp || "").trim() || new Date().toISOString(),
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      role: String(message?.role || "").trim(),
      content: message?.content,
      toolName: String(message?.toolName || "").trim(),
      toolCallId: String(message?.toolCallId || "").trim(),
      customType: String(message?.customType || "").trim(),
      stopReason: String(message?.stopReason || "").trim(),
      errorMessage: String(message?.errorMessage || "").trim(),
      provider: String(message?.provider || "").trim(),
      model: String(message?.model || "").trim(),
      display:
        typeof message?.display === "boolean" ? message.display : undefined,
      command: message?.command,
      output: message?.output,
      summary: message?.summary,
      text: String(message?.content || "").trim(),
    },
    String(ctx?.agentDir || "").trim(),
  );
}

function trimSnippet(value: string, max = 220): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function resultSnippet(item: any): string {
  return trimSnippet(
    String(item?.summary || item?.name || item?.description || "").trim(),
  );
}

function resultLocation(item: any): string {
  return String(item?.path || item?.sessionId || "").trim() || "Session";
}

function resultMessages(item: any): Array<any> {
  return Array.isArray(item?.messages) ? item.messages : [];
}

function formatMessageLine(message: any): string {
  const line = Math.max(1, Number(message?.line || 0) || 1);
  const role = String(message?.role || "message").trim() || "message";
  const toolName = String(message?.toolName || "").trim();
  const label = toolName ? `${role}/${toolName}` : role;
  const text = trimSnippet(String(message?.text || "").trim(), 240);
  return `L${line} ${label}: ${text}`;
}

function searchResultHeader(response: any): string {
  const query = String(response?.query || "").trim();
  if (!query) return "search_memory recent";
  return `search_memory ${query}`;
}

export function formatSearchResult(response: any): string {
  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length)
    return `${searchResultHeader(response)}\n\nNo memory results found.`;
  return [
    searchResultHeader(response),
    ...rows.map((item: any) => {
      return [
        resultLocation(item),
        resultSnippet(item),
        ...resultMessages(item).map((message: any) =>
          formatMessageLine(message),
        ),
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

export function formatAgentSearchResult(response: any): string {
  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length) return `${searchResultHeader(response)}\n\n0 results`;
  return [
    `${searchResultHeader(response)} (${rows.length})`,
    ...rows.map((item: any, index: number) => {
      return [
        `${index + 1}. ${resultLocation(item)}`,
        resultSnippet(item),
        ...resultMessages(item).map((message: any) =>
          formatMessageLine(message),
        ),
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

function buildSearchMemorySearchStatusText(
  mode: "search" | "recent",
  query: string,
): string {
  if (mode === "recent") return "Loading recent archived sessions...";
  return `Searching archived sessions for ${JSON.stringify(query)}...`;
}

function emitSearchMemoryUpdate(
  onUpdate:
    | ((value: {
        content: Array<{ type: "text"; text: string }>;
        details: MemoryToolDetails;
      }) => void)
    | undefined,
  userText: string,
  details: Partial<MemoryToolDetails> = {},
) {
  onUpdate?.({
    content: [{ type: "text", text: userText }],
    details: {
      ...details,
      userText,
    },
  });
}

function formatMemoryResult(
  result: {
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    details?: MemoryToolDetails;
  },
  options: { expanded: boolean },
  theme: any,
  showImages: boolean,
) {
  const topResultsNotice = formatHiddenResultsNotice(
    result.details?.totalResults ?? 0,
    result.details?.hiddenCount ?? 0,
  );
  return renderTextToolResult(result, options, theme, showImages, {
    extraMutedLines: topResultsNotice ? [topResultsNotice] : [],
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new Error("search_memory_aborted");
}

export async function executeSearchMemory(
  params: any,
  ctx: any,
  _currentThinkingLevel: ThinkingLevel,
  signal?: AbortSignal,
  onUpdate?: (value: {
    content: Array<{ type: "text"; text: string }>;
    details: MemoryToolDetails;
  }) => void,
) {
  try {
    const query = String(params?.query || "").trim();
    const mode = (query ? "search" : "recent") as "search" | "recent";
    const normalizedParams = {
      ...(params || {}),
      limit: Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 8,
    };
    const rootOverride = String(ctx?.agentDir || "").trim();

    emitSearchMemoryUpdate(
      onUpdate,
      buildSearchMemorySearchStatusText(mode, query),
      {
        phase: mode,
      },
    );

    throwIfAborted(signal);
    const results = query
      ? await searchTranscriptArchive(query, normalizedParams, rootOverride)
      : await loadRecentTranscriptSessions(normalizedParams, rootOverride);
    throwIfAborted(signal);

    const response = {
      mode,
      query,
      count: Array.isArray(results) ? results.length : 0,
      results,
    };
    const agentText = formatAgentSearchResult(response);
    const userText = formatSearchResult(response);
    const truncated = prepareTruncatedText(agentText);
    const visibleRows = Array.isArray(response?.results)
      ? response.results
      : [];
    const details: MemoryToolDetails = {
      hiddenCount: 0,
      totalResults: visibleRows.length,
      userText,
    };

    if (!visibleRows.length) {
      details.emptyMessage = "No memory results found.";
    }

    if (truncated.truncation) {
      details.truncation = truncated.truncation;
    }
    return {
      name: "memory",
      content: [{ type: "text" as const, text: truncated.outputText }],
      details,
    };
  } catch (error: any) {
    const message = String(error?.message || error || "memory_search_failed");
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        ok: false,
        error: message,
        agentText: message,
        userText: `Memory search failed: ${message}`,
      },
      isError: true,
    };
  }
}

export function formatRenderedMemoryResult(
  result: any,
  options: any,
  theme: any,
  showImages: boolean,
  startedAt?: number,
  endedAt?: number,
) {
  const details = (result.details as MemoryToolDetails | undefined) || {};
  const userResult = buildUserFacingTextResult(result, showImages, {
    userText: details.userText,
    details: {
      truncation: details.truncation,
      emptyMessage: details.emptyMessage,
      hiddenCount: details.hiddenCount,
      totalResults: details.totalResults,
    },
  });
  let text = formatMemoryResult(userResult, options, theme, showImages);
  const duration = formatToolDuration(startedAt, endedAt);
  if (duration) {
    const durationText = theme.fg("muted", duration);
    text = text ? `${text}\n${durationText}` : `\n${durationText}`;
  }
  return text;
}

function renderMemoryResult(
  result: any,
  options: any,
  theme: any,
  context: any,
) {
  const state = context.state as MemoryRenderState;
  if (state.startedAt !== undefined && options.isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
  }
  if (!options.isPartial || context.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  const text =
    (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(
    formatRenderedMemoryResult(
      result,
      options,
      theme,
      context.showImages,
      state.startedAt,
      state.endedAt,
    ),
  );
  return text;
}

export function formatSearchMemoryCall(args: any, theme: any) {
  const query = String(args?.query || "").trim();
  if (!query) {
    return `${theme.fg("toolTitle", theme.bold("search_memory"))} ${theme.fg("muted", "recent")}`;
  }
  return `${theme.fg("toolTitle", theme.bold("search_memory"))} ${theme.fg("accent", query)}`;
}

export default function memoryModule(
  options: RinCapabilityOptions,
): RinCapabilityDefinition {
  return {
    tools: [
      {
        name: "search_memory",
        label: "Search Memory",
        description:
          "Search past sessions for long-term recall, or browse recent sessions directly when no query is provided.",
        promptSnippet: "Search archived session history.",
        promptGuidelines: [
          "Use search_memory proactively for past-conversation recall when the user references earlier work or relevant cross-session context may matter; better to search and confirm than to guess or ask them to repeat themselves.",
          "If you do not have a good search phrase yet, call search_memory without a query to browse recent sessions first.",
        ],
        parameters: searchMemoryParams,
        execute: async (_toolCallId, params, signal, onUpdate, ctx) =>
          (await executeSearchMemory(
            params,
            ctx,
            options.getThinkingLevel() as ThinkingLevel,
            signal,
            onUpdate as any,
          )) as any,
        renderCall: (args, theme, context) => {
          const state = context.state as MemoryRenderState;
          if (context.executionStarted && state.startedAt === undefined) {
            state.startedAt = Date.now();
            state.endedAt = undefined;
          }
          const text =
            (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
          text.setText(formatSearchMemoryCall(args, theme));
          return text;
        },
        renderResult: renderMemoryResult,
      },
    ],
    hooks: {
      message_end: [
        async (event, ctx) => {
          await archiveMessageTranscript(event?.message, ctx);
        },
      ],
    },
  };
}
