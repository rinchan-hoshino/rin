import { safeString } from "./core/utils.js";
import {
  SELF_IMPROVE_PROMPT_LIMITS,
  SELF_IMPROVE_PROMPT_SLOTS,
} from "./core/types.js";

export function normalizePromptListContent(text: string) {
  return safeString(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n")
    .trim();
}

export function countPromptLines(text: string) {
  const content = normalizePromptListContent(text);
  if (!content) return 0;
  return content.split(/\r?\n/).filter(Boolean).length;
}

export function assertSelfImprovePromptSlot(slotInput: string) {
  const slot = safeString(slotInput).trim();
  if (!SELF_IMPROVE_PROMPT_SLOTS.includes(slot as any)) {
    throw new Error(
      `self_improve_prompt_slot_required:${SELF_IMPROVE_PROMPT_SLOTS.join(",")}`,
    );
  }
  return slot;
}

export function describeSelfImprovePromptSlot(options: {
  slot: string;
  existingContent?: string;
}) {
  const slot = assertSelfImprovePromptSlot(options.slot);
  const content = normalizePromptListContent(options.existingContent || "");
  const limits = SELF_IMPROVE_PROMPT_LIMITS[slot];
  return {
    slot,
    name: slot.replace(/_/g, " "),
    content,
    currentLines: countPromptLines(content),
    maxLines: limits.maxLines,
  };
}

export function refineSelfImprovePromptSlot(options: {
  slot: string;
  incomingContent?: string;
}) {
  const state = describeSelfImprovePromptSlot({
    slot: options.slot,
  });
  const content = normalizePromptListContent(options.incomingContent || "");
  if (!content) throw new Error("self_improve_content_required");
  const nextLines = countPromptLines(content);
  if (nextLines > state.maxLines) {
    throw new Error(
      `self_improve_prompt_content_too_long:${state.slot}:${state.maxLines}\nCompress existing lines, merge overlapping points, and keep only durable essentials.`,
    );
  }
  return {
    ...state,
    content,
    nextLines,
  };
}
