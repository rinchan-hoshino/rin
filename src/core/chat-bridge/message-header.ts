import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";

import { safeString } from "../text-utils.js";
import {
  RIN_TUI_AGENT_RUNTIME_ROLE,
  RIN_TUI_MAINTENANCE_ROLE,
  RIN_TUI_RPC_FRONTEND_ROLE,
  RIN_TUI_RUNTIME_ROLE_ENV,
  type RinTuiRuntimeRole,
} from "../tui-runtime-env.js";
import {
  formatPromptContext,
  isPromptContextFormatted,
} from "./prompt-context.js";

function getRuntimeRole(): RinTuiRuntimeRole {
  const role = safeString(process.env[RIN_TUI_RUNTIME_ROLE_ENV]).trim();
  if (role === RIN_TUI_RPC_FRONTEND_ROLE || role === RIN_TUI_MAINTENANCE_ROLE) {
    return role;
  }
  return RIN_TUI_AGENT_RUNTIME_ROLE;
}

export default function messageHeaderModule(): RinCapabilityDefinition {
  const pendingContexts: Array<{
    source: string;
    body: string;
    sentAt: number;
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

          pendingContexts.push({
            source: safeString(event.source).trim(),
            body: safeString(event.text),
            sentAt: Date.now(),
          });

          return { action: "continue" };
        },
      ],
      before_agent_start: [
        async (event) => {
          const current = pendingContexts.shift() || {
            source: "",
            body: safeString(event.prompt),
            sentAt: Date.now(),
          };
          const body = safeString(event.prompt || current.body);

          if (
            current.source === "chat-bridge" &&
            isPromptContextFormatted(body)
          ) {
            return {};
          }

          return {
            message: {
              customType: "message-header-context",
              content: formatPromptContext(null, current.body, current.sentAt),
              display: false,
            },
          };
        },
      ],
    },
  };
}
