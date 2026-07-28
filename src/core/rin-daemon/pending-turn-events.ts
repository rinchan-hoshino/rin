import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { coreDataPath } from "../data-layout.js";
import { normalizeSessionRef, type SessionRef } from "../session/ref.js";

type PendingTurnEventsState = {
  schemaVersion: 3;
  eventsBySessionFile: Record<string, any[]>;
  acknowledgedEvents: Array<{
    terminalEventId: string;
    sessionFile: string;
    requestTag?: string;
  }>;
};

const PENDING_TURN_EVENTS_FILE = "pending-turn-events.json";
export const MAX_PENDING_TERMINAL_EVENTS_PER_SESSION = 64;
export const MAX_PENDING_TERMINAL_SESSIONS = 64;
const MAX_ACKNOWLEDGED_TERMINAL_EVENTS = 4_096;

export function pendingTurnEventsStatePath(agentDir: string) {
  return coreDataPath(agentDir, "workers", PENDING_TURN_EVENTS_FILE);
}

function emptyState(): PendingTurnEventsState {
  return { schemaVersion: 3, eventsBySessionFile: {}, acknowledgedEvents: [] };
}

function eventSessionFile(payload: unknown) {
  return normalizeSessionRef(payload as SessionRef).sessionFile;
}

function isTerminalRpcTurnEvent(payload: any) {
  return (
    payload?.type === "rpc_turn_event" &&
    (payload?.event === "complete" || payload?.event === "error")
  );
}

function terminalEventWithId(payload: any, legacySeed?: string) {
  if (!isTerminalRpcTurnEvent(payload)) return null;
  const terminalEventId = String(payload.terminalEventId || "").trim();
  if (terminalEventId) return { ...payload, terminalEventId };
  return {
    ...payload,
    terminalEventId: crypto
      .createHash("sha256")
      .update(legacySeed || JSON.stringify(payload))
      .digest("hex"),
  };
}

function trimAcknowledgedEvents(
  events: PendingTurnEventsState["acknowledgedEvents"],
) {
  return events.length <= MAX_ACKNOWLEDGED_TERMINAL_EVENTS
    ? events
    : events.slice(-MAX_ACKNOWLEDGED_TERMINAL_EVENTS);
}

function readState(filePath: string): PendingTurnEventsState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid pending terminal state");
    }
    const schemaVersion = Number(parsed.schemaVersion);
    if (![1, 2, 3].includes(schemaVersion)) {
      throw new Error("Unsupported pending terminal state schema");
    }
    if (
      !parsed.eventsBySessionFile ||
      typeof parsed.eventsBySessionFile !== "object" ||
      Array.isArray(parsed.eventsBySessionFile)
    ) {
      throw new Error("Invalid pending terminal event map");
    }
    if (
      parsed.acknowledgedEvents !== undefined &&
      !Array.isArray(parsed.acknowledgedEvents)
    ) {
      throw new Error("Invalid pending terminal acknowledgement list");
    }
    if (schemaVersion === 3 && !Array.isArray(parsed.acknowledgedEvents)) {
      throw new Error("Missing pending terminal acknowledgement list");
    }
    const rawEvents = parsed.eventsBySessionFile;
    const eventsBySessionFile: Record<string, any[]> = {};
    for (const [rawSessionFile, rawValue] of Object.entries(rawEvents)) {
      const rawList = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const [index, rawEvent] of rawList.entries()) {
        const sessionFile = eventSessionFile(rawEvent) || rawSessionFile;
        const normalizedEvent = terminalEventWithId(
          rawEvent,
          JSON.stringify([rawSessionFile, index, rawEvent]),
        );
        if (!sessionFile || !normalizedEvent) {
          throw new Error("Invalid pending terminal event");
        }
        const list = (eventsBySessionFile[sessionFile] ||= []);
        if (
          !list.some(
            (event) =>
              String(event.terminalEventId) ===
                String(normalizedEvent.terminalEventId) &&
              requestTagIdentitiesMatch(event, normalizedEvent),
          )
        ) {
          list.push(normalizedEvent);
        }
      }
    }
    const acknowledgedEvents = Array.isArray(parsed.acknowledgedEvents)
      ? parsed.acknowledgedEvents.map((event: any) => {
          const normalizedEvent = {
            terminalEventId: String(event?.terminalEventId || "").trim(),
            sessionFile: normalizeSessionRef(event).sessionFile,
            ...(event?.requestTag == null
              ? {}
              : { requestTag: String(event.requestTag) }),
          };
          if (
            !normalizedEvent.terminalEventId ||
            !normalizedEvent.sessionFile
          ) {
            throw new Error("Invalid pending terminal acknowledgement");
          }
          return normalizedEvent;
        })
      : [];
    const sessionEntries = Object.entries(eventsBySessionFile);
    if (sessionEntries.length > MAX_PENDING_TERMINAL_SESSIONS) {
      throw new Error("Pending terminal session capacity exceeded");
    }
    if (
      sessionEntries.some(
        ([, events]) => events.length > MAX_PENDING_TERMINAL_EVENTS_PER_SESSION,
      )
    ) {
      throw new Error("Pending terminal event capacity exceeded");
    }
    return {
      schemaVersion: 3,
      eventsBySessionFile,
      acknowledgedEvents: trimAcknowledgedEvents(acknowledgedEvents),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

function writeState(filePath: string, state: PendingTurnEventsState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {}
  }
}

