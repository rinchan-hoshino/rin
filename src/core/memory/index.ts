import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { nowIso } from "../time-utils.js";
import { type TruncationResult } from "@earendil-works/pi-coding-agent";
import {
  buildUserFacingTextResult,
  formatHiddenResultsNotice,
  formatToolCallLine,
  formatToolDuration,
  prepareTruncatedText,
  renderTextToolResult,
} from "../pi/render-utils.js";

import {
  appendTranscriptArchiveEntry,
  extractTranscriptText,
  loadRecentTranscriptSessions,
  searchTranscriptArchive,
} from "./transcripts.js";
import {
  searchExternalMemoryProviders,
  writeExternalMemoryEntry,
} from "./external.js";
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

const recallParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Recall query. Omit it to browse recent sessions; use distinctive keywords, OR, or quoted exact wording when useful.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 8,
      description:
        "Maximum number of session-level recall results to return. Defaults to 8.",
    }),
  ),
});

function buildMemoryTranscriptInput(message: any, ctx: any) {
  if (!message || typeof message !== "object") return null;
  const session = readSessionMetadata(ctx);
  const input = {
    id: String(message?.id || "").trim(),
    timestamp: String(message?.timestamp || "").trim() || nowIso(),
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
    text: "",
  };
  input.text = extractTranscriptText(input);
  if (!input.role || !input.sessionFile || !input.text) return null;
  return input;
}

async function archiveMessageTranscript(message: any, ctx: any) {
  const input = buildMemoryTranscriptInput(message, ctx);
  if (!input) return;
  await Promise.allSettled([
    appendTranscriptArchiveEntry(input, String(ctx?.agentDir || "").trim()),
    writeExternalMemoryEntry(input),
  ]);
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
    String(
      item?.summary || item?.name || item?.description || item?.preview || "",
    ).trim(),
  );
}

function resultLocation(item: any): string {
  const direct = String(
    item?.path || item?.reference || item?.url || item?.sessionId || "",
  ).trim();
  if (direct) return direct;
  const provider = String(item?.provider || "").trim();
  const id = String(item?.id || item?.externalId || "").trim();
  if (provider && id) return `${provider}:${id}`;
  return id || "Memory";
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
  if (!query) return "recall recent";
  return `recall ${query}`;
}

export function formatSearchResult(response: any): string {
  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length) return "No recall results found.";
  return rows
    .map((item: any) => {
      return [
        resultLocation(item),
        resultSnippet(item),
        ...resultMessages(item).map((message: any) =>
          formatMessageLine(message),
        ),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
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

function buildRecallSearchStatusText(
  mode: "search" | "recent",
  query: string,
): string {
  if (mode === "recent") return "Loading recent archived sessions...";
  return `Searching archived sessions for ${JSON.stringify(query)}...`;
}

function emitRecallUpdate(
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
  throw new Error("recall_aborted");
}

function resultTimestampMs(item: any): number {
  const parsed = Date.parse(String(item?.timestamp || "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function resultScore(item: any): number {
  const score = Number(item?.score);
  return Number.isFinite(score) ? score : 0;
}

function mergeMemoryResults(
  localResults: any[],
  externalResults: any[],
  options: { limit: number; mode: "search" | "recent" },
) {
  const rows = [
    ...(Array.isArray(localResults) ? localResults : []),
    ...(Array.isArray(externalResults) ? externalResults : []),
  ];
  const ordered = rows
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const primary =
        options.mode === "recent"
          ? resultTimestampMs(b.item) - resultTimestampMs(a.item)
          : resultScore(b.item) - resultScore(a.item);
      if (primary) return primary;
      const timestampDiff =
        resultTimestampMs(b.item) - resultTimestampMs(a.item);
      if (timestampDiff) return timestampDiff;
      return a.index - b.index;
    });
  const limit = Math.max(1, Number(options.limit || 8) || 8);
  return {
    results: ordered.slice(0, limit).map((row) => row.item),
    totalResults: rows.length,
  };
}

export async function executeRecall(
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

    emitRecallUpdate(onUpdate, buildRecallSearchStatusText(mode, query), {
      phase: mode,
    });

    throwIfAborted(signal);
    const localResults = query
      ? await searchTranscriptArchive(query, normalizedParams, rootOverride)
      : await loadRecentTranscriptSessions(normalizedParams, rootOverride);
    throwIfAborted(signal);
    const externalResults = await searchExternalMemoryProviders(
      query,
      normalizedParams,
    );
    throwIfAborted(signal);
    const merged = mergeMemoryResults(localResults, externalResults, {
      limit: normalizedParams.limit,
      mode,
    });
    const results = merged.results;

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
      hiddenCount: Math.max(0, merged.totalResults - visibleRows.length),
      totalResults: merged.totalResults,
      userText,
    };

    if (!visibleRows.length) {
      details.emptyMessage = "No recall results found.";
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
        userText: `Recall failed: ${message}`,
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
  const state = (context.state ||= {}) as MemoryRenderState;
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

export function formatRecallCall(args: any, theme: any) {
  const query = String(args?.query || "").trim();
  return formatToolCallLine("recall", query || "recent", theme, {
    detailStyle: query ? "accent" : "muted",
  });
}

export default function memoryModule(
  options: RinCapabilityOptions,
): RinCapabilityDefinition {
  return {
    tools: [
      {
        name: "recall",
        label: "Recall",
        description:
          "Search archived session history by query, or browse recent sessions when query is omitted.",
        promptSnippet:
          "Search archived session history for past-conversation evidence.",
        promptGuidelines: [
          "Use recall when past conversations, unfinished work, original wording, chronology, or cross-session continuity matters.",
        ],
        parameters: recallParams,
        execute: async (_toolCallId, params, signal, onUpdate, ctx) =>
          (await executeRecall(
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
          text.setText(formatRecallCall(args, theme));
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
