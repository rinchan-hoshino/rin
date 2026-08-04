import type {
  RinExtensionUiRequest,
  RinExtensionUiResponse,
} from "../rin-frontend-sdk/types.js";

export type ChatExtensionUiProjection = {
  text?: string;
  response?: RinExtensionUiResponse;
};

export function projectChatExtensionUiRequest(
  request: RinExtensionUiRequest,
): ChatExtensionUiProjection {
  if (request.method === "notify") {
    const text = String(request.message || request.title || "").trim();
    return text ? { text } : {};
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
