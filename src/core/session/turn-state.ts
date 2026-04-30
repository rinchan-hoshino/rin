import fs from "node:fs";
import path from "node:path";

import { safeString } from "../text-utils.js";

export const SESSION_TURN_STATE_ENTRY_TYPE = "rin-turn-state";

export type SessionTurnStateStatus = "active" | "completed" | "aborted";
export type TerminalSessionTurnStateStatus = "completed" | "aborted";

export type SessionTurnState = {
  status: SessionTurnStateStatus;
  timestamp: string;
  reason?: string;
};

const VALID_TURN_STATES = new Set<SessionTurnStateStatus>([
  "active",
  "completed",
  "aborted",
]);

const TERMINAL_TURN_STATES = new Set<SessionTurnStateStatus>([
  "completed",
  "aborted",
]);

export function appendSessionTurnState(
  session: any,
  status: TerminalSessionTurnStateStatus,
) {
  if (!session?.sessionManager?.appendCustomEntry) return;
  session.sessionManager.appendCustomEntry(SESSION_TURN_STATE_ENTRY_TYPE, {
    status,
    timestamp: new Date().toISOString(),
  });
}

function normalizeTurnState(value: unknown): SessionTurnState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = (value as any).data;
  const status = safeString(data?.status).trim() as SessionTurnStateStatus;
  if (!VALID_TURN_STATES.has(status)) return undefined;
  const reason = safeString(data?.reason).trim();
  return {
    status,
    timestamp: safeString(data?.timestamp).trim(),
    ...(reason ? { reason } : {}),
  };
}

function isMessageEntry(entry: any) {
  return entry?.type === "message";
}

function forEachSessionFileEntry(
  sessionFile: string,
  visitor: (entry: any) => void,
): boolean {
  try {
    const text = fs.readFileSync(sessionFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        visitor(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function readSessionTurnStateDetails(sessionFile: string):
  | {
      latest?: SessionTurnState;
      hasMessageAfterLatestState: boolean;
    }
  | undefined {
  let latest: SessionTurnState | undefined;
  let hasMessageAfterLatestState = false;
  if (
    !forEachSessionFileEntry(sessionFile, (entry) => {
      if (
        entry?.type === "custom" &&
        entry?.customType === SESSION_TURN_STATE_ENTRY_TYPE
      ) {
        latest = normalizeTurnState(entry) ?? latest;
        hasMessageAfterLatestState = false;
        return;
      }
      if (isMessageEntry(entry)) hasMessageAfterLatestState = true;
    })
  ) {
    return undefined;
  }
  return { latest, hasMessageAfterLatestState };
}

export function readSessionTurnState(
  sessionFile: string,
): SessionTurnState | undefined {
  return readSessionTurnStateDetails(sessionFile)?.latest;
}

export function shouldContinueInterruptedTurn(
  sessionFile: string,
  _options?: { terminalBaselineTimestamp?: string },
) {
  const tail = readLastTurnDecisionEntry(sessionFile);
  if (!tail) return false;
  if (tail.kind === "state") {
    return !TERMINAL_TURN_STATES.has(tail.state.status);
  }
  return !isTerminalLegacyTailEntry(tail.entry);
}

export function listSessionFiles(sessionDir: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  };
  visit(sessionDir);
  return result.sort();
}

export function listContinuableInterruptedTurnSessionFiles(
  sessionDir: string,
  options?: { terminalBaselineTimestamp?: string },
): string[] {
  return listSessionFiles(sessionDir).filter((sessionFile) =>
    shouldContinueInterruptedTurn(sessionFile, options),
  );
}

function hasToolCallContent(content: unknown) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    return (
      safeString((part as any).type)
        .trim()
        .toLowerCase() === "toolcall"
    );
  });
}

function isTerminalLegacyTailEntry(entry: any) {
  if (entry?.type !== "message") return false;
  const message = entry?.message;
  const role = safeString(message?.role).trim();
  if (role !== "assistant") return false;
  return !hasToolCallContent(message?.content);
}

function isTerminalBaselineState(state: SessionTurnState | undefined) {
  return state?.reason === "terminal-state-baseline";
}

function readLastTurnDecisionEntry(
  sessionFile: string,
):
  | { kind: "message"; entry: any }
  | { kind: "state"; state: SessionTurnState }
  | undefined {
  let lastEntry:
    | { kind: "message"; entry: any }
    | { kind: "state"; state: SessionTurnState }
    | undefined;
  if (
    !forEachSessionFileEntry(sessionFile, (entry) => {
      if (isMessageEntry(entry)) {
        lastEntry = { kind: "message", entry };
        return;
      }
      if (
        entry?.type === "custom" &&
        entry?.customType === SESSION_TURN_STATE_ENTRY_TYPE
      ) {
        const state = normalizeTurnState(entry);
        if (!state || isTerminalBaselineState(state)) return;
        lastEntry = { kind: "state", state };
      }
    })
  ) {
    return undefined;
  }
  return lastEntry;
}

function readTerminalBaselineTimestamp(baselineFile: string) {
  try {
    const line = fs.readFileSync(baselineFile, "utf8").split(/\r?\n/, 1)[0];
    const timestamp = safeString(JSON.parse(line)?.timestamp).trim();
    return timestamp || undefined;
  } catch {
    return undefined;
  }
}

export function initializeTerminalTurnStateBaseline(
  sessionDir: string,
  baselineFile: string,
) {
  const existingTimestamp = readTerminalBaselineTimestamp(baselineFile);
  if (existingTimestamp) return existingTimestamp;
  const timestamp = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(
      baselineFile,
      `${JSON.stringify({ version: 1, timestamp, sessionDir })}\n`,
    );
  } catch {}
  return timestamp;
}
