import { readRinI18nCatalog, type RinI18nCatalog } from "../i18n.js";
import {
  DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES,
  type RinFrontendCommandResponses,
} from "../rin-frontend-sdk/command-responses.js";

export type ChatCommandResponses = RinFrontendCommandResponses;

export const DEFAULT_CHAT_COMMAND_RESPONSES = {
  ...DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES,
  compactionSummaryText: "{summary}",
} satisfies RinFrontendCommandResponses;

export function resolveChatCommandResponses(
  configured?: Partial<ChatCommandResponses>,
) {
  const source = configured && typeof configured === "object" ? configured : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_CHAT_COMMAND_RESPONSES).map(([key, fallback]) => {
      const value = source[key as keyof ChatCommandResponses];
      return [
        key,
        typeof value === "string" && value.trim() ? value : fallback,
      ];
    }),
  ) as ChatCommandResponses;
}

const CHAT_COMMAND_RESPONSE_I18N_IDS = {
  abort: "chat.commandResponses.abort",
  new: "chat.commandResponses.new",
  newCancelled: "chat.commandResponses.newCancelled",
  compact: "chat.commandResponses.compact",
  reload: "chat.commandResponses.reload",
  compactionBusy: "chat.compaction.busy",
  compactionSummaryLine: "chat.compaction.summaryLine",
  compactionSummaryText: "chat.compaction.summaryText",
  selfImproveReviewQueued: "chat.selfImproveReview.queued",
  selfImproveReviewSkipped: "chat.selfImproveReview.skipped",
  selfImproveReviewFailed: "chat.selfImproveReview.failed",
  selfImproveReviewNoChange: "chat.selfImproveReview.noChange",
  selfImproveReviewChanged: "chat.selfImproveReview.changed",
  selfImproveReviewChangedWithMore: "chat.selfImproveReview.changedWithMore",
  selfImproveReviewChangedCount: "chat.selfImproveReview.changedCount",
} satisfies Record<keyof RinFrontendCommandResponses, string>;

function chatCommandResponsesFromI18nCatalog(catalog: RinI18nCatalog) {
  return Object.fromEntries(
    Object.entries(CHAT_COMMAND_RESPONSE_I18N_IDS).map(([key, messageId]) => [
      key,
      catalog[messageId],
    ]),
  ) as Partial<RinFrontendCommandResponses>;
}

export function readChatCommandResponses(agentDir: string) {
  const root = String(agentDir || "").trim();
  if (!root) return resolveChatCommandResponses();
  return resolveChatCommandResponses(
    chatCommandResponsesFromI18nCatalog(readRinI18nCatalog(root)),
  );
}
