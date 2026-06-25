import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent";
import { extractMessageText } from "../message-content.js";
import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import {
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/profile.js";
import { createConfiguredAgentSession } from "../rin-lib/runtime.js";
import type { RinPiPassthroughOptions } from "../rin-lib/pi-passthrough.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";
import {
  getManagedSessionDir,
  MANAGED_CLI_SESSION_LEAF,
} from "../session/managed-paths.js";
import { readSessionMetadata } from "../session/metadata.js";
import {
  requireExistingSessionFile,
  resolveStoredSessionFile,
} from "../session/ref.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import { stripRinWrapperArgs, type ParsedArgs, safeString } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const VALID_MODES = new Set(["text", "json"]);

export type RunCliOptions = RinToolStartupOptions &
  Pick<RinPiPassthroughOptions, "piStartupOptions"> & {
    messages: string[];
    prompt: string;
    sessionFile?: string;
    managedSessionLeaf?: string;
    sessionName?: string;
    provider?: string;
    model?: string;
    thinkingLevel?: string;
    chatKey?: string;
    outputMode: "text" | "json";
    timeoutMs: number;
    help?: boolean;
  };

function printRunHelp() {
  console.log(`rin - AI coding assistant with read, bash, edit, write tools

Usage:
  rin [options] [@files...] [messages...]

Options:
  --mode <mode>                  Output mode: text (default) or json
  --print, -p                    Non-interactive mode: process prompt and exit
  --provider <name>              Provider name
  --model <provider/model>       Model pattern or ID (supports provider/model)
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh
  --session <file>               Use a specific session file
  --managed-session <leaf>       Create and keep a session under sessions/managed/<leaf>/
  --name <name>                  Set the session display name
  --tools, -t <tools>            Comma-separated allowlist of tool names
  --exclude-tools, -xt <tools>   Comma-separated denylist of tool names
  --no-tools, -nt                Disable all tools by default
  --no-builtin-tools, -nbt       Disable built-in tools by default
  --timeout <seconds>            Maximum wait time (default: 1800)
  --help, -h                     Show this help

Examples:
  rin -p "Summarize this repository"
  cat README.md | rin -p "Summarize this text"
  rin --mode json "List all .ts files in src/"
  rin --mode json --managed-session subagent -p "Scout the auth module"
  rin --name "release audit" -p "Audit this repository"
  rin --model openai/gpt-5.5 --thinking low -p "Draft release notes"
`);
}

function readValue(args: string[], index: number) {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("-")) return undefined;
  return next;
}

function normalizeModelSegment(value: unknown) {
  const text = safeString(value).trim().replace(/^@/, "");
  return text && !/\s/.test(text) ? text : undefined;
}

function splitModelRef(
  value: string | undefined,
): { provider: string; modelId: string } | undefined {
  const text = normalizeModelSegment(value);
  if (!text) return undefined;
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return undefined;
  const provider = normalizeModelSegment(text.slice(0, slash));
  const modelId = normalizeModelSegment(text.slice(slash + 1));
  return provider && modelId ? { provider, modelId } : undefined;
}

function resolveProviderModel(
  provider: string | undefined,
  model: string | undefined,
) {
  const direct = splitModelRef(model);
  if (direct) return direct;
  const providerName = normalizeModelSegment(provider);
  const modelId = normalizeModelSegment(model);
  if (!providerName || !modelId) return undefined;
  return { provider: providerName, modelId };
}

