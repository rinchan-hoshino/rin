import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import {
  extractHtmlTitle,
  htmlToText,
  isProbablyHtml,
  sniffHtmlCharset,
} from "./html-utils.js";
import { writeFetchFullOutput } from "./output-utils.js";
import {
  isTextLike,
  normalizeUrl,
  parseContentType,
} from "./response-utils.js";
import {
  decodeBuffer,
  maybePrettyJson,
  normalizePlainText,
  normalizeRawText,
} from "./text-utils.js";
import {
  buildUserFacingTextResult,
  formatToolCallLine,
  prepareTruncatedAgentUserText,
  renderTextToolResult,
} from "../pi/render-utils.js";

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "Rin fetch/1.0";

const FetchParamsSchema = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
});

type FetchMode = "text";

type FetchDetails = {
  url: string;
  finalUrl: string;
  mode: FetchMode;
  status: number;
  statusText: string;
  ok: boolean;
  mimeType: string;
  charset?: string;
  bytes: number;
  title?: string;
  userText?: string;
  fullOutputPath?: string;
  truncation?: TruncationResult;
};

type FetchResponseData = {
  response: Response;
  buffer: Buffer;
};

function buildResponseText(
  details: FetchDetails,
  bodyText: string,
  leadingLine: string,
) {
  const lines = [
    leadingLine,
    `Status: ${details.status} ${details.statusText}`.trim(),
    `MIME: ${details.mimeType}`,
    `Bytes: ${details.bytes}`,
  ].filter(Boolean);
  if (details.title) lines.push(`Title: ${details.title}`);
  lines.push("", bodyText || "(empty response body)");
  return lines.join("\n");
}

function formatTextResponse(details: FetchDetails, bodyText: string) {
  return buildResponseText(details, bodyText, `Fetched: ${details.finalUrl}`);
}

function formatUserTextResponse(details: FetchDetails, bodyText: string) {
  return buildResponseText(
    details,
    bodyText,
    details.finalUrl !== details.url ? `Final URL: ${details.finalUrl}` : "",
  );
}

function formatFetchResult(
  result: {
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    details?: { truncation?: TruncationResult; fullOutputPath?: string };
  },
  options: { expanded: boolean; isPartial?: boolean },
  theme: any,
  showImages: boolean,
) {
  const fullOutputPath = String(result.details?.fullOutputPath || "").trim();
  return renderTextToolResult(result, options, theme, showImages, {
    partialText: "Fetching...",
    extraMutedLines: fullOutputPath
      ? [`Full output: ${fullOutputPath}`]
      : undefined,
  });
}

async function fetchResponseBuffer(
  url: string,
  signal?: AbortSignal,
): Promise<FetchResponseData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`fetch_timeout:${FETCH_TIMEOUT_MS}`));
  }, FETCH_TIMEOUT_MS);
  const abortFromParent = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.2",
      },
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { response, buffer };
  } catch (error: any) {
    throw new Error(
      `Fetch failed for ${url}: ${String(error?.message || error || "request_failed")}`,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function createFetchDetails(
  url: string,
  mode: FetchMode,
  response: Response,
  buffer: Buffer,
): FetchDetails {
  const { mimeType, charset: headerCharset } = parseContentType(
    response.headers.get("content-type"),
  );
  const charset = sniffHtmlCharset(buffer, mimeType, headerCharset);
  return {
    url,
    finalUrl: response.url || url,
    mode,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    mimeType,
    charset,
    bytes: buffer.byteLength,
  };
}

function resolveResponseBody(details: FetchDetails, buffer: Buffer) {
  const decoded = normalizeRawText(decodeBuffer(buffer, details.charset));
  if (isProbablyHtml(details.mimeType, decoded)) {
    details.title = extractHtmlTitle(decoded) || undefined;
    return htmlToText(decoded);
  }
  if (details.mimeType.includes("json")) {
    return maybePrettyJson(decoded);
  }
  if (isTextLike(details.mimeType)) {
    return normalizePlainText(decoded);
  }
  throw new Error(`Fetch returned non-text content (${details.mimeType}).`);
}

function formatFailedFetch(details: FetchDetails, buffer: Buffer) {
  const body = isTextLike(details.mimeType)
    ? normalizePlainText(decodeBuffer(buffer, details.charset)).slice(0, 600)
    : "";
  return [
    `Fetch failed: HTTP ${details.status} ${details.statusText}`.trim(),
    `URL: ${details.finalUrl}`,
    body ? `Body: ${body}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function buildFetchOutputText(details: FetchDetails, bodyText: string) {
  const agentText = formatTextResponse(details, bodyText);
  const userText = formatUserTextResponse(details, bodyText);
  const truncated = prepareTruncatedAgentUserText(agentText, userText, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  details.userText = truncated.userPreviewText;
  details.truncation = truncated.userTruncation;
  if (truncated.truncation || truncated.userTruncation) {
    details.fullOutputPath = await writeFetchFullOutput(agentText).catch(
      () => undefined,
    );
  }

  return truncated.outputText;
}

export default function fetchModule(): RinCapabilityDefinition {
  return {
    tools: [
      {
        name: "fetch",
        label: "Fetch URL",
        description: "Fetch text content from a specific URL.",
        promptSnippet: "Fetch text content from a specific URL.",
        promptGuidelines: [
          "Use fetch to get the plain-text version of a page.",
        ],
        parameters: FetchParamsSchema,
        async execute(_toolCallId, params, signal, onUpdate) {
          const mode: FetchMode = "text";
          const url = normalizeUrl(params.url);

          onUpdate?.({
            content: [{ type: "text", text: `Fetching ${url}...` }],
            details: { phase: "request", url, mode },
          });

          const { response, buffer } = await fetchResponseBuffer(url, signal);
          const details = createFetchDetails(url, mode, response, buffer);

          if (!response.ok) {
            throw new Error(formatFailedFetch(details, buffer));
          }

          const bodyText = resolveResponseBody(details, buffer);

          return {
            content: [
              {
                type: "text",
                text: await buildFetchOutputText(details, bodyText),
              },
            ],
            details,
          };
        },
        renderCall(args, theme) {
          return new Text(
            formatToolCallLine("fetch", String(args.url || ""), theme),
            0,
            0,
          );
        },
        renderResult(result, options, theme, context) {
          const text =
            (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
          const details =
            (result.details as FetchDetails | undefined) || undefined;
          const userResult = buildUserFacingTextResult(
            result as any,
            context.showImages,
            {
              userText: details?.userText,
              details: {
                truncation: details?.truncation,
                fullOutputPath: details?.fullOutputPath,
              },
            },
          );
          text.setText(
            formatFetchResult(
              userResult as any,
              options as any,
              theme,
              context.showImages,
            ),
          );
          return text;
        },
      },
    ],
  };
}
