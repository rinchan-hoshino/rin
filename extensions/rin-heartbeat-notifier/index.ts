import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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

function normalizeChats(config: Record<string, any>): HeartbeatChatConfig[] {
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

function statePath(dataDir: string) {
  return path.join(dataDir, "heartbeat-notifier", "state.json");
}

function loadState(dataDir: string) {
  const parsed = readJson(statePath(dataDir));
  return isRecord(parsed) ? parsed : {};
}

function saveState(dataDir: string, state: Record<string, any>) {
  writeJson(statePath(dataDir), state);
}

async function pollOnce(ctx: BackgroundContext) {
  const chats = normalizeChats(ctx.config);
  if (!chats.length) return;
  const state = loadState(ctx.dataDir);
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
  if (changed) saveState(ctx.dataDir, state);
}

export function createBackgroundService() {
  return {
    start(ctx: BackgroundContext) {
      const intervalMs = Math.max(
        250,
        Number(ctx.config.pollIntervalMs || 1000),
      );
      let running = false;
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

export default function heartbeatNotifierExtension(rin: any) {
  rin.registerBackgroundService(createBackgroundService());
}
