import type { ChatMessagePart } from "../rin-lib/chat-outbox.js";
import { safeString } from "../text-utils.js";

function assistantResultParts(result: any): ChatMessagePart[] {
  if (!Array.isArray(result?.messages)) return [];
  return result.messages.flatMap((message: any): ChatMessagePart[] => {
    if (message?.type === "text") {
      const text = safeString(message.text).trim();
      return text ? [{ type: "text", text }] : [];
    }
    if (message?.type === "image") {
      const data = safeString(message.data).trim();
      const path = safeString(message.path).trim();
      const url = safeString(message.url).trim();
      const mimeType = safeString(message.mimeType).trim() || undefined;
      if (path) return [{ type: "image", path, mimeType }];
      if (url) return [{ type: "image", url, mimeType }];
      if (data) {
        return [
          {
            type: "image",
            url: `data:${mimeType || "image/png"};base64,${data}`,
            mimeType,
          },
        ];
      }
      return [];
    }
    if (message?.type === "file") {
      const path = safeString(message.path).trim();
      const url = safeString(message.url).trim();
      if (!path && !url) return [];
      return [
        {
          type: "file",
          ...(path ? { path } : {}),
          ...(url ? { url } : {}),
          name: safeString(message.name).trim() || undefined,
          mimeType: safeString(message.mimeType).trim() || undefined,
        },
      ];
    }
    return [];
  });
}

export function assistantDeliveryParts(
  finalText: unknown,
  result: unknown,
): ChatMessagePart[] {
  const text = safeString(finalText).trim();
  const resultParts = assistantResultParts(result);
  if (!text) return resultParts;
  if (!resultParts.length) return [{ type: "text", text }];
  let replacedText = false;
  const canonicalParts = resultParts.map((part) => {
    if (part.type !== "text" || replacedText) return part;
    replacedText = true;
    return { type: "text" as const, text };
  });
  return replacedText
    ? canonicalParts
    : [{ type: "text" as const, text }, ...canonicalParts];
}
