import net from "node:net";

import {
  defaultDaemonSocketPath,
  parseJsonl,
  safeString,
} from "../rin-lib/common.js";

function resolveDaemonSocketPath(socketPath?: string) {
  return safeString(socketPath).trim() || defaultDaemonSocketPath();
}

function resolveTimeoutMs(timeoutMs: number | undefined, fallback: number) {
  return Math.max(1, Number(timeoutMs || fallback));
}

function resolveDaemonRequestId(
  requestId: string | undefined,
  fallbackPrefix: string,
) {
  const resolved = safeString(requestId).trim();
  if (resolved) return resolved;
  return `${fallbackPrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createDaemonRequestPayload(commandType: string, requestId: string) {
  return { id: requestId, type: commandType };
}

function destroyDaemonSocket(socket: net.Socket) {
  try {
    socket.destroy();
  } catch {}
}

function isMatchingDaemonResponse(
  payload: any,
  requestId: string,
  commandType?: string,
) {
  if (payload?.type !== "response" || payload?.id !== requestId) return false;
  if (!commandType) return true;
  return safeString(payload?.command).trim() === safeString(commandType).trim();
}

function parseDaemonResponseLine(
  line: string,
  options: { requestId: string; commandType?: string },
) {
  let payload: any;
  try {
    payload = JSON.parse(line);
  } catch {
    return { error: new Error("daemon_invalid_json") };
  }
  if (
    !isMatchingDaemonResponse(payload, options.requestId, options.commandType)
  ) {
    return { ignored: true };
  }
  if (payload?.success === false) {
    return {
      error: new Error(String(payload?.error || "daemon_request_failed")),
    };
  }
  return { value: payload?.data ?? payload };
}

function buildDaemonSocketScript(
  body: string,
  socketPath?: string,
  timeoutMs = 500,
) {
  const resolvedSocketPath = resolveDaemonSocketPath(socketPath);
  const timeout = resolveTimeoutMs(timeoutMs, 500);
  return [
    "const net = require('node:net');",
    `const socketPath = ${JSON.stringify(resolvedSocketPath)};`,
    `const timeoutMs = ${timeout};`,
    body,
  ].join("\n");
}

export function buildDaemonSocketProbeScript(
  socketPath?: string,
  timeoutMs = 500,
) {
  return buildDaemonSocketScript(
    String.raw`
const socket = net.createConnection({ path: socketPath });
let settled = false;
const finish = (ok) => {
  if (settled) return;
  settled = true;
  try { socket.destroy(); } catch {}
  process.exit(ok ? 0 : 1);
};
socket.once("connect", () => finish(true));
socket.once("error", () => finish(false));
setTimeout(() => finish(false), timeoutMs);
`.trim(),
    socketPath,
    timeoutMs,
  );
}

export function buildDaemonCommandScript(
  command: Record<string, any>,
  socketPath?: string,
  timeoutMs = 1500,
  requestId = "command_1",
) {
  const id = resolveDaemonRequestId(requestId, "command");
  const commandType = safeString(command?.type).trim();
  const requestPayload = JSON.stringify({ ...command, id });
  return buildDaemonSocketScript(
    String.raw`
const requestJson = ${JSON.stringify(requestPayload)};
const socket = net.createConnection({ path: socketPath });
let buffer = "";
let settled = false;
const finish = (value) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { socket.destroy(); } catch {}
  process.stdout.write(JSON.stringify(value === undefined ? null : value));
};
const timer = setTimeout(() => finish(undefined), timeoutMs);
socket.once("error", () => finish(undefined));
socket.on("data", (chunk) => {
  buffer += String(chunk);
  while (true) {
    const idx = buffer.indexOf("\n");
    if (idx < 0) break;
    let line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line);
      if (
        payload?.type === "response" &&
        payload?.command === ${JSON.stringify(commandType)} &&
        payload?.id === ${JSON.stringify(id)}
      ) {
        finish(payload.success === true ? payload.data : undefined);
        return;
      }
    } catch {
      finish(undefined);
      return;
    }
  }
});
socket.once("connect", () => socket.write(requestJson + "\n"));
`.trim(),
    socketPath,
    timeoutMs,
  );
}

export function buildDaemonStatusScript(
  socketPath?: string,
  timeoutMs = 1500,
  requestId = "doctor_1",
) {
  const id = resolveDaemonRequestId(requestId, "doctor");
  const requestPayload = JSON.stringify(
    createDaemonRequestPayload("daemon_status", id),
  );
  return buildDaemonSocketScript(
    String.raw`
const requestJson = ${JSON.stringify(requestPayload)};
const socket = net.createConnection({ path: socketPath });
let buffer = "";
let settled = false;
const finish = (value) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { socket.destroy(); } catch {}
  process.stdout.write(JSON.stringify(value === undefined ? null : value));
};
const timer = setTimeout(() => finish(undefined), timeoutMs);
socket.once("error", () => finish(undefined));
socket.on("data", (chunk) => {
  buffer += String(chunk);
  while (true) {
    const idx = buffer.indexOf("\n");
    if (idx < 0) break;
    let line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line);
      if (
        payload?.type === "response" &&
        payload?.command === "daemon_status" &&
        payload?.id === ${JSON.stringify(id)}
      ) {
        finish(payload.success === true ? payload.data : undefined);
        return;
      }
    } catch {
      finish(undefined);
      return;
    }
  }
});
socket.once("connect", () => socket.write(requestJson + "\n"));
`.trim(),
    socketPath,
    timeoutMs,
  );
}

export async function canConnectDaemonSocket(
  socketPath?: string,
  timeoutMs = 500,
) {
  const resolvedSocketPath = resolveDaemonSocketPath(socketPath);
  const timeout = resolveTimeoutMs(timeoutMs, 500);
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      destroyDaemonSocket(socket);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeout);
    socket.once("error", () => finish(false));
    socket.once("connect", () => finish(true));
    socket.connect({ path: resolvedSocketPath });
  });
}

export async function requestDaemonCommand(
  command: Record<string, any>,
  options: { socketPath?: string; timeoutMs?: number } = {},
) {
  const socketPath = resolveDaemonSocketPath(options.socketPath);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs, 30_000);
  const commandType = safeString(command?.type).trim() || "unknown";
  const requestId = resolveDaemonRequestId(command?.id, "daemon");
  return await new Promise<any>((resolve, reject) => {
    const socket = new net.Socket();
    const state = { buffer: "" };
    let settled = false;
    const finish = (error?: unknown, value?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      destroyDaemonSocket(socket);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`daemon_timeout:${commandType}`)),
      timeoutMs,
    );

    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      parseJsonl(String(chunk), state, (line) => {
        const parsed = parseDaemonResponseLine(line, {
          requestId,
          commandType,
        });
        if (parsed.ignored) return;
        if (parsed.error) {
          finish(parsed.error);
          return;
        }
        finish(undefined, parsed.value);
      });
    });
    socket.once("connect", () => {
      try {
        socket.write(
          `${JSON.stringify({ ...command, id: requestId, type: commandType })}\n`,
        );
      } catch (error) {
        finish(error);
      }
    });
    socket.connect({ path: socketPath });
  });
}