function parseTimeoutMs(value: string | undefined) {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid_timeout:${value}`);
  }
  return Math.max(1, Math.round(seconds * 1000));
}

async function readStdinIfAvailable() {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function appendInlineValue(
  args: string[],
  index: number,
  target: (value: string) => void,
  error: string,
) {
  const value = readValue(args, index);
  if (value === undefined) throw new Error(error);
  target(value);
  return index + 1;
}

async function readFileArg(pathText: string) {
  const filePath = safeString(pathText).trim();
  if (!filePath) return "";
  return await fs.readFile(filePath, "utf8");
}

function normalizePiArgvCompatibility(args: string[]) {
  const splitEquals = new Set([
    "--mode",
    "--provider",
    "--model",
    "--thinking",
    "--session",
    "--name",
    "--tools",
    "--exclude-tools",
  ]);
  return args.flatMap((arg) => {
    const text = safeString(arg).trim();
    const eqIndex = text.indexOf("=");
    if (eqIndex <= 0) return [arg];
    const name = text.slice(0, eqIndex);
    if (!splitEquals.has(name)) return [arg];
    return [name, text.slice(eqIndex + 1)];
  });
}

function stripRinOnlyArgsForPi(args: string[]) {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = safeString(args[index]).trim();
    if (arg === "--bind-chat-session") {
      throw new Error("unknown_run_option:--bind-chat-session");
    }
    if (
      arg === "--chat-key" ||
      arg === "--chatKey" ||
      arg === "--timeout" ||
      arg === "--managed-session" ||
      arg === "--managed-session-leaf"
    ) {
      index += 1;
      continue;
    }
    if (
      arg.startsWith("--chat-key=") ||
      arg.startsWith("--chatKey=") ||
      arg.startsWith("--timeout=") ||
      arg.startsWith("--managed-session=") ||
      arg.startsWith("--managed-session-leaf=")
    ) {
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function serializePiStartupArgs(parsed: any) {
  const { diagnostics: _diagnostics, unknownFlags, ...rest } = parsed;
  return {
    ...rest,
    unknownFlags:
      unknownFlags instanceof Map ? Object.fromEntries(unknownFlags) : {},
  };
}

export function shouldRunNonInteractive(
  rawArgv: string[],
  stdinIsTTY = process.stdin.isTTY,
) {
  const args = stripRinWrapperArgs(rawArgv);
  for (let index = 0; index < args.length; index += 1) {
    const arg = safeString(args[index]).trim();
    if (arg === "--") break;
    if (arg === "--print" || arg === "-p") return true;
    if (arg === "--mode" && safeString(args[index + 1]).trim() === "json") {
      return true;
    }
    if (arg === "--mode=json") return true;
  }
  return !stdinIsTTY;
}

function hasChatDeliveryArg(rawArgv: string[]) {
  const args = stripRinWrapperArgs(rawArgv);
  return args.some((value) => {
    const arg = safeString(value).trim();
    return (
      arg === "--chat-key" ||
      arg === "--chatKey" ||
      arg.startsWith("--chat-key=") ||
      arg.startsWith("--chatKey=")
    );
  });
}

export async function parseRunArgs(
  rawArgv: string[],
  stdinContentOverride?: string,
): Promise<RunCliOptions> {
  const args = stripRinWrapperArgs(rawArgv);
  const piArgs = normalizePiArgvCompatibility(stripRinOnlyArgsForPi(args));
  const piParsed = parsePiArgs(piArgs);
  const errorDiagnostic = piParsed.diagnostics.find(
    (diagnostic) => diagnostic.type === "error",
  );
  if (errorDiagnostic) throw new Error(errorDiagnostic.message);

  let managedSessionLeaf = "";
  let chatKey = "";
  let timeoutValue = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = safeString(args[index]).trim();
    if (!arg) continue;
    if (arg === "--bind-chat-session") {
      throw new Error("unknown_run_option:--bind-chat-session");
    }
    if (arg === "--managed-session" || arg === "--managed-session-leaf") {
      index = appendInlineValue(
        args,
        index,
        (value) => (managedSessionLeaf = value),
        "run_managed_session_value_required",
      );
      continue;
    }
    if (arg.startsWith("--managed-session=")) {
      managedSessionLeaf = arg.slice("--managed-session=".length);
      continue;
    }
    if (arg.startsWith("--managed-session-leaf=")) {
      managedSessionLeaf = arg.slice("--managed-session-leaf=".length);
      continue;
    }
    if (arg === "--chat-key" || arg === "--chatKey") {
      index = appendInlineValue(
        args,
        index,
        (value) => (chatKey = value),
        "run_chat_key_value_required",
      );
      continue;
    }
    if (arg.startsWith("--chat-key=")) {
      chatKey = arg.slice("--chat-key=".length);
      continue;
    }
    if (arg.startsWith("--chatKey=")) {
      chatKey = arg.slice("--chatKey=".length);
      continue;
    }
    if (arg === "--timeout") {
      index = appendInlineValue(
        args,
        index,
        (value) => (timeoutValue = value),
        "run_timeout_value_required",
      );
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      timeoutValue = arg.slice("--timeout=".length);
    }
  }

  const mode = piParsed.mode ?? "text";
  if (!VALID_MODES.has(mode)) throw new Error(`invalid_mode:${mode}`);

  const parts: string[] = [];
  const stdinContent =
    stdinContentOverride !== undefined
      ? stdinContentOverride
      : await readStdinIfAvailable();
  if (stdinContent) parts.push(stdinContent);
  for (const fileArg of piParsed.fileArgs) {
    const text = await readFileArg(fileArg);
    if (text) parts.push(text);
  }
  if (piParsed.messages.length) parts.push(piParsed.messages[0]);
  const prompt = parts.join("");
  const additionalMessages =
    piParsed.messages.length > 1 ? piParsed.messages.slice(1) : [];
  const providerModel = resolveProviderModel(piParsed.provider, piParsed.model);
  if (piParsed.model && !providerModel) {
    throw new Error(`invalid_model:${piParsed.model}`);
  }
  const normalizedSessionFile = safeString(
    piParsed.noSession ? "" : piParsed.session,
  ).trim();
  const normalizedManagedSessionLeaf = safeString(managedSessionLeaf).trim();
  if (normalizedSessionFile && normalizedManagedSessionLeaf) {
    throw new Error("run_session_conflict");
  }

  const noTools = piParsed.noTools
    ? "all"
    : piParsed.noBuiltinTools
      ? "builtin"
      : undefined;

  return {
    messages: additionalMessages,
    prompt,
    sessionFile: normalizedSessionFile || undefined,
    managedSessionLeaf: normalizedManagedSessionLeaf || undefined,
    sessionName: safeString(piParsed.name).trim() || undefined,
    provider: safeString(piParsed.provider).trim() || undefined,
    model: providerModel
      ? `${providerModel.provider}/${providerModel.modelId}`
      : undefined,
    thinkingLevel: piParsed.thinking,
    ...(piParsed.tools !== undefined ? { tools: piParsed.tools } : {}),
    ...(piParsed.excludeTools !== undefined
      ? { excludeTools: piParsed.excludeTools }
      : {}),
    ...(noTools !== undefined ? { noTools } : {}),
    chatKey: safeString(chatKey).trim() || undefined,
    piStartupOptions: serializePiStartupArgs(piParsed),
    outputMode: mode as "text" | "json",
    timeoutMs: parseTimeoutMs(timeoutValue),
    help: Boolean(piParsed.help),
  };
}

function isSafeTransientSessionFile(agentDir: string, sessionFile?: string) {
  const resolved = safeString(sessionFile).trim();
  if (!resolved) return false;
  const sessionsDir = path.resolve(agentDir, "sessions");
  const absolute = path.resolve(resolved);
  return (
    absolute.startsWith(`${sessionsDir}${path.sep}`) &&
    path.basename(absolute).endsWith(".jsonl")
  );
}

async function removeTransientSessionFile(
  agentDir: string,
  sessionFile?: string,
) {
  if (!isSafeTransientSessionFile(agentDir, sessionFile)) return;
  await fs
    .rm(path.resolve(String(sessionFile)), { force: true })
    .catch(() => {});
}

function createStandaloneRunSessionManager(
  SessionManager: any,
  options: {
    cwd: string;
    agentDir: string;
    sessionFile?: string;
    managedSessionLeaf?: string;
  },
) {
  const sessionFile = options.sessionFile
    ? resolveStoredSessionFile(options.agentDir, options.sessionFile) ||
      options.sessionFile
    : "";
  if (sessionFile) {
    return SessionManager.open(
      requireExistingSessionFile(sessionFile),
      getRuntimeSessionDir(options.cwd, options.agentDir),
    );
  }

  const managedSessionLeaf =
    safeString(options.managedSessionLeaf).trim() || MANAGED_CLI_SESSION_LEAF;
  return SessionManager.create(
    options.cwd,
    getManagedSessionDir(options.agentDir, managedSessionLeaf),
  );
}

async function withRunTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => {
        reject(new Error(`run_timeout:${Math.ceil(timeoutMs / 1000)}`));
      },
      Math.max(1, timeoutMs),
    );
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runStandaloneTurn(
  parsed: ParsedArgs,
  options: RunCliOptions,
): Promise<Record<string, unknown>> {
  if (options.chatKey) {
    throw new Error("run_chat_key_not_supported_in_print_mode");
  }

  const text = [options.prompt, ...options.messages].filter(Boolean).join("\n");
  const managedSessionLeaf = safeString(options.managedSessionLeaf).trim();
  const keepSession = Boolean(options.sessionFile || managedSessionLeaf);
  const profile = resolveRuntimeProfile({ agentDir: parsed.installDir });
  const { SessionManager } = await loadRinSessionManagerModule();
  const sessionManager = createStandaloneRunSessionManager(SessionManager, {
    cwd: profile.cwd,
    agentDir: profile.agentDir,
    sessionFile: options.sessionFile,
    managedSessionLeaf,
  });
  const { session, runtime } = await createConfiguredAgentSession({
    cwd: profile.cwd,
    agentDir: profile.agentDir,
    sessionManager,
    sessionName: options.sessionName,
    tools: options.tools,
    excludeTools: options.excludeTools,
    noTools: options.noTools,
    piStartupOptions: options.piStartupOptions,
    modelRef: options.model,
    thinkingLevel: options.thinkingLevel,
  });

  let latestAssistantText = "";
  const rawUnsubscribe = session.subscribe?.((event: any) => {
    if (event?.type !== "message_end") return;
    if (event?.message?.role !== "assistant") return;
    const value = extractMessageText(event.message.content, { trim: true });
    if (value) latestAssistantText = value;
  });
  const unsubscribe =
    typeof rawUnsubscribe === "function" ? rawUnsubscribe : undefined;

  let disposed = false;
  const disposeAfterAbort = async () => {
    if (disposed) return;
    disposed = true;
    try {
      unsubscribe?.();
    } catch {}
    try {
      await session.abort?.();
    } catch {}
    try {
      await runtime.dispose?.();
    } catch {}
  };

  const signalCleanupHandlers: Array<() => void> = [];
  let signalShutdownStarted = false;
  const registerSignalHandlers = () => {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    if (process.platform !== "win32") signals.push("SIGHUP");
    for (const signal of signals) {
      const handler = () => {
        if (signalShutdownStarted) return;
        signalShutdownStarted = true;
        const exitCode =
          signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
        void disposeAfterAbort().finally(() => process.exit(exitCode));
      };
      process.on(signal, handler);
      signalCleanupHandlers.push(() => process.off(signal, handler));
    }
  };
  registerSignalHandlers();

  try {
    const promptResult: any = await withRunTimeout(
      (async () => {
        const result = await session.prompt(text, { source: "cli" as any });
        await session.agent?.waitForIdle?.();
        return result;
      })(),
      options.timeoutMs,
    );
    const completion = resolveTurnCompletion({
      result: promptResult?.result ?? promptResult,
      messages: promptResult?.messages,
      finalText: latestAssistantText || promptResult?.finalText,
    });
    if (!completion.finalText) throw new Error("final_assistant_text_missing");
    const sessionMeta = readSessionMetadata(session);
    const result = {
      finalText: completion.finalText,
      result: completion.result,
      ...(keepSession
        ? {
            sessionFile: sessionMeta.sessionFile || undefined,
            sessionId: sessionMeta.sessionId || undefined,
          }
        : {}),
    };
    if (!keepSession) {
      await removeTransientSessionFile(
        profile.agentDir,
        sessionMeta.sessionFile,
      );
    }
    return result;
  } finally {
    for (const cleanup of signalCleanupHandlers) {
      try {
        cleanup();
      } catch {}
    }
    await disposeAfterAbort();
  }
}

function printResult(
  result: Record<string, unknown>,
  outputMode: "text" | "json",
) {
  if (outputMode === "json") {
    console.log(JSON.stringify(result));
    return;
  }
  const text = safeString(result.finalText).trim();
  if (text) console.log(text);
}

export async function runNonInteractive(parsed: ParsedArgs, rawArgv: string[]) {
  if (hasChatDeliveryArg(rawArgv)) {
    throw new Error("run_chat_key_not_supported_in_print_mode");
  }
  const options = await parseRunArgs(rawArgv);
  if (options.help) {
    printRunHelp();
    return;
  }
  if (!options.prompt && !options.messages.length)
    throw new Error("run_prompt_required");

  const result = await runStandaloneTurn(parsed, options);
  printResult(result, options.outputMode);
}
