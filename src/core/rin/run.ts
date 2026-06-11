import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent";
import { requestDaemonCommand } from "../rin-daemon/client.js";
import { MANAGED_CLI_SESSION_LEAF } from "../session/managed-paths.js";
import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  stripRinWrapperArgs,
  type ParsedArgs,
  safeString,
} from "./shared.js";
import type { RinPiPassthroughOptions } from "../rin-lib/pi-passthrough.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";

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
  --chat-key <chatKey>           Deliver the final answer to this chat as well
  --timeout <seconds>            Maximum wait time (default: 1800)
  --help, -h                     Show this help

Examples:
  rin -p "Summarize this repository"
  cat README.md | rin -p "Summarize this text"
  rin --mode json "List all .ts files in src/"
  rin --mode json --managed-session subagent -p "Scout the auth module"
  rin --name "release audit" -p "Audit this repository"
  rin --model openai/gpt-5.5 --thinking low -p "Draft release notes"
  rin -p --chat-key telegram/123:-100456 "Send a short status update"
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

function formatRunResult(result: any, keepSession: boolean) {
  return {
    finalText: result?.finalText,
    result: result?.result,
    ...(keepSession
      ? { sessionFile: result?.sessionFile, sessionId: result?.sessionId }
      : {}),
  };
}

async function runDetachedTurn(
  agentDir: string,
  socketPath: string,
  options: RunCliOptions,
): Promise<Record<string, unknown>> {
  const text = [options.prompt, ...options.messages].filter(Boolean).join("\n");
  const managedSessionLeaf = safeString(options.managedSessionLeaf).trim();
  const keepSession = Boolean(options.sessionFile || managedSessionLeaf);
  const result = await requestDaemonCommand(
    {
      type: "chat_run_turn",
      payload: {
        chatKey: options.chatKey,
        text,
        sessionFile: options.sessionFile,
        ...(!options.sessionFile
          ? {
              managedSessionLeaf:
                managedSessionLeaf || MANAGED_CLI_SESSION_LEAF,
            }
          : {}),
        ...(options.sessionName ? { sessionName: options.sessionName } : {}),
        ...(options.tools !== undefined ? { tools: options.tools } : {}),
        ...(options.excludeTools !== undefined
          ? { excludeTools: options.excludeTools }
          : {}),
        ...(options.noTools !== undefined ? { noTools: options.noTools } : {}),
        ...(options.piStartupOptions !== undefined
          ? { piStartupOptions: options.piStartupOptions }
          : {}),
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        controllerKey: `cli-${Date.now()}-${randomUUID().slice(0, 8)}`,
        affectChatBinding: false,
        disposeAfterTurn: true,
      },
    },
    { socketPath, timeoutMs: options.timeoutMs },
  );
  if (!keepSession) {
    await removeTransientSessionFile(agentDir, result?.sessionFile);
  }
  return formatRunResult(result, keepSession);
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
  const options = await parseRunArgs(rawArgv);
  if (options.help) {
    printRunHelp();
    return;
  }
  if (!options.prompt && !options.messages.length)
    throw new Error("run_prompt_required");

  const context = createTargetExecutionContext(parsed);
  await ensureDaemonAvailable(context);
  const result = await runDetachedTurn(
    context.agentDir,
    context.socketPath,
    options,
  );
  printResult(result, options.outputMode);
}
