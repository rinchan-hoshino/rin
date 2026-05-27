import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_DELAY_MINUTES = 30;

type HeartbeatAgentConfig = {
  agentId: string;
  taskId: string;
  chatKey: string;
  privateInstructionPath?: string;
  state?: Record<string, any>;
};

type BackgroundContext = {
  agentDir: string;
  dataDir: string;
  config: Record<string, any>;
  signal: AbortSignal;
  logger?: {
    warn?: (message: string) => void;
    info?: (message: string) => void;
  };
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function defaultRuntimeDir() {
  const configured = text(process.env.XDG_RUNTIME_DIR);
  if (configured) return configured;
  if (typeof process.getuid === "function")
    return `/run/user/${process.getuid()}`;
  return path.join(os.tmpdir(), `rin-${os.userInfo().username}`);
}

function daemonSocketPath() {
  return path.join(defaultRuntimeDir(), "rin-daemon", "daemon.sock");
}

async function requestDaemonCommand(
  command: Record<string, any>,
  timeoutMs = 1000,
) {
  const socketPath = daemonSocketPath();
  const id =
    text(command.id) ||
    `heartbeat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const type = text(command.type);
  return await new Promise<any>((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = "";
    let settled = false;
    const finish = (error?: unknown, value?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`daemon_timeout:${type}`)),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("error", finish);
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        let payload: any;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (payload?.type !== "response" || payload?.id !== id) continue;
        if (payload?.command !== type) continue;
        if (payload?.success === false) {
          finish(new Error(text(payload.error) || "daemon_request_failed"));
          return;
        }
        finish(undefined, payload?.data ?? payload);
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ ...command, id, type })}\n`);
    });
    socket.connect({ path: socketPath });
  });
}

function parseChatKey(chatKey: string) {
  const match = /^([^/]+)\/([^:]+):(.+)$/.exec(chatKey);
  if (!match) return null;
  return { platform: match[1], selfId: match[2], chatId: match[3] };
}

function listDateNamesAround(nowMs: number) {
  const days: string[] = [];
  for (let offset = -1; offset <= 1; offset += 1) {
    days.push(new Date(nowMs + offset * 86400000).toISOString().slice(0, 10));
  }
  return days;
}

function latestOwnerTextAfter(options: {
  dataDir: string;
  chatKey: string;
  afterMs: number;
}) {
  const parsed = parseChatKey(options.chatKey);
  if (!parsed) return null;
  const storeRoot = path.join(options.dataDir, "chat", "message-store");
  const chatDir = path.join(
    storeRoot,
    "indexes",
    "by-chat-date",
    parsed.platform,
    parsed.selfId,
    parsed.chatId,
  );
  let latest: null | { at: number; messageId: string; text: string } = null;
  for (const day of listDateNamesAround(Date.now())) {
    const index = readJson(path.join(chatDir, `${day}.json`));
    const keys = Array.isArray(index?.recordKeys)
      ? index.recordKeys.slice(-100)
      : [];
    for (const key of keys) {
      const rec = readJson(
        path.join(storeRoot, "records", key.slice(0, 2), `${key}.json`),
      );
      if (!rec || rec.chatKey !== options.chatKey) continue;
      if (rec.role !== "user" || rec.trust !== "OWNER") continue;
      const at = Date.parse(text(rec.receivedAt || rec.processedAt));
      if (!Number.isFinite(at) || at <= options.afterMs) continue;
      const body = text(rec.text || rec.rawContent);
      if (!body) continue;
      if (!latest || at > latest.at) {
        latest = { at, messageId: text(rec.messageId), text: body };
      }
    }
  }
  return latest;
}

function normalizeAgentConfig(entry: unknown): HeartbeatAgentConfig | null {
  if (!isRecord(entry)) return null;
  const chatKey = text(entry.chatKey);
  const agentId = text(entry.agentId) || text(entry.id) || text(entry.taskId);
  const taskId = text(entry.taskId) || `heartbeat_${agentId}`;
  if (!chatKey || !agentId || !taskId) return null;
  return {
    agentId,
    taskId,
    chatKey,
    privateInstructionPath: text(entry.privateInstructionPath) || undefined,
    state: isRecord(entry.state) ? entry.state : undefined,
  };
}

