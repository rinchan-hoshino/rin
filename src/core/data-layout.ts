import path from "node:path";

export function agentDataRoot(agentDir: string) {
  return path.join(path.resolve(agentDir), "data");
}

export function dataPath(agentDir: string, ...segments: string[]) {
  return path.join(agentDataRoot(agentDir), ...segments);
}

export function coreDataPath(agentDir: string, ...segments: string[]) {
  return dataPath(agentDir, "core", ...segments);
}

export function chatDataPath(agentDir: string, ...segments: string[]) {
  return dataPath(agentDir, "chat", ...segments);
}

export function schedulerDataPath(agentDir: string, ...segments: string[]) {
  return dataPath(agentDir, "scheduler", ...segments);
}

export function sidecarDataPath(agentDir: string, ...segments: string[]) {
  return dataPath(agentDir, "sidecars", ...segments);
}

export function extensionDataPath(agentDir: string, ...segments: string[]) {
  return dataPath(agentDir, "extensions", ...segments);
}

export function sharedRuntimeDataPath(agentDir: string, ...segments: string[]) {
  return dataPath(agentDir, "runtime", ...segments);
}

export const LEGACY_DATA_LAYOUT_MOVES: Array<{
  id: string;
  from: string;
  to: string;
}> = [
  {
    id: "chat-bridge-eval",
    from: "chat-bridge-eval",
    to: path.join("chat", "eval"),
  },
  { id: "chat-inbox", from: "chat-inbox", to: path.join("chat", "inbox") },
  {
    id: "koishi-message-store",
    from: "koishi-message-store",
    to: path.join("chat", "message-store"),
  },
  {
    id: "chat-message-store",
    from: "chat-message-store",
    to: path.join("chat", "message-store"),
  },
  { id: "chat-outbox", from: "chat-outbox", to: path.join("chat", "outbox") },
  {
    id: "chat-runtime-cache",
    from: "chat-runtime-cache",
    to: path.join("chat", "runtime-cache"),
  },
  {
    id: "chat-runtime-state",
    from: "chat-runtime-state",
    to: path.join("chat", "runtime-state"),
  },
  {
    id: "chat-session-state",
    from: "chats",
    to: path.join("chat", "session-state"),
  },
  { id: "scheduler", from: "cron", to: "scheduler" },
  {
    id: "scheduler-turns",
    from: "cron-turns",
    to: path.join("scheduler", "turns"),
  },
  { id: "daemon", from: "daemon", to: path.join("core", "daemon") },
  {
    id: "worker-options",
    from: "worker-options",
    to: path.join("core", "workers", "options"),
  },
  {
    id: "running-workers",
    from: "running-workers.json",
    to: path.join("core", "workers", "running-workers.json"),
  },
  {
    id: "session-ttl-maintenance",
    from: "session-ttl-maintenance.json",
    to: path.join("core", "sessions", "ttl-maintenance.json"),
  },
  {
    id: "runtime-update",
    from: "runtime-update",
    to: path.join("core", "updates"),
  },
  { id: "token-usage", from: "token-usage", to: path.join("core", "usage") },
  {
    id: "browse",
    from: "browse",
    to: path.join("sidecars", "browse"),
  },
  {
    id: "extension-runtime",
    from: "extension-runtime",
    to: path.join("extensions", "runtime"),
  },
  {
    id: "daemon-runtime",
    from: "daemon-runtime",
    to: path.join("extensions", "runtime"),
  },
];
