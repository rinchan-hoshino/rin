import fs from "node:fs";
import path from "node:path";

import { coreDataPath } from "../data-layout.js";
import { normalizeSessionRef, type SessionRef } from "../session/ref.js";

const PENDING_TURN_EVENTS_FILE = "pending-turn-events.json";

type PendingTurnEventsState = {
  schemaVersion: 1;
  eventsBySessionFile: Record<string, any>;
};

export function pendingTurnEventsStatePath(agentDir: string) {
  return coreDataPath(agentDir, "workers", PENDING_TURN_EVENTS_FILE);
}

function emptyState(): PendingTurnEventsState {
  return { schemaVersion: 1, eventsBySessionFile: {} };
}

function readState(filePath: string): PendingTurnEventsState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rawEvents =
      parsed?.eventsBySessionFile &&
      typeof parsed.eventsBySessionFile === "object"
        ? parsed.eventsBySessionFile
        : {};
    const eventsBySessionFile: Record<string, any> = {};
    for (const [rawSessionFile, event] of Object.entries(rawEvents)) {
      const sessionFile = normalizeSessionRef({
        sessionFile: rawSessionFile,
      }).sessionFile;
      if (!sessionFile || !isTerminalRpcTurnEvent(event)) continue;
      eventsBySessionFile[sessionFile] = event;
    }
    return { schemaVersion: 1, eventsBySessionFile };
  } catch {
    return emptyState();
  }
}

function writeState(filePath: string, state: PendingTurnEventsState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

function isTerminalRpcTurnEvent(payload: unknown) {
  const value = payload && typeof payload === "object" ? (payload as any) : {};
  return (
    value.type === "rpc_turn_event" &&
    (value.event === "complete" || value.event === "error")
  );
}

function eventSessionFile(payload: unknown) {
  return normalizeSessionRef(payload as SessionRef).sessionFile;
}

export function rememberPendingTerminalTurnEvent(
  agentDir: string | undefined,
  payload: unknown,
) {
  if (!agentDir || !isTerminalRpcTurnEvent(payload)) return;
  const sessionFile = eventSessionFile(payload);
  if (!sessionFile) return;
  const filePath = pendingTurnEventsStatePath(agentDir);
  const state = readState(filePath);
  state.eventsBySessionFile[sessionFile] = payload;
  writeState(filePath, state);
}

export function clearPendingTerminalTurnEvent(
  agentDir: string | undefined,
  selector: SessionRef,
) {
  if (!agentDir) return false;
  const sessionFile = normalizeSessionRef(selector).sessionFile;
  if (!sessionFile) return false;
  const filePath = pendingTurnEventsStatePath(agentDir);
  const state = readState(filePath);
  if (!state.eventsBySessionFile[sessionFile]) return false;
  delete state.eventsBySessionFile[sessionFile];
  writeState(filePath, state);
  return true;
}

export function takePendingTerminalTurnEvent(
  agentDir: string | undefined,
  selector: SessionRef,
) {
  if (!agentDir) return null;
  const sessionFile = normalizeSessionRef(selector).sessionFile;
  if (!sessionFile) return null;
  const filePath = pendingTurnEventsStatePath(agentDir);
  const state = readState(filePath);
  const event = state.eventsBySessionFile[sessionFile];
  if (!event) return null;
  delete state.eventsBySessionFile[sessionFile];
  writeState(filePath, state);
  return event;
}
