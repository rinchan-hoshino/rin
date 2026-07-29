import { normalizeSessionRef, type SessionRefInput } from "../session/ref.js";

export type RinPendingTerminalTurnEventCommand = {
  type: "replay_pending_terminal_turn_event";
  sessionFile?: string;
  sessionId?: string;
};

export type RinPendingTerminalTurnEventRequester = (
  command: RinPendingTerminalTurnEventCommand,
) => Promise<any>;

export async function replayPendingTerminalTurnEvent(
  request: RinPendingTerminalTurnEventRequester | undefined,
  ref: SessionRefInput | null | undefined,
) {
  if (typeof request !== "function") return false;
  const selector = normalizeSessionRef(ref);
  if (!selector.sessionFile && !selector.sessionId) return false;
  const response = await request({
    type: "replay_pending_terminal_turn_event",
    ...(selector.sessionFile ? { sessionFile: selector.sessionFile } : {}),
    ...(selector.sessionId ? { sessionId: selector.sessionId } : {}),
  }).catch(() => null);
  return Boolean(response?.replayed);
}
