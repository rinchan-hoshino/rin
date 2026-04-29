import type { BuiltinModuleApi } from "../builtins/host.js";

import { Type } from "typebox";
import { type TruncationResult } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import {
  buildUserFacingTextResult,
  formatHiddenResultsNotice,
  prepareTruncatedText,
  renderTextToolResult,
} from "../pi/render-utils.js";

function trimSnippet(value: string, max = 220): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatAttempts(response: any, options: { maxError?: number } = {}) {
  const attempts = Array.isArray(response?.attempts) ? response.attempts : [];
  if (!attempts.length) return "";
  const maxError = options.maxError ?? 260;
  const lines = attempts.map((attempt: any) => {
    const engine = String(attempt?.engine || "unknown").trim() || "unknown";
    if (attempt?.ok) {
      return `- ${engine}: ok results=${Number(attempt?.results || 0)}`;
    }
    const error = String(attempt?.error || "unknown_error").replace(
      /\s+/g,
      " ",
    );
    return `- ${engine}: ${trimSnippet(error, maxError)}`;
  });
  return ["attempts:", ...lines].join("\n");
}

function formatResults(response: any): string {
  if (!response?.ok) {
    return [
      `Web search failed: ${String(response?.error || "unknown_error")}`,
      formatAttempts(response),
    ]
      .filter(Boolean)
      .join("\n");
  }
  const rows = Array.isArray(response.results) ? response.results : [];
  if (!rows.length) return "No web results found.";
  return rows
    .slice(0, 3)
    .map((item: any) => {
      const title = String(item?.title || "").trim() || "(untitled)";
      const url = String(item?.url || "").trim();
      const snippet = trimSnippet(String(item?.snippet || ""));
      return [title, url, snippet].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function formatAgentResults(response: any): string {
  if (!response?.ok)
    return [
      "web_search error",
      `error=${String(response?.error || "unknown_error")}`,
      formatAttempts(response, { maxError: 520 }),
    ]
      .filter(Boolean)
      .join("\n");
  const rows = Array.isArray(response.results) ? response.results : [];
  if (!rows.length) return "web_search 0";
  return [
    `web_search ${rows.length}`,
    ...rows.map((item: any, index: number) => {
      const title = String(item?.title || "").trim() || "(untitled)";
      const url = String(item?.url || "").trim();
      const snippet = trimSnippet(String(item?.snippet || ""));
      const publishedDate = String(item?.publishedDate || "").trim();
      return [
        `${index + 1}. ${title}${publishedDate ? ` | ${publishedDate}` : ""}`,
        url,
        snippet,
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

function formatWebSearchResult(
  result: {
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    details?: {
      truncation?: TruncationResult;
      emptyMessage?: string;
      hiddenCount?: number;
      totalResults?: number;
    };
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

async function loadSearchWeb() {
  const mod = await import("./service.js");
  return mod.searchWeb as (params: any) => Promise<any>;
}

function formatWebSearchCall(args: any, theme: any) {
  return `${theme.fg("toolTitle", theme.bold("web_search"))} ${theme.fg("accent", String(args?.q || "").trim())}`;
}

export default function webSearchModule(pi: BuiltinModuleApi) {
  (pi as any).registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web.",
    promptSnippet: "Search the web.",
    promptGuidelines: [
      "Use web_search proactively whenever web information may be relevant; better to search and confirm than to guess.",
    ],
    parameters: Type.Object({
      q: Type.String({
        description:
          "Focused web search query. Prefer a few distinctive keywords instead of full sentences; use quotes for exact phrases, site:example.com for domain scoping, -term to exclude terms, and OR for alternatives. For different topics, split them into separate web_search calls instead of one overloaded query.",
      }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 8 })),
      freshness: Type.Optional(
        Type.Union(
          [
            Type.Literal("day"),
            Type.Literal("week"),
            Type.Literal("month"),
            Type.Literal("year"),
          ],
          {
            description:
              "Optional recency filter. Allowed values: `day`, `week`, `month`, or `year`.",
          },
        ),
      ),
      language: Type.Optional(
        Type.String({
          description: "Optional language hint such as `zh-CN` or `en`.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const searchWeb = await loadSearchWeb();
      const normalizedParams = {
        ...(params as any),
        limit: Number.isFinite(Number((params as any)?.limit))
          ? Number((params as any).limit)
          : 8,
      };
      const response = await searchWeb(normalizedParams).catch(
        (error: any) => ({
          ok: false,
          results: [],
          error: String(error?.message || error || "web_search_failed"),
        }),
      );

      const agentText = formatAgentResults(response);
      const userText = formatResults(response);
      const truncated = prepareTruncatedText(agentText);
      const rows = Array.isArray(response?.results) ? response.results : [];
      const hiddenCount = rows.length > 3 ? rows.length - 3 : 0;
      const details: {
        truncation?: TruncationResult;
        emptyMessage?: string;
        hiddenCount?: number;
        totalResults?: number;
        userText?: string;
        attempts?: unknown[];
      } = {
        hiddenCount,
        totalResults: rows.length,
        userText,
      };

      if (Array.isArray(response?.attempts)) {
        details.attempts = response.attempts;
      }

      if (!rows.length && response?.ok) {
        details.emptyMessage = "No web results found.";
      }

      if (truncated.truncation) {
        details.truncation = truncated.truncation;
      }

      return {
        content: [{ type: "text", text: truncated.outputText }],
        details,
        isError: response?.ok !== true,
      };
    },
    renderCall(args, theme) {
      return new Text(formatWebSearchCall(args, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = (result.details as any) || {};
      const userResult = buildUserFacingTextResult(result, context.showImages, {
        userText: details.userText,
        details: {
          truncation: details.truncation,
          emptyMessage: details.emptyMessage,
          hiddenCount: details.hiddenCount,
          totalResults: details.totalResults,
        },
      });
      text.setText(
        formatWebSearchResult(userResult, options, theme, context.showImages),
      );
      return text;
    },
  });
}
