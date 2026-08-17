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
    id: "runtime-update",
    from: "runtime-update",
    to: path.join("core", "updates"),
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
