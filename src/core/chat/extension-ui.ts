import type { ChatMessagePart } from "../rin-lib/chat-outbox-contract.js";
import type {
  RinExtensionUiRequest,
  RinExtensionUiResponse,
} from "../rin-frontend-sdk/types.js";

export type ChatExtensionUiProjection = {
  text?: string;
  parts?: ChatMessagePart[];
  response?: RinExtensionUiResponse;
};

export function projectChatExtensionUiRequest(
  request: RinExtensionUiRequest,
): ChatExtensionUiProjection {
  if (request.method === "notify") {
    const text = String(request.message || request.title || "").trim();
    return text ? { text } : {};
  }

  if (request.method === "rinCommandResult") {
    const result = request.result;
    const text = String(result?.text || "").trim();
    const parts = Array.isArray(result?.parts)
      ? (result.parts.filter(Boolean) as ChatMessagePart[])
      : [];
    return {
      ...(text ? { text } : {}),
      ...(parts.length ? { parts } : {}),
    };
  }

  const projection: ChatExtensionUiProjection = {
    text: `Extension UI "${request.method}" is not supported in chat.`,
  };
  if (request.id) {
    projection.response = {
      type: "extension_ui_response",
      id: request.id,
      cancelled: true,
    };
  }
  return projection;
}
