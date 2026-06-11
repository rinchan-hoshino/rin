import type {
  ExtensionAPI,
  TruncationResult,
} from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";

import { fetchReadableUrl, parseFetchUrl } from "./url-fetch.ts";
import {
  getBrowseStatus,
  prepareSearxngRuntime,
  searchWeb,
  startSearxngSidecar,
  stopSearxngSidecar,
} from "./service.ts";

function trimSnippet(value: string, max = 220): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function runtimeErrorText(error: unknown, fallback = "browse_failed"): string {
  const text = String(error || "").trim();
  if (!text) return fallback;
  return text.replace(/_/g, " ");
}

function searchFailureMessages(response: any): string[] {
  return [
    String(response?.error || "").trim(),
    ...(Array.isArray(response?.attempts)
      ? response.attempts.map((attempt: any) => String(attempt?.error || ""))
      : []),
  ].filter(Boolean);
}

function extractInvalidSearchParameter(response: any) {
  const text = searchFailureMessages(response).join("\n");
  const match =
    /Invalid value\s+(.+?)\s+for parameter\s+([A-Za-z0-9_.-]+)/i.exec(text);
  if (!match) return null;
  return {
    value: match[1].trim(),
    parameter: match[2].trim(),
  };
}

function formatSearchFailureForUser(response: any): string {
  const invalidParameter = extractInvalidSearchParameter(response);
  if (invalidParameter) {
    return `Browse failed: invalid search parameter ${invalidParameter.parameter}=${invalidParameter.value}. Change or omit that parameter and retry.`;
  }
  return runtimeErrorText(response?.error || "browse_failed");
}

function formatSearchFailureForAgent(response: any): string {
  const lines = ["Browse failed"];
  const userText = formatSearchFailureForUser(response);
  if (userText) lines.push(userText);
  const rawError = String(response?.error || "").trim();
  if (rawError) lines.push(`raw_error: ${rawError}`);
  const attempts = Array.isArray(response?.attempts) ? response.attempts : [];
  if (attempts.length) {
    lines.push("attempts:");
    for (const attempt of attempts) {
      const engine = String(attempt?.engine || "unknown").trim() || "unknown";
      if (attempt?.ok) {
        lines.push(`- ${engine}: ok results=${Number(attempt?.results || 0)}`);
      } else {
        lines.push(`- ${engine}: ${String(attempt?.error || "failed").trim()}`);
      }
    }
  }
  return lines.join("\n");
}

