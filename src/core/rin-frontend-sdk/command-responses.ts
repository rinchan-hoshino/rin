import { isJsonRecord } from "../json-utils.js";
import { safeString } from "../text-utils.js";

export type RinFrontendCommandResponses = {
  abort: string;
  new: string;
  newCancelled: string;
  compact: string;
  reload: string;
};

export const DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES: RinFrontendCommandResponses =
  {
    abort: "Aborted current operation.",
    new: "Started a new session.",
    newCancelled: "Session switch cancelled.",
    compact: "Compacted session.",
    reload: "Reloaded extensions, prompts, skills, and themes.",
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
          !useConfiguredText && existingText ? existingText : responses.compact,
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
