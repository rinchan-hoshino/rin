import { normalizeSessionRef, type SessionRefInput } from "../session/ref.js";

export type RinPendingTerminalTurnEventCommand = {
  type:
    | "replay_pending_terminal_turn_event"
    | "ack_pending_terminal_turn_event";
  sessionFile?: string;
  sessionId?: string;
  requestTag?: string;
  requestTagAbsent?: true;
  terminalEventId?: string;
};

export type RinPendingTerminalTurnEventRequester = (
  command: RinPendingTerminalTurnEventCommand,
) => Promise<any>;

export async function replayPendingTerminalTurnEvent(
  request: RinPendingTerminalTurnEventRequester | undefined,
  ref: SessionRefInput | null | undefined,
  requestTag?: string | null,
) {
  if (typeof request !== "function") return false;
  const selector = normalizeSessionRef(ref);
  if (!selector.sessionFile && !selector.sessionId) return false;
  const response = await request({
    type: "replay_pending_terminal_turn_event",
    ...(selector.sessionFile ? { sessionFile: selector.sessionFile } : {}),
    ...(selector.sessionId ? { sessionId: selector.sessionId } : {}),
    ...(requestTag === undefined
      ? {}
      : requestTag === null
        ? { requestTagAbsent: true as const }
        : { requestTag: String(requestTag) }),
  }).catch(() => null);
  return Boolean(response?.replayed);
}

export async function acknowledgePendingTerminalTurnEvent(
  request: RinPendingTerminalTurnEventRequester | undefined,
  ref: SessionRefInput | null | undefined,
  terminalEventId: string,
  requestTag?: string,
) {
  if (typeof request !== "function" || !terminalEventId) return false;
  const selector = normalizeSessionRef(ref);
  if (!selector.sessionFile && !selector.sessionId) return false;
  const response = await request({
    type: "ack_pending_terminal_turn_event",
    ...(selector.sessionFile ? { sessionFile: selector.sessionFile } : {}),
    ...(selector.sessionId ? { sessionId: selector.sessionId } : {}),
    terminalEventId,
    ...(requestTag === undefined
      ? { requestTagAbsent: true as const }
      : { requestTag }),
  }).catch(() => null);
  return Boolean(response?.acknowledged);
}