function normalizeAgents(config: Record<string, any>): HeartbeatAgentConfig[] {
  if (!Array.isArray(config.agents)) return [];
  return config.agents
    .map((entry) => normalizeAgentConfig(entry))
    .filter((entry): entry is HeartbeatAgentConfig => Boolean(entry));
}

function extensionConfigPath(agentDir: string) {
  return path.join(agentDir, "extensions", "rin-heartbeat-notifier.json");
}

function loadEffectiveConfig(ctx: BackgroundContext) {
  const fileConfig = readJson(extensionConfigPath(ctx.agentDir));
  return {
    ...(isRecord(fileConfig) ? fileConfig : {}),
    ...(isRecord(ctx.config) ? ctx.config : {}),
  };
}

function agentDirPath(dataDir: string, agentId: string) {
  return path.join(dataDir, "heartbeat-agents", agentId);
}

function agentStatePath(dataDir: string, agentId: string) {
  return path.join(agentDirPath(dataDir, agentId), "state.json");
}

function defaultAgentState(agent: HeartbeatAgentConfig) {
  return {
    schemaVersion: 1,
    agentId: agent.agentId,
    parentAgentId: null,
    chatKey: agent.chatKey,
    privateInstructionPath: agent.privateInstructionPath || undefined,
    lastSeenMessageAt: new Date(0).toISOString(),
    summary:
      "This heartbeat agent maintains a compact state summary, reads only message increments, and decides whether to reply, stay silent, or delegate work.",
    styleNotes:
      "Keep visible chat replies short, natural, and user-facing. Do not mention internal heartbeat, scheduler, condition, state, or daemon details.",
    checklist: [],
    todos: [],
    childAgents: [],
    nextRunAt: null,
    defaultDelayMinutes: DEFAULT_DELAY_MINUTES,
    lastRunAt: null,
    lastDecision: "initialized",
    ...(agent.state || {}),
  };
}

function ensureAgentState(ctx: BackgroundContext, agent: HeartbeatAgentConfig) {
  const filePath = agentStatePath(ctx.dataDir, agent.agentId);
  const current = readJson(filePath);
  if (isRecord(current)) {
    const next = { ...current };
    let changed = false;
    if (agent.privateInstructionPath && !next.privateInstructionPath) {
      next.privateInstructionPath = agent.privateInstructionPath;
      changed = true;
    }
    if (changed) writeJson(filePath, next);
    return;
  }
  writeJson(filePath, defaultAgentState(agent));
}

function bundledInstructionsPath() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "agent-instructions.md",
  );
}

function buildInitialPrompt(options: {
  instructionsPath: string;
  agent: HeartbeatAgentConfig;
  statePath: string;
}) {
  return `Read the bundled heartbeat instructions at ${options.instructionsPath} to understand what to do. Your agentId is ${options.agent.agentId}, chatKey is ${options.agent.chatKey}, and state file is ${options.statePath}. Then start this round.`;
}

function buildRoundPrompt() {
  return "A new round has started.";
}

async function deleteLegacyScheduledTask(agent: HeartbeatAgentConfig) {
  try {
    await requestDaemonCommand({
      type: "cron_delete_task",
      taskId: agent.taskId,
    });
  } catch {}
}

function isOpenChecklistItem(item: unknown) {
  if (typeof item === "string") return Boolean(text(item));
  if (!isRecord(item)) return false;
  const status = text(item.status).toLowerCase();
  if (
    ["done", "completed", "cancelled", "canceled", "closed"].includes(status)
  ) {
    return false;
  }
  return Boolean(text(item.text) || text(item.title) || text(item.id));
}

function hasOpenWakeChecklist(state: any) {
  const checklist = Array.isArray(state?.checklist) ? state.checklist : [];
  const legacyTodos = Array.isArray(state?.todos) ? state.todos : [];
  const childAgents = Array.isArray(state?.childAgents)
    ? state.childAgents
    : [];
  return [...checklist, ...legacyTodos, ...childAgents].some(
    isOpenChecklistItem,
  );
}

