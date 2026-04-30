import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import {
  type TruncationResult,
  truncateTail,
} from "@mariozechner/pi-coding-agent";
import {
  ExpandableTextResultComponent,
  getTextOutput,
  NO_OUTPUT_TEXT,
  rebuildExpandableTextResultComponent,
} from "../pi/render-utils.js";
import { requestDaemonCommand } from "../rin-daemon/client.js";
import { readSessionMetadata } from "../session/metadata.js";
import { normalizeChatKey } from "./support.js";
import { safeString } from "../text-utils.js";

const CHAT_BRIDGE_PREVIEW_LINES = 5;
const CHAT_BRIDGE_DOC_PATH = "~/.rin/docs/rin/docs/chat-bridge.md";
const createObjectSchema: any = Type.Object;

function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return path.join(tmpdir(), `pi-chat-bridge-${id}.log`);
}

type ChatBridgeDetails = {
  truncation?: TruncationResult;
  fullOutputPath?: string;
  currentChatKey?: string;
  requestId?: string;
  auditPath?: string;
  durationMs?: number;
};

type ChatBridgeRenderState = {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
};

function previewCode(value: unknown) {
  const lines = safeString(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const preview = lines[0] || "chat_bridge";
  return preview.length > 100 ? `${preview.slice(0, 97)}...` : preview;
}

function formatChatBridgeCall(
  args: { code?: string; timeout?: number } | undefined,
  theme: any,
): string {
  const preview = previewCode(args?.code);
  const timeout = args?.timeout as number | undefined;
  const timeoutSuffix = timeout
    ? theme.fg("muted", ` (timeout ${timeout}s)`)
    : "";
  return theme.fg("toolTitle", theme.bold(`$ ${preview}`)) + timeoutSuffix;
}

const paramsSchema = createObjectSchema({
  code: Type.String({
    description:
      'TypeScript/JavaScript async function body for the live chat bridge runtime. Available globals: `chat`, `bot`, `internal`, `h`, `store`, `identity`, `helpers`. `chat`, `bot`, `internal`, `store`, and `identity` are bound to the current chat when the current session already belongs to a chat; otherwise use `helpers.useChat("platform/bot:chat")` to get a bound scope for a specific chat. The bridge can send rich chat content. `bot` is intentionally thin; prefer `internal` for most platform operations. Read `${CHAT_BRIDGE_DOC_PATH}` for runtime objects and examples.',
  }),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, no default timeout).",
    }),
  ),
});

export default function chatBridgeModule(): RinCapabilityDefinition {
  return {
    name: "chat-bridge",
    tools: [
      {
        name: "chat_bridge",
        label: "chat_bridge",
        description:
          "Run constrained bridge code against a specific live chat.",
        promptSnippet:
          "Run constrained bridge code against a specific live chat.",
        promptGuidelines: [
          "Use chat_bridge for querying chat or user information, sending rich chat content, using platform features for chat management, or building complex interactive chat flows.",
        ],
        parameters: paramsSchema as any,
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
          const code = safeString((params as any)?.code);
          const timeoutSeconds = Number((params as any)?.timeout);
          if (!code.trim()) throw new Error("chat_bridge_code_required");

          const requestId =
            safeString(toolCallId).trim() ||
            `chat_bridge_${Date.now().toString(36)}`;
          const currentChatKey = normalizeChatKey(
            ctx.sessionManager?.getSessionName?.() || "",
          );
          const session = readSessionMetadata(ctx);
          const result = await requestDaemonCommand(
            {
              type: "chat_bridge_eval",
              payload: {
                createdAt: new Date().toISOString(),
                requestId,
                currentChatKey,
                code,
                timeoutMs:
                  Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
                    ? Math.round(timeoutSeconds * 1000)
                    : undefined,
                sessionId: session.sessionId || undefined,
                sessionFile: session.sessionFile || undefined,
              },
            },
            {
              timeoutMs:
                Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
                  ? Math.max(30_000, Math.round(timeoutSeconds * 1000) + 5_000)
                  : 30_000,
            },
          );

          const rawOutput = safeString(result?.text).trim() || "undefined";
          const truncation = truncateTail(rawOutput);
          let fullOutputPath: string | undefined;
          if (truncation.truncated) {
            fullOutputPath = getTempFilePath();
            fs.writeFileSync(fullOutputPath, `${rawOutput}\n`, "utf8");
          }

          return {
            content: [
              { type: "text", text: truncation.content || NO_OUTPUT_TEXT },
            ],
            details: {
              truncation: truncation.truncated ? truncation : undefined,
              fullOutputPath,
              currentChatKey,
              requestId,
              auditPath: safeString(result?.auditPath).trim() || undefined,
              durationMs: Number.isFinite(Number(result?.durationMs))
                ? Math.round(Number(result.durationMs))
                : undefined,
            } satisfies ChatBridgeDetails,
          };
        },
        renderCall(args, theme, context) {
          const state = context.state as ChatBridgeRenderState;
          if (context.executionStarted && state.startedAt === undefined) {
            state.startedAt = Date.now();
            state.endedAt = undefined;
          }
          const text =
            (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
          text.setText(formatChatBridgeCall(args as any, theme));
          return text;
        },
        renderResult(result, options, theme, context) {
          const state = context.state as ChatBridgeRenderState;
          if (
            state.startedAt !== undefined &&
            options.isPartial &&
            !state.interval
          ) {
            state.interval = setInterval(() => context.invalidate(), 1000);
          }
          if (!options.isPartial || context.isError) {
            state.endedAt ??= Date.now();
            if (state.interval) {
              clearInterval(state.interval);
              state.interval = undefined;
            }
          }
          const details = (result as any)?.details as
            | ChatBridgeDetails
            | undefined;
          const outputText = getTextOutput(result as any, context.showImages);
          const component =
            (context.lastComponent as
              | ExpandableTextResultComponent
              | undefined) ?? new ExpandableTextResultComponent();
          rebuildExpandableTextResultComponent(
            component,
            {
              outputText,
              expanded: options.expanded,
              previewLines: CHAT_BRIDGE_PREVIEW_LINES,
              fullOutputPath: details?.fullOutputPath,
              truncation: details?.truncation,
              startedAt: state.startedAt,
              endedAt: state.endedAt,
            },
            theme,
          );
          component.invalidate();
          return component;
        },
      },
    ],
  };
}
