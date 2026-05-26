import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_DELAY_MINUTES = 30;

type HeartbeatAgentConfig = {
  agentId: string;
  taskId: string;
  chatKey: string;
  privateInstructionPath?: string;
  state?: Record<string, any>;
};

type HeartbeatChatConfig = {
  chatKey: string;
  taskId: string;
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

function normalizeChats(config: Record<string, any>): HeartbeatChatConfig[] {
  const agents = normalizeAgents(config).map((agent) => ({
    chatKey: agent.chatKey,
    taskId: agent.taskId,
  }));
  if (agents.length) return agents;
  if (Array.isArray(config.chats)) {
    return config.chats
      .map((entry) => ({
        chatKey: text(entry?.chatKey),
        taskId: text(entry?.taskId),
      }))
      .filter((entry) => entry.chatKey && entry.taskId);
  }
  if (isRecord(config.byChatKey)) {
    return Object.entries(config.byChatKey)
      .map(([chatKey, value]) => ({
        chatKey: text(chatKey),
        taskId: isRecord(value) ? text(value.taskId) : text(value),
      }))
      .filter((entry) => entry.chatKey && entry.taskId);
  }
  return [];
}

function notifierStatePath(dataDir: string) {
  return path.join(dataDir, "heartbeat-notifier", "state.json");
}

function loadNotifierState(dataDir: string) {
  const parsed = readJson(notifierStatePath(dataDir));
  return isRecord(parsed) ? parsed : {};
}

function saveNotifierState(dataDir: string, state: Record<string, any>) {
  writeJson(notifierStatePath(dataDir), state);
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
    todos: [],
    childAgents: [],
    nextRunAt: new Date(
      Date.now() + DEFAULT_DELAY_MINUTES * 60_000,
    ).toISOString(),
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

function buildConditionCode(agent: HeartbeatAgentConfig) {
  return `async (context) => {
const fs = await import('node:fs');
const path = await import('node:path');
const dataDir = path.join(process.env.HOME, '.rin', 'data');
const agentId = ${JSON.stringify(agent.agentId)};
const chatKey = ${JSON.stringify(agent.chatKey)};
const statePath = path.join(dataDir, 'heartbeat-agents', agentId, 'state.json');
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const state = readJson(statePath) || {};
const nowMs = Date.now();
const nextMs = Date.parse(String(state.nextRunAt || ''));
if (!Number.isFinite(nextMs)) return true;
if (nextMs <= nowMs) return true;
const lastSeenMs = Date.parse(String(state.lastSeenMessageAt || '')) || 0;
const match = /^([^/]+)\\/([^:]+):(.+)$/.exec(chatKey);
if (!match) return false;
const storeRoot = path.join(dataDir, 'chat', 'message-store');
const chatDir = path.join(storeRoot, 'indexes', 'by-chat-date', match[1], match[2], match[3]);
function days() { const out = []; for (let offset = -1; offset <= 1; offset += 1) out.push(new Date(nowMs + offset * 86400000).toISOString().slice(0, 10)); return out; }
for (const day of days()) {
  const idx = readJson(path.join(chatDir, day + '.json'));
  const keys = Array.isArray(idx?.recordKeys) ? idx.recordKeys.slice(-80) : [];
  for (const key of keys) {
    const rec = readJson(path.join(storeRoot, 'records', key.slice(0, 2), key + '.json'));
    if (!rec || rec.chatKey !== chatKey) continue;
    if (rec.role !== 'user' || rec.trust !== 'OWNER') continue;
    const at = Date.parse(rec.receivedAt || rec.processedAt || '') || 0;
    if (at <= lastSeenMs) continue;
    if (!String(rec.text || rec.rawContent || '').trim()) continue;
    return true;
  }
}
return false;
}`;
}

function buildPrompt(agent: HeartbeatAgentConfig) {
  return `You are a reusable heartbeat agent named ${agent.agentId}. You run as a scheduled background task for chat ${agent.chatKey}.

Purpose:
- Maintain compact state instead of rereading all history.
- Read only new chat messages after state.lastSeenMessageAt.
- Decide whether to send a natural reply, stay silent, update todos, or delegate work to child heartbeat agents.
- Set state.nextRunAt every run. If unsure, use now + 30 minutes.

Files:
- State: ~/.rin/data/heartbeat-agents/${agent.agentId}/state.json
- Optional private instructions: read state.privateInstructionPath if present and the file exists. Treat that file as local private deployment data; never quote it verbatim unless the user explicitly asks.

Rules:
1. Read state.json first. Treat summary, styleNotes, todos, and childAgents as your prefix cache from prior runs.
2. Read only OWNER text messages in ${agent.chatKey} newer than state.lastSeenMessageAt. If needed, read a small recent window for context.
3. If you send a chat message, use Rin Agent SDK: rin.chat.send({ type: 'text_delivery', createdAt: new Date().toISOString(), chatKey: ${JSON.stringify(agent.chatKey)}, text }).
4. For non-trivial work, create or update a child heartbeat task instead of doing long work inline. Child agents should use the same state/nextRunAt/todo pattern under ~/.rin/data/heartbeat-agents/<childAgentId>/.
5. Always write state.json before finishing. Preserve useful existing state. Update at least lastRunAt, lastSeenMessageAt when messages were inspected, summary/styleNotes when they changed, todos/childAgents, lastDecision, and nextRunAt.
6. Visible chat replies must be user-facing and natural. Do not mention heartbeat, scheduler, daemon, condition, SDK, state, or implementation details.
7. Final task output must be one line only: SENT: <brief>, SILENT: <brief>, or DISPATCHED: <brief>. Do not send that marker to chat.
`;
}

async function ensureAgentTask(
  ctx: BackgroundContext,
  agent: HeartbeatAgentConfig,
) {
  ensureAgentState(ctx, agent);
  const prompt = buildPrompt(agent);
  await requestDaemonCommand(
    {
      type: "cron_upsert_task",
      task: {
        id: agent.taskId,
        name: `Heartbeat agent: ${agent.agentId}`,
        enabled: true,
        trigger: { expression: "* * * * *", timezone: "local" },
        condition: { code: buildConditionCode(agent), timeoutMs: 5000 },
        session: { mode: "none" },
        target: { kind: "agent_prompt", prompt, continuationPrompt: prompt },
      },
    },
    30_000,
  );
}

async function ensureAgentTasks(ctx: BackgroundContext) {
  for (const agent of normalizeAgents(ctx.config)) {
    try {
      await ensureAgentTask(ctx, agent);
    } catch (error: any) {
      ctx.logger?.warn?.(
        `heartbeat notifier task setup failed agentId=${agent.agentId} taskId=${agent.taskId} err=${text(error?.message || error)}`,
      );
    }
  }
}

async function pollOnce(ctx: BackgroundContext) {
  const chats = normalizeChats(ctx.config);
  if (!chats.length) return;
  const state = loadNotifierState(ctx.dataDir);
  let changed = false;
  for (const chat of chats) {
    const current = isRecord(state[chat.chatKey]) ? state[chat.chatKey] : {};
    const afterMs = Date.parse(text(current.lastNotifiedAt));
    const latest = latestOwnerTextAfter({
      dataDir: ctx.dataDir,
      chatKey: chat.chatKey,
      afterMs: Number.isFinite(afterMs) ? afterMs : 0,
    });
    if (!latest) continue;
    try {
      await requestDaemonCommand({
        type: "cron_wake_task",
        taskId: chat.taskId,
      });
      state[chat.chatKey] = {
        ...current,
        taskId: chat.taskId,
        lastNotifiedAt: new Date(latest.at).toISOString(),
        lastMessageId: latest.messageId,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
    } catch (error: any) {
      ctx.logger?.warn?.(
        `heartbeat notifier wake failed chatKey=${chat.chatKey} taskId=${chat.taskId} err=${text(error?.message || error)}`,
      );
    }
  }
  if (changed) saveNotifierState(ctx.dataDir, state);
}

export function createBackgroundService() {
  return {
    start(ctx: BackgroundContext) {
      const intervalMs = Math.max(
        250,
        Number(ctx.config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS),
      );
      let running = false;
      void ensureAgentTasks(ctx);
      const run = () => {
        if (running || ctx.signal.aborted) return;
        running = true;
        void pollOnce(ctx).finally(() => {
          running = false;
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
