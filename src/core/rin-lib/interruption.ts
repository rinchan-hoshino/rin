export const DAEMON_EXIT_REASON = "daemon_exit";

export const INTERRUPTED_TOOL_TEXT =
  "The tool was interrupted because the daemon exited.";

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
      reason: DAEMON_EXIT_REASON,
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
