import {
  normalizeSessionRef,
  normalizeSessionValue,
  resolveSessionRef,
  resolveSessionValue,
} from "./ref.js";

export {
  normalizeSessionRef,
  normalizeSessionValue,
  resolveSessionRef,
  resolveSessionValue,
} from "./ref.js";

export type SessionMetadata = {
  sessionId: string;
  sessionFile: string;
  leafId: string;
  sessionName: string;
  cwd: string;
  sessionPersisted: boolean;
};

type SessionManagerLike = {
  getSessionId?: () => unknown;
  getSessionFile?: () => unknown;
  getLeafId?: () => unknown;
  getSessionName?: () => unknown;
  getCwd?: () => unknown;
  isPersisted?: () => unknown;
};

type SessionSourceLike = {
  sessionManager?: SessionManagerLike;
  sessionId?: unknown;
  sessionFile?: unknown;
  leafId?: unknown;
  sessionName?: unknown;
  cwd?: unknown;
  sessionPersisted?: unknown;
};

export function readSessionMetadata(
  source: SessionSourceLike | SessionManagerLike | null | undefined,
): SessionMetadata {
  const sessionSource =
    (source as SessionSourceLike | null | undefined) || undefined;
  const sessionManager = (sessionSource?.sessionManager ||
    source ||
    undefined) as SessionManagerLike | undefined;
  const { sessionId, sessionFile } = resolveSessionRef(
    {
      sessionId: sessionSource?.sessionId,
      sessionFile: sessionSource?.sessionFile,
    },
    {
      sessionId: sessionManager?.getSessionId?.(),
      sessionFile: sessionManager?.getSessionFile?.(),
    },
  );

  return {
    sessionId: sessionId || "",
    sessionFile: sessionFile || "",
    leafId:
      resolveSessionValue(
        sessionSource?.leafId,
        sessionManager?.getLeafId?.(),
      ) || "",
    sessionName:
      resolveSessionValue(
        sessionSource?.sessionName,
        sessionManager?.getSessionName?.(),
      ) || "",
    cwd:
      resolveSessionValue(
        sessionSource?.cwd,
        sessionManager?.getCwd?.() ?? process.cwd(),
      ) || "",
    sessionPersisted: Boolean(
      (sessionSource?.sessionPersisted ?? sessionManager?.isPersisted?.()) &&
      sessionFile,
    ),
  };
}

export function readSessionIdentity(
  source: SessionSourceLike | SessionManagerLike | null | undefined,
) {
  const metadata = readSessionMetadata(source);
  return (
    metadata.sessionFile ||
    metadata.sessionId ||
    metadata.cwd ||
    "unknown-session"
  );
}
