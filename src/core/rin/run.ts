import fs from "node:fs/promises";
import path from "node:path";
import { requestDaemonCommand } from "../rin-daemon/client.js";
import { MANAGED_CLI_SESSION_LEAF } from "../session/managed-paths.js";
import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  stripRinWrapperArgs,
  type ParsedArgs,
  safeString,
} from "./shared.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const VALID_MODES = new Set(["text", "json"]);

export type RunCliOptions = {
  messages: string[];
  prompt: string;
  sessionFile?: string;
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
  --chat-key <chatKey>           Deliver the final answer to this chat as well
  --timeout <seconds>            Maximum wait time (default: 1800)
  --help, -h                     Show this help

Examples:
  rin -p "Summarize this repository"
  cat README.md | rin -p "Summarize this text"
  rin --mode json "List all .ts files in src/"
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
  const messages: string[] = [];
  const fileArgs: string[] = [];
  let sessionFile = "";
  let sessionName = "";
  let provider = "";
  let model = "";
  let thinkingLevel = "";
  let chatKey = "";
  let timeoutValue = "";
  let outputMode: "text" | "json" = "text";
  let help = false;
  let passthroughMessages = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = safeString(args[index]).trim();
    if (!arg) continue;
    if (passthroughMessages) {
      messages.push(arg);
      continue;
    }
    if (arg === "--") {
      passthroughMessages = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--print" || arg === "-p") continue;
    if (arg === "--bind-chat-session") {
      throw new Error("unknown_run_option:--bind-chat-session");
    }
    if (arg === "--mode") {
      const value = readValue(args, index);
      if (value === undefined) throw new Error("run_mode_value_required");
      if (!VALID_MODES.has(value)) throw new Error(`invalid_mode:${value}`);
      outputMode = value as "text" | "json";
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!VALID_MODES.has(value)) throw new Error(`invalid_mode:${value}`);
      outputMode = value as "text" | "json";
      continue;
    }
    if (arg === "--provider") {
      index = appendInlineValue(
        args,
        index,
        (value) => (provider = value),
        "run_provider_value_required",
      );
      continue;
    }
    if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
      continue;
    }
    if (arg === "--model") {
      index = appendInlineValue(
        args,
        index,
        (value) => (model = value),
        "run_model_value_required",
      );
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }
    if (arg === "--thinking") {
      index = appendInlineValue(
        args,
        index,
        (value) => (thinkingLevel = value),
        "run_thinking_value_required",
      );
      continue;
    }
    if (arg.startsWith("--thinking=")) {
      thinkingLevel = arg.slice("--thinking=".length);
      continue;
    }
    if (arg === "--session") {
      index = appendInlineValue(
        args,
        index,
        (value) => (sessionFile = value),
        "run_session_value_required",
      );
      continue;
    }
    if (arg.startsWith("--session=")) {
      sessionFile = arg.slice("--session=".length);
      continue;
    }
    if (arg === "--no-session") {
      sessionFile = "";
      continue;
    }
    if (arg === "--name") {
      index = appendInlineValue(
        args,
        index,
        (value) => (sessionName = value),
        "run_name_value_required",
      );
      continue;
    }
    if (arg.startsWith("--name=")) {
      sessionName = arg.slice("--name=".length);
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
      continue;
    }
    if (arg.startsWith("@")) {
      fileArgs.push(arg.slice(1));
      continue;
    }
    if (arg.startsWith("--")) {
      const value = readValue(args, index);
      if (value !== undefined && !value.startsWith("@")) index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown_run_option:${arg}`);
    messages.push(arg);
  }

  const parts: string[] = [];
  const stdinContent =
    stdinContentOverride !== undefined
      ? stdinContentOverride
      : await readStdinIfAvailable();
  if (stdinContent) parts.push(stdinContent);
  for (const fileArg of fileArgs) {
    const text = await readFileArg(fileArg);
    if (text) parts.push(text);
  }
  if (messages.length) parts.push(messages[0]);
  const prompt = parts.join("");
  const additionalMessages = messages.length > 1 ? messages.slice(1) : [];
  const providerModel = resolveProviderModel(provider, model);
  if (model && !providerModel) throw new Error(`invalid_model:${model}`);

  return {
    messages: additionalMessages,
    prompt,
    sessionFile: safeString(sessionFile).trim() || undefined,
    sessionName: safeString(sessionName).trim() || undefined,
    provider: safeString(provider).trim() || undefined,
    model: providerModel
      ? `${providerModel.provider}/${providerModel.modelId}`
      : undefined,
    thinkingLevel: safeString(thinkingLevel).trim() || undefined,
    chatKey: safeString(chatKey).trim() || undefined,
    outputMode,
    timeoutMs: parseTimeoutMs(timeoutValue),
    help,
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
  const keepSession = Boolean(options.sessionFile);
  if (options.sessionName) throw new Error("run_name_unsupported");
  const result = await requestDaemonCommand(
    {
      type: "chat_run_turn",
      payload: {
        chatKey: options.chatKey,
        text,
        sessionFile: options.sessionFile,
        ...(!keepSession
          ? { managedSessionLeaf: MANAGED_CLI_SESSION_LEAF }
          : {}),
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        controllerKey: `cli-${Date.now()}`,
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