export function rememberPendingTerminalTurnEvent(
  agentDir: string | undefined,
  payload: any,
) {
  if (!agentDir || !isTerminalRpcTurnEvent(payload)) return null;
  const sessionFile = eventSessionFile(payload);
  const terminalEvent = terminalEventWithId(payload);
  if (!sessionFile || !terminalEvent) return null;
  const filePath = pendingTurnEventsStatePath(agentDir);
  const state = readState(filePath);
  if (
    state.acknowledgedEvents.some(
      (event) =>
        event.terminalEventId === terminalEvent.terminalEventId &&
        event.sessionFile === sessionFile &&
        requestTagIdentitiesMatch(event, terminalEvent),
    )
  ) {
    return false;
  }
  const sessionAlreadyPending = Object.prototype.hasOwnProperty.call(
    state.eventsBySessionFile,
    sessionFile,
  );
  if (
    !sessionAlreadyPending &&
    Object.keys(state.eventsBySessionFile).length >=
      MAX_PENDING_TERMINAL_SESSIONS
  ) {
    return null;
  }
  const events = (state.eventsBySessionFile[sessionFile] ||= []);
  const existing = events.find(
    (event) =>
      String(event.terminalEventId) === String(terminalEvent.terminalEventId) &&
      requestTagIdentitiesMatch(event, terminalEvent),
  );
  if (existing) return existing;
  if (events.length >= MAX_PENDING_TERMINAL_EVENTS_PER_SESSION) return null;
  events.push(terminalEvent);
  writeState(filePath, state);
  return terminalEvent;
}

export function clearPendingTerminalTurnEvent(
  agentDir: string | undefined,
  selector: SessionRef,
) {
  if (!agentDir) return false;
  const target = normalizeSessionRef(selector);
  if (!target.sessionFile) return false;
  const filePath = pendingTurnEventsStatePath(agentDir);
  const state = readState(filePath);
  const events = state.eventsBySessionFile[target.sessionFile];
  if (!events?.length) return false;
  delete state.eventsBySessionFile[target.sessionFile];
  writeState(filePath, state);
  return true;
}

export function pendingTerminalTurnEventCapacityReached(
  agentDir: string | undefined,
  selector: SessionRef,
) {
  if (!agentDir) return false;
  const sessionFile = normalizeSessionRef(selector).sessionFile;
  if (!sessionFile) return false;
  const state = readState(pendingTurnEventsStatePath(agentDir));
  const sessionEvents = state.eventsBySessionFile[sessionFile];
  if (
    sessionEvents &&
    sessionEvents.length >= MAX_PENDING_TERMINAL_EVENTS_PER_SESSION
  ) {
    return true;
  }
  return (
    !sessionEvents &&
    Object.keys(state.eventsBySessionFile).length >=
      MAX_PENDING_TERMINAL_SESSIONS
  );
}

export function pendingTerminalTurnEventCount(
  agentDir: string | undefined,
  selector: SessionRef,
) {
  if (!agentDir) return 0;
  const sessionFile = normalizeSessionRef(selector).sessionFile;
  if (!sessionFile) return 0;
  return (
    readState(pendingTurnEventsStatePath(agentDir)).eventsBySessionFile[
      sessionFile
    ]?.length || 0
  );
}

