import { isJsonRecord } from "../json-utils.js";
import type { BuiltinCommandResult } from "../rin-lib/builtin-command-result.js";
import { safeString } from "../text-utils.js";

function formatSection(title: string, lines: string[], empty: string) {
  return lines.length ? [title, ...lines].join("\n") : empty;
}

export function formatSessionStats(stats: unknown) {
  const value = isJsonRecord(stats) ? stats : {};
  return [
    `Session ID: ${safeString(value.sessionId)}`,
    `Session File: ${safeString(value.sessionFile) || "In-memory"}`,
    `Messages: ${String(value.totalMessages || 0)} (user=${String(value.userMessages || 0)}, assistant=${String(value.assistantMessages || 0)}, toolResults=${String(value.toolResults || 0)})`,
    `Tool Calls: ${String(value.toolCalls || 0)}`,
  ].join("\n");
}

export function presentBuiltinCommandResult(result: unknown) {
  const value = isJsonRecord(result) ? { ...result } : {};
  const command = safeString(value.command).trim();
  const data = isJsonRecord(value.data) ? value.data : {};
  const presented = { ...value, ...data } as Record<string, unknown> &
    Partial<BuiltinCommandResult>;
  switch (command) {
    case "session":
      return { ...presented, text: formatSessionStats(data.stats) };
    case "changelog": {
      const entries = Array.isArray(data.entries)
        ? data.entries.map((entry) => safeString(entry).trim()).filter(Boolean)
        : [];
      return {
        ...presented,
        text: entries.length
          ? entries.join("\n\n")
          : "No changelog entries found.",
      };
    }
    case "resume": {
      const resumedSessionId = safeString(data.resumedSessionId).trim();
      if (resumedSessionId) {
        return {
          ...presented,
          text: `Resumed session: ${resumedSessionId}`,
        };
      }
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      return {
        ...presented,
        text: formatSection(
          "Available sessions:",
          sessions
            .map((session) => {
              if (!isJsonRecord(session)) return "";
              const id = safeString(session.id).trim();
              const name = safeString(session.name).trim() || id;
              return id ? `${id} — ${name}` : "";
            })
            .filter(Boolean),
          "No sessions available.",
        ),
      };
    }
    case "model": {
      const selectedModel = safeString(data.selectedModel).trim();
      if (selectedModel) {
        const thinkingLevel = safeString(data.thinkingLevel).trim();
        return {
          ...presented,
          text: `Model set to: ${selectedModel}${thinkingLevel ? ` (${thinkingLevel})` : ""}`,
        };
      }
      const models = Array.isArray(data.models)
        ? data.models.map((model) => safeString(model).trim()).filter(Boolean)
        : [];
      return {
        ...presented,
        text: formatSection(
          "Available models:",
          models,
          "No models available.",
        ),
      };
    }
    default:
      return presented;
  }
}
