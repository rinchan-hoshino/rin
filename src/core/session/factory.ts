import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import {
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/profile.js";
import { updateSessionCatalogFromSessionManagerSync } from "./catalog.js";
import { normalizeBoundSessionList } from "./listing.js";
import {
  listBoundSessionPage as listFastBoundSessionPage,
  type BoundSessionPage,
} from "./paged-listing.js";
import {
  requireExistingSessionFile,
  requireSessionFile,
  readSessionFile,
  type SessionFileInput,
} from "./ref.js";

export async function openBoundSession(options: {
  cwd: string;
  agentDir: string;
  additionalExtensionPaths?: string[];
  disabledRinCapabilities?: string[];
  sessionFile?: string;
  sessionManager?: any;
  thinkingLevel?: any;
}) {
  const { SessionManager } = await loadRinSessionManagerModule();
  const sessionDir = getRuntimeSessionDir(options.cwd, options.agentDir);
  const sessionFile = readSessionFile(options.sessionFile);
  const sessionManager =
    options.sessionManager ||
    (sessionFile
      ? SessionManager.open(requireExistingSessionFile(sessionFile), sessionDir)
      : SessionManager.create(options.cwd, sessionDir));
  const { createConfiguredAgentSession } =
    await import("../rin-lib/runtime.js");
  return await createConfiguredAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths ?? [],
    disabledRinCapabilities: options.disabledRinCapabilities,
    sessionManager,
    thinkingLevel: options.thinkingLevel,
  });
}

export async function listBoundSessionPage(
  options: {
    cwd?: string;
    agentDir?: string;
    sessionDir?: string;
    limit?: unknown;
    offset?: unknown;
  } = {},
): Promise<BoundSessionPage> {
  const { cwd, agentDir } = resolveRuntimeProfile(options);
  const sessionDir = options.sessionDir || getRuntimeSessionDir(cwd, agentDir);
  const page = await listFastBoundSessionPage({
    sessionDir,
    cwd,
    limit: options.limit,
    offset: options.offset,
  });
  return {
    ...page,
    sessions: normalizeBoundSessionList(page.sessions),
  };
}

export async function listBoundSessions(
  options: {
    cwd?: string;
    agentDir?: string;
    sessionDir?: string;
    SessionManager?: any;
    limit?: unknown;
    offset?: unknown;
  } = {},
) {
  if (options.limit !== undefined || options.offset !== undefined) {
    return (await listBoundSessionPage(options)).sessions;
  }
  const { cwd, agentDir } = resolveRuntimeProfile(options);
  const sessionDir = options.sessionDir || getRuntimeSessionDir(cwd, agentDir);
  const { SessionManager } = options.SessionManager
    ? { SessionManager: options.SessionManager }
    : await loadRinSessionManagerModule();
  const sessions = await SessionManager.list(cwd, sessionDir).catch(() => []);
  return normalizeBoundSessionList(sessions);
}

export async function renameBoundSession(
  session: SessionFileInput,
  name: string,
  options: { SessionManager?: any } = {},
) {
  const sessionFile = requireSessionFile(session);
  const nextName = String(name || "").trim();
  if (!nextName) throw new Error("Session name cannot be empty");
  const { SessionManager } = options.SessionManager
    ? { SessionManager: options.SessionManager }
    : await loadRinSessionManagerModule();
  const manager = SessionManager.open(sessionFile);
  manager.appendSessionInfo(nextName);
  updateSessionCatalogFromSessionManagerSync(manager);
}
