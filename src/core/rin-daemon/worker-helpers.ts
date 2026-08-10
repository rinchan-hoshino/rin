import { resolveChatCommandResponses } from "../chat/command-responses.js";
import { asArray } from "../json-utils.js";
import { loadRinChangelogModule } from "../rin-lib/loader.js";
import type { ChatMessagePart } from "../rin-lib/chat-outbox.js";
import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";
import { listBoundSessions } from "../session/factory.js";

export function writeJsonLine(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function getSessionState(
  session: any,
  options: { turnActive?: boolean } = {},
) {
  return {
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    turnActive: Boolean(options.turnActive),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    autoCompactionEnabled: session.autoCompactionEnabled,
    messageCount: session.messages.length,
    pendingMessageCount: session.pendingMessageCount,
  };
}

export {
  getBuiltinSlashCommands,
  getSessionOAuthState as getOAuthState,
  getSessionSlashCommands as getSlashCommands,
} from "./catalog-helpers.js";

function sanitizeResourceDiagnostic(diagnostic: any) {
  if (!diagnostic || typeof diagnostic !== "object") {
    return { type: "warning", message: String(diagnostic || "") };
  }
  const result: any = {
    type: String(diagnostic.type || "warning"),
    message: String(diagnostic.message || ""),
  };
  if (typeof diagnostic.path === "string") result.path = diagnostic.path;
  if (diagnostic.collision && typeof diagnostic.collision === "object") {
    result.collision = {
      name: String(diagnostic.collision.name || ""),
      winnerPath: String(diagnostic.collision.winnerPath || ""),
      loserPath: String(diagnostic.collision.loserPath || ""),
    };
  }
  return result;
}

function sanitizeSourceInfo(sourceInfo: any) {
  if (!sourceInfo || typeof sourceInfo !== "object") return undefined;
  const result: any = {};
  for (const key of [
    "path",
    "source",
    "scope",
    "origin",
    "baseDir",
    "packageName",
    "packageRoot",
    "sourcePath",
  ]) {
    if (typeof sourceInfo[key] === "string") result[key] = sourceInfo[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeSkill(skill: any) {
  return {
    name: String(skill?.name || ""),
    description: String(skill?.description || ""),
    filePath: String(skill?.filePath || ""),
    baseDir: String(skill?.baseDir || ""),
    disableModelInvocation: Boolean(skill?.disableModelInvocation),
    sourceInfo: sanitizeSourceInfo(skill?.sourceInfo),
  };
}

function sanitizePrompt(prompt: any) {
  return {
    name: String(prompt?.name || ""),
    description: String(prompt?.description || ""),
    filePath: String(prompt?.filePath || ""),
    sourceInfo: sanitizeSourceInfo(prompt?.sourceInfo),
  };
}

function sanitizeTheme(theme: any) {
  return {
    name: typeof theme?.name === "string" ? theme.name : undefined,
    sourcePath:
      typeof theme?.sourcePath === "string" ? theme.sourcePath : undefined,
    sourceInfo: sanitizeSourceInfo(theme?.sourceInfo),
  };
}

function sanitizeExtension(extension: any) {
  return {
    path: String(extension?.path || ""),
    sourceInfo: sanitizeSourceInfo(extension?.sourceInfo),
  };
}

function sanitizeExtensionError(error: any) {
  return {
    path: String(error?.path || ""),
    error: String(error?.error || error?.message || ""),
  };
}

function getBuiltInCommandConflictDiagnostics(extensionRunner: any) {
  const builtinNames = new Set(
    BUILTIN_SLASH_COMMANDS.map((command) => command.name),
  );
  const commands = extensionRunner?.getRegisteredCommands?.() || [];
  return commands
    .filter((command: any) => builtinNames.has(String(command?.name || "")))
    .map((command: any) => ({
      type: "warning",
      message:
        command?.invocationName === command?.name
          ? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
          : `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
      path: command?.sourceInfo?.path,
    }));
}

function getExtensionCommandDiagnostics(extensionRunner: any) {
  return (extensionRunner?.getCommandDiagnostics?.() || []).map(
    sanitizeResourceDiagnostic,
  );
}

function getExtensionShortcutDiagnostics(extensionRunner: any) {
  return (extensionRunner?.getShortcutDiagnostics?.() || []).map(
    sanitizeResourceDiagnostic,
  );
}

function getExtensionDiagnostics(extensionRunner: any) {
  return [
    ...getExtensionCommandDiagnostics(extensionRunner),
    ...getBuiltInCommandConflictDiagnostics(extensionRunner).map(
      sanitizeResourceDiagnostic,
    ),
    ...getExtensionShortcutDiagnostics(extensionRunner),
  ];
}

function normalizeCompletionItem(item: any, index: number) {
  if (typeof item === "string") {
    return { id: item, value: item, label: item };
  }
  const result: any = {
    id: String(item?.id || item?.value || item?.label || index),
    value: String(item?.value || item?.label || item?.id || ""),
    label: String(item?.label || item?.value || item?.id || ""),
  };
  if (typeof item?.description === "string") {
    result.description = item.description;
  }
  return result;
}

export async function getCommandArgumentCompletions(
  session: any,
  commandName: string,
  argumentPrefix: string,
) {
  const command = session?.extensionRunner?.getCommand?.(commandName);
  const complete = command?.getArgumentCompletions;
  if (typeof complete !== "function") return { items: [] };
  const result = await complete(String(argumentPrefix || ""));
  return { items: asArray(result).map(normalizeCompletionItem) };
}

export function getResourceDiagnostics(session: any) {
  const resourceLoader = session?.resourceLoader;
  const skills = resourceLoader?.getSkills?.() || {};
  const prompts = resourceLoader?.getPrompts?.() || {};
  const themes = resourceLoader?.getThemes?.() || {};
  const extensions = resourceLoader?.getExtensions?.() || {};
  return {
    skills: {
      skills: (skills.skills || []).map(sanitizeSkill),
      diagnostics: (skills.diagnostics || []).map(sanitizeResourceDiagnostic),
    },
    prompts: {
      prompts: (prompts.prompts || []).map(sanitizePrompt),
      diagnostics: (prompts.diagnostics || []).map(sanitizeResourceDiagnostic),
    },
    themes: {
      themes: (themes.themes || []).map(sanitizeTheme),
      diagnostics: (themes.diagnostics || []).map(sanitizeResourceDiagnostic),
    },
    extensions: {
      extensions: (extensions.extensions || []).map(sanitizeExtension),
      errors: (extensions.errors || []).map(sanitizeExtensionError),
      diagnostics: getExtensionDiagnostics(session?.extensionRunner),
      commandDiagnostics: getExtensionCommandDiagnostics(
        session?.extensionRunner,
      ),
      shortcutDiagnostics: getExtensionShortcutDiagnostics(
        session?.extensionRunner,
      ),
    },
  };
}

export function splitCommandArgs(text: string) {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let tokenStarted = false;
  const pushCurrent = () => {
    if (!tokenStarted) return;
    args.push(current);
    current = "";
    tokenStarted = false;
  };
  for (const char of String(text || "")) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === " " || char === "\t") {
      pushCurrent();
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  pushCurrent();
  return args;
}

type BuiltinCommandResult = {
  handled: boolean;
  text?: string;
  parts?: ChatMessagePart[];
};

type ParsedBuiltinCommand = {
  command: string;
  args: string[];
  argsText: string;
};

function handledText(
  text: string,
  parts?: ChatMessagePart[],
): BuiltinCommandResult {
  return { handled: true, text, ...(parts?.length ? { parts } : {}) };
}

function runtimeServicesAgentDir(runtime: any) {
  return String(runtime?.services?.agentDir || "").trim();
}

function throwCommandError(message: string): never {
  throw new Error(message);
}

function formatLabelValueLine(label: string, value: string) {
  return `${label}: ${value}`;
}

function formatSectionList(title: string, lines: string[], emptyText: string) {
  return lines.length ? [title, ...lines].join("\n") : emptyText;
}

function parseBuiltinCommand(commandLine: string): ParsedBuiltinCommand | null {
  const trimmed = String(commandLine || "").trim();
  if (!trimmed.startsWith("/")) return null;
  const [name = "", ...args] = splitCommandArgs(trimmed.slice(1));
  const command = name.trim();
  if (!command) return null;
  return {
    command,
    args,
    argsText: args.join(" ").trim(),
  };
}

function formatSessionListItem(item: any) {
  const id = String(item?.id || "").trim();
  const label = String(item?.name || item?.id || "").trim() || id;
  return `${id} — ${label}`;
}

function findSessionById(sessions: any[], targetId: string) {
  const nextTargetId = String(targetId || "").trim();
  return sessions.find(
    (item: any) => String(item?.id || "").trim() === nextTargetId,
  );
}

function formatModelRef(model: any) {
  const provider = String(model?.provider || "").trim();
  const id = String(model?.id || "").trim();
  return provider && id ? `${provider}/${id}` : "";
}

function findModelByRef(models: any[], targetRef: string) {
  return models.find((model: any) => formatModelRef(model) === targetRef);
}

function formatModelList(models: any[]) {
  return formatSectionList(
    "Available models:",
    models.slice(0, 50).map(formatModelRef).filter(Boolean),
    "No models available.",
  );
}

export function formatSessionStats(stats: any) {
  return [
    formatLabelValueLine("Session ID", String(stats?.sessionId || "")),
    formatLabelValueLine(
      "Session File",
      String(stats?.sessionFile || "In-memory"),
    ),
    formatLabelValueLine(
      "Messages",
      `${String(stats?.totalMessages || 0)} (user=${String(stats?.userMessages || 0)}, assistant=${String(stats?.assistantMessages || 0)}, toolResults=${String(stats?.toolResults || 0)})`,
    ),
    formatLabelValueLine("Tool Calls", String(stats?.toolCalls || 0)),
  ].join("\n");
}

export async function runBuiltinCommand(
  runtime: any,
  commandLine: string,
  deps: {
    SessionManager?: any;
    uiContext?: any;
    listSessions?: typeof listBoundSessions;
    promptContext?: unknown;
  },
) {
  const session = runtime.session;
  const parsedCommand = parseBuiltinCommand(commandLine);
  if (!parsedCommand) return { handled: false };

  const { command, args, argsText } = parsedCommand;
  const agentDir = runtimeServicesAgentDir(runtime);
  const commandResponses = () =>
    resolveChatCommandResponses(runtime.rinChatPresentation?.commandResponses);
  switch (command) {
    case "abort":
      session.abortCompaction?.();
      await session.abort();
      return handledText(commandResponses().abort);
    case "new":
      session.abortCompaction?.();
      await session.abort();
      await runtime.newSession();
      return handledText(commandResponses().new);
    case "compact":
      await session.compact(argsText || undefined);
      return handledText(commandResponses().compact);
    case "reload":
      if (deps.promptContext !== undefined && session.sessionManager) {
        session.sessionManager.__rinLastPromptContext = deps.promptContext;
      }
      await session.reload();
      return handledText(commandResponses().reload);
    case "session":
      return handledText(formatSessionStats(session.getSessionStats()));
    case "changelog": {
      const { getChangelogPath, parseChangelog }: any =
        await loadRinChangelogModule();
      const changelogPath = getChangelogPath();
      const entries = parseChangelog(changelogPath);
      if (entries.length === 0) {
        return handledText("No changelog entries found.");
      }
      return handledText(
        entries
          .slice()
          .reverse()
          .map((entry: any) => String(entry?.content || "").trim())
          .filter(Boolean)
          .join("\n\n"),
      );
    }
    case "resume": {
      const sessions = await (deps.listSessions || listBoundSessions)({
        cwd: session.sessionManager.getCwd(),
        sessionDir: session.sessionManager.getSessionDir(),
      });
      if (!argsText) {
        return handledText(
          formatSectionList(
            "Available sessions:",
            sessions.slice(0, 20).map(formatSessionListItem),
            "No sessions available.",
          ),
        );
      }
      const match = findSessionById(sessions, argsText);
      if (!match) {
        throwCommandError(`session not found: ${argsText}`);
      }
      await runtime.switchSession(String(match.path || ""));
      return handledText(`Resumed session: ${String(match.id || "").trim()}`);
    }
    case "model": {
      const models = await (
        session.modelRuntime || session.modelRegistry
      ).getAvailable();
      if (!args.length) {
        return handledText(formatModelList(models));
      }
      const [targetRef = "", thinkingLevel = ""] = args;
      const nextTargetRef = String(targetRef || "").trim();
      if (!nextTargetRef.includes("/")) {
        throwCommandError("usage: /model <provider/model> [thinking-level]");
      }
      const match = findModelByRef(models, nextTargetRef);
      if (!match) {
        throwCommandError(`model not found: ${nextTargetRef}`);
      }
      await session.setModel(match);
      if (thinkingLevel) await session.setThinkingLevel(thinkingLevel);
      return handledText(
        `Model set to: ${formatModelRef(match)}${thinkingLevel ? ` (${thinkingLevel})` : ""}`,
      );
    }
    default:
      return { handled: false };
  }
}
