export const DAEMON_RESTART_OR_DISCONNECT_REASON =
  "daemon_restart_or_disconnect";

export const INTERRUPTED_TOOL_TEXT =
  "The tool was interrupted by a daemon restart or disconnect.";

export function createInterruptedToolResultPayload() {
  return {
    content: [
      {
        type: "text",
        text: INTERRUPTED_TOOL_TEXT,
      },
    ],
    details: {
      interrupted: true,
      reason: DAEMON_RESTART_OR_DISCONNECT_REASON,
    },
  };
}

export function createInterruptedToolResultMessage(toolCall: any) {
  const result = createInterruptedToolResultPayload();
  return {
    role: "toolResult",
    toolCallId: String(toolCall?.id || ""),
    toolName: String(toolCall?.name || ""),
    content: result.content,
    details: result.details,
    isError: true,
    timestamp: Date.now(),
  } as any;
}
