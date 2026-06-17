import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { coreDataPath } from "../data-layout.js";
import { safeString } from "../text-utils.js";

export { safeString };

function stablePipeHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function windowsNamedPipePath(scope: string, identity: string) {
  const normalizedScope =
    safeString(scope)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-") || "default";
  const normalizedIdentity = safeString(identity).trim() || os.homedir();
  return `\\\\.\\pipe\\rin-${normalizedScope}-${stablePipeHash(normalizedIdentity)}`;
}

export function isWindowsNamedPipePath(value: string) {
  return /^\\\\\.\\pipe\\/i.test(safeString(value).trim());
}

export function bridgeDaemonSocketPath(agentDir: string) {
  if (process.platform === "win32")
    return windowsNamedPipePath("bridge", agentDir);
  return coreDataPath(agentDir, "daemon", "bridge.sock");
}

function fallbackRuntimeDir() {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches")
    : path.join(os.homedir(), ".cache");
}

function defaultLinuxRuntimeDir(): string {
  if (process.platform !== "linux") return "";
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  return uid >= 0 ? path.join("/run/user", String(uid)) : "";
}

function defaultDaemonRuntimeDir(): string {
  return (
    safeString(process.env.XDG_RUNTIME_DIR).trim() ||
    defaultLinuxRuntimeDir() ||
    fallbackRuntimeDir()
  );
}

export function defaultDaemonSocketPath() {
  if (process.platform === "win32") {
    return windowsNamedPipePath("daemon", os.homedir());
  }
  return path.join(defaultDaemonRuntimeDir(), "rin-daemon", "daemon.sock");
}

export function parseJsonl(
  chunk: string,
  state: { buffer: string },
  onLine: (line: string) => void,
) {
  state.buffer += chunk;
  while (true) {
    const idx = state.buffer.indexOf("\n");
    if (idx < 0) break;
    let line = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    onLine(line);
  }
}