function formatResults(response: any): string {
  if (!response?.ok) return formatSearchFailureForUser(response);
  const rows = Array.isArray(response.results) ? response.results : [];
  if (!rows.length) return "No browse results found.";
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
  if (!response?.ok) return formatSearchFailureForAgent(response);
  const rows = Array.isArray(response.results) ? response.results : [];
  if (!rows.length) return "browse 0";
  return [
    `browse ${rows.length}`,
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

function truncateForAgent(
  text: string,
  max = 12000,
): {
  outputText: string;
  truncation?: TruncationResult;
} {
  if (text.length <= max) return { outputText: text };
  return {
    outputText: `${text.slice(0, max).trimEnd()}\n…`,
    truncation: {
      originalLength: text.length,
      retainedLength: max,
      omittedLength: text.length - max,
    } as TruncationResult,
  };
}

function formatFetchAgentResult(
  response: Awaited<ReturnType<typeof fetchReadableUrl>>,
) {
  const lines = [
    response.ok ? "Browse fetch ok" : "Browse fetch failed",
    `url=${response.finalUrl || response.url}`,
    response.status
      ? `status=${response.status} ${response.statusText}`.trim()
      : "",
    response.mimeType ? `mime=${response.mimeType}` : "",
    `bytes=${response.bytes}`,
    response.title ? `title=${response.title}` : "",
    "",
    response.ok
      ? response.text || ""
      : runtimeErrorText(response.error || "fetch_failed", "fetch failed"),
  ].filter((line) => line !== "");
  return lines.join("\n");
}

function formatFetchUserResult(
  response: Awaited<ReturnType<typeof fetchReadableUrl>>,
) {
  const lines = [
    `Fetched: ${response.finalUrl || response.url}`,
    response.status
      ? `Status: ${response.status} ${response.statusText}`.trim()
      : "",
    response.mimeType ? `MIME: ${response.mimeType}` : "",
    `Bytes: ${response.bytes}`,
    response.title ? `Title: ${response.title}` : "",
    "",
    response.ok
      ? response.text || ""
      : runtimeErrorText(response.error || "fetch_failed", "fetch failed"),
  ].filter((line) => line !== "");
  return lines.join("\n");
}

export const builtInExtensionLifecycle = {
  async status(context: { agentDir?: string } = {}) {
    const agentDir = String(
      context.agentDir || process.env.RIN_DIR || "",
    ).trim();
    if (!agentDir)
      return {
        status: "unknown",
        detail: "Rin agent directory is not available.",
      };
    const status = getBrowseStatus(agentDir);
    const running = status.instances.filter((instance: any) => instance.alive);
    return {
      status: running.length
        ? "running"
        : status.runtime.ready
          ? "installed"
          : "not_installed",
      detail: running.length
        ? `SearXNG running at ${running[0].baseUrl}`
        : status.runtime.ready
          ? "SearXNG runtime is installed."
          : "SearXNG runtime is not installed.",
      data: status,
    };
  },
  async install(
    context: {
      agentDir?: string;
      logger?: { info?: (message: string) => void };
    } = {},
  ) {
    const agentDir = String(
      context.agentDir || process.env.RIN_DIR || "",
    ).trim();
    if (!agentDir) throw new Error("browse_agent_dir_required");
    return await prepareSearxngRuntime(agentDir, { logger: context.logger });
  },
  async start(
    context: {
      agentDir?: string;
      logger?: { info?: (message: string) => void };
    } = {},
  ) {
    const agentDir = String(
      context.agentDir || process.env.RIN_DIR || "",
    ).trim();
    if (!agentDir) throw new Error("browse_agent_dir_required");
    await prepareSearxngRuntime(agentDir, { logger: context.logger });
    return await startSearxngSidecar(agentDir, { logger: context.logger });
  },
  async stop(
    context: {
      agentDir?: string;
      logger?: { info?: (message: string) => void };
    } = {},
  ) {
    const agentDir = String(
      context.agentDir || process.env.RIN_DIR || "",
    ).trim();
    if (!agentDir) throw new Error("browse_agent_dir_required");
    const status = getBrowseStatus(agentDir);
    const stopped = [];
    for (const instance of status.instances) {
      if (!instance.alive) continue;
      stopped.push(
        await stopSearxngSidecar(agentDir, {
          instanceId: instance.instanceId,
          logger: context.logger,
        }),
      );
    }
    return { ok: true, stopped };
  },
};

export default function browseExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browse",
    label: "Browse",
    description:
      "Browse the web, or fetch readable content from an HTTP(S) URL.",
    promptSnippet:
      "Browse the web or fetch readable content from a specific HTTP(S) page.",
    promptGuidelines: [
      "Use browse when current, external, source-dependent, or version-sensitive web information matters.",
      "Use browse URL mode when a specific HTTP(S) page is the evidence source.",
    ],
    parameters: Type.Object({
      q: Type.String({
        description:
          "Browse query or HTTP(S) URL. For search, use distinctive keywords; use quotes for exact phrases, site:example.com for domain scope, -term to exclude, and OR for alternatives. Split unrelated topics into separate calls.",
      }),
      format: Type.Optional(
        Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
          description:
            "Optional fetch output format when q is an HTTP(S) URL. Allowed values: `markdown` or `text`.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 8,
          description: "Number of search results to return. Range: 1-8.",
        }),
      ),
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
          description: "Optional language hint such as `zh_CN` or `en_US`.",
        }),
      ),
    }),
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const url = parseFetchUrl(params?.q);
      if (url) {
        const response = await fetchReadableUrl({
          url,
          format: params?.format,
          signal,
        });
        const agentText = formatFetchAgentResult(response);
        const userText = formatFetchUserResult(response);
        const truncated = truncateForAgent(agentText);
        return {
          content: [{ type: "text", text: truncated.outputText }],
          details: {
            mode: "fetch",
            userText,
            fetch: response,
            truncation: truncated.truncation,
          },
          isError: response.ok !== true,
        };
      }

      const normalizedParams = {
        ...params,
        limit: Number.isFinite(Number(params?.limit))
          ? Number(params.limit)
          : 8,
      };
      const response = await searchWeb(normalizedParams, {
        stateRoot: ctx?.agentDir,
      }).catch((error: any) => ({
        ok: false,
        results: [],
        error: String(error?.message || error || "browse_failed"),
      }));

      const agentText = formatAgentResults(response);
      const userText = formatResults(response);
      const truncated = truncateForAgent(agentText);
      const rows = Array.isArray(response?.results) ? response.results : [];
      return {
        content: [{ type: "text", text: truncated.outputText }],
        details: {
          mode: "search",
          userText,
          hiddenCount: rows.length > 3 ? rows.length - 3 : 0,
          totalResults: rows.length,
          emptyMessage:
            !rows.length && response?.ok
              ? "No browse results found."
              : undefined,
          error:
            response?.ok === true
              ? undefined
              : String(response?.error || "browse_failed"),
          attempts: Array.isArray(response?.attempts)
            ? response.attempts
            : undefined,
          truncation: truncated.truncation,
        },
        isError: response?.ok !== true,
      };
    },
  });
}
