import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";

import { safeString } from "../text-utils.js";
import {
  formatPromptContext,
  formatPromptContextSystemPromptBlock,
  isPromptContextFormatted,
} from "./prompt-context.js";
import {
  RIN_TUI_AGENT_RUNTIME_ROLE,
  RIN_TUI_MAINTENANCE_ROLE,
  RIN_TUI_RPC_FRONTEND_ROLE,
  RIN_TUI_RUNTIME_ROLE_ENV,
  type RinTuiRuntimeRole,
} from "../tui-runtime-env.js";

const SESSION_SYSTEM_PROMPT_BLOCKS_ENTRY_TYPE = "rin-system-prompt-blocks";

function getRuntimeRole(): RinTuiRuntimeRole {
  const role = safeString(process.env[RIN_TUI_RUNTIME_ROLE_ENV]).trim();
  if (role === RIN_TUI_RPC_FRONTEND_ROLE || role === RIN_TUI_MAINTENANCE_ROLE) {
    return role;
  }
  return RIN_TUI_AGENT_RUNTIME_ROLE;
}

function appendSystemPromptBlock(systemPrompt: unknown, block: string) {
  const prompt = safeString(systemPrompt);
  if (!block) return prompt;
  if (prompt.includes(block)) return prompt;
  return `${prompt.trimEnd()}\n\n${block}`.trim();
}

function persistSystemPromptBlock(ctx: any, block: string) {
  if (!block) return;
  try {
    ctx?.sessionManager?.appendCustomEntry?.(
      SESSION_SYSTEM_PROMPT_BLOCKS_ENTRY_TYPE,
      {
        version: 1,
        blocks: [block],
      },
    );
  } catch {}
}

export default function messageHeaderModule(): RinCapabilityDefinition {
  const pendingContexts: Array<{
    source: string;
    body: string;
    sentAt: number;
    promptContext?: any;
  }> = [];
  const runtimeRole = getRuntimeRole();

  return {
    name: "message-header",
    hooks: {
      input: [
        async (event) => {
          if (event.source === "extension") return { action: "continue" };

          if (runtimeRole === RIN_TUI_RPC_FRONTEND_ROLE) {
            return { action: "continue" };
          }

          const source = safeString(event.source).trim();
          const body = safeString(event.text);
          const sentAt = Number(event.promptContext?.sentAt) || Date.now();
          if (
            source === "chat-bridge" &&
            event.streamingBehavior &&
            !isPromptContextFormatted(body)
          ) {
            return {
              action: "transform",
              text: formatPromptContext(
                event.promptContext || null,
                body,
                sentAt,
              ),
              images: event.images,
            };
          }

          pendingContexts.push({
            source,
            body,
            sentAt,
            promptContext: event.promptContext,
          });

          return { action: "continue" };
        },
      ],
      before_agent_start: [
        async (event, ctx) => {
          const current = pendingContexts.shift() || {
            source: "",
            body: safeString(event.prompt),
            sentAt: Date.now(),
            promptContext: event.promptContext,
          };
          const body = safeString(event.prompt || current.body);
          const promptContext = current.promptContext || event.promptContext;
          const systemBlock =
            formatPromptContextSystemPromptBlock(promptContext);
          const result: Record<string, unknown> = {};

          if (systemBlock) {
            const previousSystemPrompt = safeString(event.systemPrompt);
            const nextSystemPrompt = appendSystemPromptBlock(
              previousSystemPrompt,
              systemBlock,
            );
            if (nextSystemPrompt !== previousSystemPrompt) {
              persistSystemPromptBlock(ctx, systemBlock);
            }
            result.systemPrompt = nextSystemPrompt;
          }

          if (
            current.source === "chat-bridge" &&
            isPromptContextFormatted(body)
          ) {
            return result;
          }

          result.message = {
            customType: "message-header-context",
            content: formatPromptContext(
              promptContext || null,
              current.body,
              current.sentAt,
            ),
            display: false,
          };
          return result;
        },
      ],
    },
  };
}
