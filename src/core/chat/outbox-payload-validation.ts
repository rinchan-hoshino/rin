import fs from "node:fs";

import type { ChatMessagePart } from "../rin-lib/chat-outbox-contract.js";
import { safeString } from "../text-utils.js";

export function validateChatOutboxPayloadParts(
  payload: { parts?: ChatMessagePart[] },
  options: { requireLocalFiles?: boolean } = {},
) {
  const parts = Array.isArray(payload.parts)
    ? payload.parts.filter(Boolean)
    : [];
  if (!parts.length) throw new Error("chat_outbox_empty_message");
  let visibleParts = 0;
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      throw new Error("chat_outbox_invalid_part:unknown");
    }
    if (part.type === "text" || part.type === "markdown") {
      if (safeString(part.text).trim()) visibleParts += 1;
      continue;
    }
    if (part.type === "at") {
      if (!safeString(part.id).trim()) {
        throw new Error("chat_outbox_invalid_part:at");
      }
      visibleParts += 1;
      continue;
    }
    if (part.type === "quote") {
      if (!safeString(part.id).trim()) {
        throw new Error("chat_outbox_invalid_part:quote");
      }
      continue;
    }
    if (part.type === "todo") {
      if (
        !(
          Array.isArray(part.items) &&
          part.items.some((item) => safeString(item?.text).trim())
        )
      ) {
        throw new Error("chat_outbox_invalid_part:todo");
      }
      visibleParts += 1;
      continue;
    }
    if (!["image", "file", "video", "audio", "sticker"].includes(part.type)) {
      throw new Error("chat_outbox_invalid_part:unknown");
    }
    const localPath = safeString((part as any).path).trim();
    const remoteUrl = safeString((part as any).url).trim();
    if (!localPath && !remoteUrl) {
      throw new Error(`chat_outbox_invalid_part:${part.type}`);
    }
    if (
      options.requireLocalFiles !== false &&
      localPath &&
      !fs.existsSync(localPath)
    ) {
      throw new Error(`chat_outbox_media_missing:${part.type}`);
    }
    visibleParts += 1;
  }
  if (!visibleParts) throw new Error("chat_outbox_empty_message");
}
