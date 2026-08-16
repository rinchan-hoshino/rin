import { safeString } from "../text-utils.js";
import { stripMarkdownFormatting } from "./rich-text.js";

export type ChatDeliveryOutcome = {
  messageIds: string[];
  accepted: boolean;
  settled: boolean;
};

export function chatDeliveryOutcome(
  messageIds: string[] = [],
  options: { accepted?: boolean; settled?: boolean } = {},
): ChatDeliveryOutcome {
  return {
    messageIds,
    accepted: options.accepted !== false,
    settled: options.settled !== false,
  };
}

export function shouldSuppressQuietDelivery(
  quietModeEnabled: boolean,
  deliveryKind: string,
) {
  return (
    quietModeEnabled && deliveryKind !== "final" && deliveryKind !== "error"
  );
}

export function shouldDeferPassiveNotice(input: {
  hasActiveTurn: boolean;
  awaitingTurnSettle: boolean;
  hasStagedDelivery: boolean;
}) {
  return (
    input.hasActiveTurn || input.awaitingTurnSettle || input.hasStagedDelivery
  );
}

export function normalizeAssistantSummaryText(value: unknown) {
  const latestSummary = safeString(value)
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  return stripMarkdownFormatting(latestSummary).replace(/\s+/g, " ").trim();
}

export function presentInterimText(
  value: unknown,
  hasEditableWorking: boolean,
) {
  const text = safeString(value).trim();
  return hasEditableWorking ? text : `... ${text}`;
}
