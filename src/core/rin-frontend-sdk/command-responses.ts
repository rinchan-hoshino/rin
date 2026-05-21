import { isJsonRecord } from "../json-utils.js";
import { safeString } from "../text-utils.js";
import { formatCompactionSummaryCollapsedText } from "./compaction-summary-format.js";

export type RinFrontendCommandResponses = {
  abort: string;
  new: string;
  newCancelled: string;
  compact: string;
  reload: string;
  selfImproveReviewQueued: string;
  selfImproveReviewSkipped: string;
  selfImproveReviewFailed: string;
  selfImproveReviewNoChange: string;
  selfImproveReviewChanged: string;
  selfImproveReviewChangedWithMore: string;
  selfImproveReviewChangedCount: string;
};

export const DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES: RinFrontendCommandResponses =
  {
    abort: "Aborted current operation.",
    new: "Started a new session.",
    newCancelled: "Session switch cancelled.",
    compact: "Compacted session.",
    reload: "Reloaded extensions, prompts, skills, and themes.",
    selfImproveReviewQueued: "Self-improve review queued.",
    selfImproveReviewSkipped: "Self-improve review skipped.",
    selfImproveReviewFailed: "Self-improve review failed.",
    selfImproveReviewNoChange: "Self-improve review completed with no changes.",
    selfImproveReviewChanged: "Self-improve review updated {targets}.",
    selfImproveReviewChangedWithMore:
      "Self-improve review updated {targets} and {count} more.",
    selfImproveReviewChangedCount: "Self-improve review updated {count} files.",
  };

export function resolveRinFrontendCommandResponses(
  configured?: unknown,
): RinFrontendCommandResponses {
  const source = isJsonRecord(configured) ? configured : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES).map(
      ([key, fallback]) => {
        const value = source[key];
        return [
          key,
          typeof value === "string" && value.trim() ? value : fallback,
        ];
      },
    ),
  ) as RinFrontendCommandResponses;
}

const SELF_IMPROVE_REVIEW_NOTICE_PREFIX = "💡 ";

function replaceTemplateValues(
  template: string,
  values: Record<string, string>,
) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

function prefixSelfImproveReviewNotice(text: string) {
  const trimmed = safeString(text).trim();
  if (!trimmed) return SELF_IMPROVE_REVIEW_NOTICE_PREFIX.trim();
  if (trimmed.startsWith(SELF_IMPROVE_REVIEW_NOTICE_PREFIX.trim())) {
    return trimmed;
  }
  return `${SELF_IMPROVE_REVIEW_NOTICE_PREFIX}${trimmed}`;
}

export function formatSelfImproveReviewNotice(
  input: unknown,
  responses: RinFrontendCommandResponses = resolveRinFrontendCommandResponses(),
) {
  const notice = isJsonRecord(input) ? input : {};
  const status = safeString(notice.status).trim();
  if (status === "queued") {
    return prefixSelfImproveReviewNotice(responses.selfImproveReviewQueued);
  }
  if (status === "failed") {
    return prefixSelfImproveReviewNotice(responses.selfImproveReviewFailed);
  }
  if (status === "skipped") {
    return prefixSelfImproveReviewNotice(responses.selfImproveReviewSkipped);
  }
  const targets = Array.isArray(notice.targets)
    ? notice.targets.map((item) => safeString(item).trim()).filter(Boolean)
    : [];
  const hiddenTargetCount = Math.max(
    0,
    Math.floor(Number(notice.hiddenTargetCount || 0)) || 0,
  );
  const changedCount = Math.max(
    0,
    Math.floor(Number(notice.changedCount || 0)) || 0,
  );
  if (targets.length && hiddenTargetCount > 0) {
    return prefixSelfImproveReviewNotice(
      replaceTemplateValues(responses.selfImproveReviewChangedWithMore, {
        targets: targets.join(", "),
        count: String(hiddenTargetCount),
      }),
    );
  }
  if (targets.length) {
    return prefixSelfImproveReviewNotice(
      replaceTemplateValues(responses.selfImproveReviewChanged, {
        targets: targets.join(", "),
      }),
    );
  }
  if (changedCount > 0) {
    return prefixSelfImproveReviewNotice(
      replaceTemplateValues(responses.selfImproveReviewChangedCount, {
        count: String(changedCount),
      }),
    );
  }
  return prefixSelfImproveReviewNotice(responses.selfImproveReviewNoChange);
}

export function frontendCommandNameFromLine(commandLine: string) {
  const trimmed = safeString(commandLine).trim();
  if (!trimmed.startsWith("/")) return "";
  const commandPart = trimmed.slice(1).trim();
  if (!commandPart) return "";
  return safeString(commandPart.split(/\s+/, 1)[0]).trim();
}

export function parseFrontendCompactCommand(commandLine: string) {
  const trimmed = safeString(commandLine).trim();
  if (trimmed === "/compact") {
    return {
      compact: true,
      customInstructions: undefined as string | undefined,
    };
  }
  if (!trimmed.startsWith("/compact ")) {
    return {
      compact: false,
      customInstructions: undefined as string | undefined,
    };
  }
  return {
    compact: true,
    customInstructions: trimmed.slice("/compact ".length).trim() || undefined,
  };
}

export function isFrontendAbortCommand(commandLine: string) {
  return safeString(commandLine).trim() === "/abort";
}

export function isFrontendNewSessionCommand(commandLine: string) {
  return safeString(commandLine).trim() === "/new";
}

export function applyFrontendBuiltinCommandText(
  commandName: string,
  data: unknown,
  responses: RinFrontendCommandResponses = resolveRinFrontendCommandResponses(),
  options: { preferConfiguredText?: boolean } = {},
) {
  const result = isJsonRecord(data) ? { ...data } : {};
  const existingText = safeString(result.text).trim();
  const useConfiguredText = options.preferConfiguredText === true;
  switch (safeString(commandName).trim()) {
    case "abort":
      return { ...result, text: responses.abort };
    case "new":
      return {
        ...result,
        text: result.cancelled ? responses.newCancelled : responses.new,
      };
    case "compact":
      if (result.compactionBusy) {
        return {
          ...result,
          text: existingText || "Compaction already in progress.",
        };
      }
      return {
        ...result,
        text:
          formatCompactionSummaryCollapsedText(result.tokensBefore) ||
          responses.compact,
      };
    case "reload":
      return {
        ...result,
        text:
          !useConfiguredText && existingText ? existingText : responses.reload,
      };
    default:
      return result;
  }
}
