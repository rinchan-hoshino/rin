import crypto from "node:crypto";

import type { ChatMessagePart } from "../rin-lib/chat-outbox.js";
import { safeString } from "../text-utils.js";
import {
  formatRuntimeErrorForFrontend,
  formatRuntimeErrorForFrontendDisplay,
} from "../presentation/error.js";

export function formatChatErrorParts(parts: ChatMessagePart[]) {
  const quoteParts: ChatMessagePart[] = [];
  const contentParts: ChatMessagePart[] = [];
  let primaryTextPart: ChatMessagePart | null = null;

  for (const part of parts) {
    if (part.type === "quote") {
      quoteParts.push(part);
      continue;
    }
    if (part.type === "text" || part.type === "markdown") {
      if (!safeString(part.text).trim()) continue;
      if (!primaryTextPart) {
        primaryTextPart = {
          ...part,
          text: formatRuntimeErrorForFrontend(part.text),
        };
      } else {
        contentParts.push({
          ...part,
          text: formatRuntimeErrorForFrontendDisplay(part.text),
        });
      }
      continue;
    }
    contentParts.push(part);
  }

  if (primaryTextPart) {
    return [...quoteParts, primaryTextPart, ...contentParts];
  }
  if (!contentParts.length) return quoteParts;
  return [
    ...quoteParts,
    {
      type: "text" as const,
      text: formatRuntimeErrorForFrontend(""),
    },
    ...contentParts,
  ];
}

export function hashChatErrorDeliveryContent(
  text: unknown,
  parts: ChatMessagePart[] = [],
) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        text: formatRuntimeErrorForFrontend(text),
        parts,
      }),
    )
    .digest("hex");
}

export function formatChatErrorDelivery(input: {
  text?: unknown;
  parts?: ChatMessagePart[];
}) {
  const text = safeString(input.text).trim();
  const parts = Array.isArray(input.parts) ? input.parts.filter(Boolean) : [];
  return {
    parts: formatChatErrorParts(
      parts.length ? parts : [{ type: "text" as const, text }],
    ),
  };
}