function enqueueLatestMessageChecklist(
  ctx: BackgroundContext,
  agent: HeartbeatAgentConfig,
) {
  ensureAgentState(ctx, agent);
  const filePath = agentStatePath(ctx.dataDir, agent.agentId);
  const state = readJson(filePath) || {};
  const lastSeenMs = Date.parse(text(state?.lastSeenMessageAt));
  const latest = latestOwnerTextAfter({
    dataDir: ctx.dataDir,
    chatKey: agent.chatKey,
    afterMs: Number.isFinite(lastSeenMs) ? lastSeenMs : 0,
  });
  if (!latest) return state;
  const checklist = Array.isArray(state.checklist) ? state.checklist : [];
  const itemId = `message:${latest.messageId || latest.at}`;
  const exists = checklist.some(
    (item: unknown) => isRecord(item) && text(item.id) === itemId,
  );
  if (exists) return state;
  const next = {
    ...state,
    checklist: [
      ...checklist,
      {
        id: itemId,
        type: "message",
        status: "open",
        chatKey: agent.chatKey,
        messageId: latest.messageId,
        receivedAt: new Date(latest.at).toISOString(),
        title: "Review new owner message and decide the next natural action",
        preview: latest.text.slice(0, 160),
        createdAt: new Date().toISOString(),
      },
    ],
    nextRunAt: new Date().toISOString(),
  };
  writeJson(filePath, next);
  return next;
}

function agentShouldRun(ctx: BackgroundContext, agent: HeartbeatAgentConfig) {
  const state = enqueueLatestMessageChecklist(ctx, agent);
  if (!hasOpenWakeChecklist(state)) return false;
  const nextMs = Date.parse(text(state?.nextRunAt));
  return !Number.isFinite(nextMs) || nextMs <= Date.now();
}

async function runAgent(ctx: BackgroundContext, agent: HeartbeatAgentConfig) {
  const instructionsPath = bundledInstructionsPath();
  const statePath = agentStatePath(ctx.dataDir, agent.agentId);
  const state = readJson(statePath) || {};
  const initialized = state.instructionsInitialized === true;
  await requestDaemonCommand(
    {
      type: "chat_run_turn",
      payload: {
        text: initialized
          ? buildRoundPrompt()
          : buildInitialPrompt({ instructionsPath, agent, statePath }),
        controllerKey: `heartbeat:${agent.agentId}`,
        managedSessionLeaf: `heartbeat/${agent.agentId}`,
        deliveryEnabled: false,
        affectChatBinding: false,
        disposeAfterTurn: false,
        shutdownAfterTurn: false,
      },
    },
    15 * 60_000,
  );
  if (!initialized) {
    const latest = readJson(statePath) || {};
    writeJson(statePath, {
      ...latest,
      instructionsPath,
      instructionsInitialized: true,
      instructionsInitializedAt: new Date().toISOString(),
    });
  }
}

async function pollOnce(
  ctx: BackgroundContext,
  runningAgents: Set<string>,
  config: Record<string, any>,
) {
  for (const agent of normalizeAgents(config)) {
    if (runningAgents.has(agent.agentId)) continue;
    if (!agentShouldRun(ctx, agent)) continue;
    runningAgents.add(agent.agentId);
    void runAgent(ctx, agent)
      .catch((error: any) => {
        ctx.logger?.warn?.(
          `heartbeat agent run failed agentId=${agent.agentId} err=${text(error?.message || error)}`,
        );
      })
      .finally(() => runningAgents.delete(agent.agentId));
  }
}

export function createBackgroundService() {
  return {
    start(ctx: BackgroundContext) {
      const config = loadEffectiveConfig(ctx);
      const intervalMs = Math.max(
        250,
        Number(config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS),
      );
      let polling = false;
      const runningAgents = new Set<string>();
      for (const agent of normalizeAgents(config)) {
        void deleteLegacyScheduledTask(agent);
      }
      const run = () => {
        if (polling || ctx.signal.aborted) return;
        polling = true;
        void pollOnce(ctx, runningAgents, config).finally(() => {
          polling = false;
        });
      };
      run();
      const timer = setInterval(run, intervalMs);
      ctx.signal.addEventListener("abort", () => clearInterval(timer), {
        once: true,
      });
      return { stop: () => clearInterval(timer) };
    },
  };
}

export default createBackgroundService();