export function getPendingTerminalTurnEvent(
  agentDir: string | undefined,
  selector: SessionRef,
  options: { requestTag?: string; requestTagAbsent?: true } = {},
) {
  if (!agentDir) return null;
  const sessionFile = normalizeSessionRef(selector).sessionFile;
  if (!sessionFile) return null;
  const events =
    readState(pendingTurnEventsStatePath(agentDir)).eventsBySessionFile[
      sessionFile
    ] || [];
  if (
    !options.requestTagAbsent &&
    !Object.prototype.hasOwnProperty.call(options, "requestTag")
  ) {
    return events[0] || null;
  }
  return (
    events.find((event) => requestTagIdentitiesMatch(event, options)) || null
  );
}

function requestTagIdentity(owner: any) {
  if (owner?.requestTagAbsent === true) return ["absent"];
  return Object.prototype.hasOwnProperty.call(owner || {}, "requestTag") &&
    owner.requestTag != null
    ? ["present", String(owner.requestTag)]
    : ["absent"];
}

function requestTagIdentitiesMatch(left: any, right: any) {
  return (
    JSON.stringify(requestTagIdentity(left)) ===
    JSON.stringify(requestTagIdentity(right))
  );
}

export function acknowledgePendingTerminalTurnEvent(
  agentDir: string | undefined,
  selector: SessionRef,
  options: {
    terminalEventId: string;
    requestTag?: string;
    requestTagAbsent?: true;
  },
) {
  if (!agentDir || !options.terminalEventId) return false;
  const sessionFile = normalizeSessionRef(selector).sessionFile;
  if (!sessionFile) return false;
  const filePath = pendingTurnEventsStatePath(agentDir);
  const state = readState(filePath);
  const alreadyAcknowledged = state.acknowledgedEvents.find(
    (event) =>
      event.terminalEventId === options.terminalEventId &&
      event.sessionFile === sessionFile &&
      requestTagIdentitiesMatch(event, options),
  );
  if (alreadyAcknowledged) {
    const residualEvents = state.eventsBySessionFile[sessionFile] || [];
    const retainedEvents = residualEvents.filter(
      (event) =>
        !(
          String(event?.terminalEventId) === options.terminalEventId &&
          requestTagIdentitiesMatch(event, options)
        ),
    );
    if (retainedEvents.length !== residualEvents.length) {
      if (retainedEvents.length) {
        state.eventsBySessionFile[sessionFile] = retainedEvents;
      } else {
        delete state.eventsBySessionFile[sessionFile];
      }
      writeState(filePath, state);
    }
    return true;
  }
  const events = state.eventsBySessionFile[sessionFile] || [];
  const index = events.findIndex(
    (event) =>
      String(event?.terminalEventId) === options.terminalEventId &&
      requestTagIdentitiesMatch(event, options),
  );
  if (index < 0) return false;
  const [acknowledgedEvent] = events.splice(index, 1);
  if (events.length) state.eventsBySessionFile[sessionFile] = events;
  else delete state.eventsBySessionFile[sessionFile];
  state.acknowledgedEvents.push({
    terminalEventId: options.terminalEventId,
    sessionFile,
    ...(acknowledgedEvent?.requestTag == null
      ? {}
      : { requestTag: String(acknowledgedEvent.requestTag) }),
  });
  state.acknowledgedEvents = trimAcknowledgedEvents(state.acknowledgedEvents);
  writeState(filePath, state);
  return true;
}

export function takePendingTerminalTurnEvent(
  agentDir: string | undefined,
  selector: SessionRef,
  options: { requestTag?: string; requestTagAbsent?: true } = {},
) {
  const event = getPendingTerminalTurnEvent(agentDir, selector, options);
  if (!event) return null;
  const terminalEventId = String(event.terminalEventId || "");
  if (
    !terminalEventId ||
    !acknowledgePendingTerminalTurnEvent(agentDir, selector, {
      terminalEventId,
      ...(Object.prototype.hasOwnProperty.call(event, "requestTag")
        ? { requestTag: String(event.requestTag) }
        : { requestTagAbsent: true }),
    })
  ) {
    return null;
  }
  return event;
}
