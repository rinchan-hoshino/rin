import fsSync from "node:fs";

import type { AuthResult } from "@earendil-works/pi-ai";
import { compact } from "@earendil-works/pi-coding-agent";

import { updateSessionCatalogFromSessionManagerSync } from "../session/catalog.js";
import { normalizeFrontendIdentity } from "../rin-frontend-sdk/frontend-identity.js";

// This file is Rin's controlled seam for Pi AgentSession/SessionManager
// implementation details. Product code should call these semantic helpers
// instead of reaching into Pi private fields directly.

type AnyFn = (...args: any[]) => any;

const PI_SESSION_PRIVATE = {
  baseSystemPrompt: "_baseSystemPrompt",
  baseSystemPromptOptions: "_baseSystemPromptOptions",
  buildIndex: "_buildIndex",
  checkCompaction: "_checkCompaction",
  emit: "_emit",
  extensionCommandContextActions: "_extensionCommandContextActions",
  extensionRunner: "_extensionRunner",
  extensionMode: "_extensionMode",
  extensionShutdownHandler: "_extensionShutdownHandler",
  extensionUIContext: "_extensionUIContext",
  persist: "_persist",
  rebuildSystemPrompt: "_rebuildSystemPrompt",
  refreshToolRegistry: "_refreshToolRegistry",
  resourceLoader: "_resourceLoader",
  runAgentPrompt: "_runAgentPrompt",
  rewriteFile: "_rewriteFile",
  runAutoCompaction: "_runAutoCompaction",
  summarizationRetryCallbacks: "_summarizationRetryCallbacks",
} as const;

const RIN_SESSION_CONVERSATION_PERSIST_KEY = Symbol.for(
  "rin.sessionConversationPersist",
);

function bindMethod<T extends AnyFn = AnyFn>(target: any, key: string) {
  const value = target?.[key];
  return typeof value === "function" ? (value.bind(target) as T) : undefined;
}

function replaceMethod(target: any, key: string, replacement: AnyFn) {
  if (!target || typeof target !== "object") return false;
  target[key] = replacement;
  return true;
}

export type PiExtensionMode = "tui" | "rpc" | "json" | "print";

const PI_EXTENSION_MODES = new Set<PiExtensionMode>([
  "tui",
  "rpc",
  "json",
  "print",
]);

function normalizePiExtensionMode(value: unknown): PiExtensionMode {
  const text = String(value || "").trim();
  return PI_EXTENSION_MODES.has(text as PiExtensionMode)
    ? (text as PiExtensionMode)
    : "print";
}

export function readPiSessionBaseSystemPrompt(session: any) {
  return String(
    session?.[PI_SESSION_PRIVATE.baseSystemPrompt] ||
      session?.agent?.state?.systemPrompt ||
      "",
  );
}

export function readPiSessionBaseSystemPromptOptions(
  session: any,
  fallbackCwd = "",
) {
  const value = session?.[PI_SESSION_PRIVATE.baseSystemPromptOptions];
  if (value && typeof value === "object") return value;
  const cwd = String(fallbackCwd || "").trim();
  return cwd ? { cwd } : {};
}

export function writePiSessionBaseSystemPrompt(
  session: any,
  systemPrompt: string,
) {
  if (!session || typeof session !== "object") return;
  const next = String(systemPrompt || "");
  session[PI_SESSION_PRIVATE.baseSystemPrompt] = next;
  if (session.agent?.state && typeof session.agent.state === "object") {
    session.agent.state.systemPrompt = next;
  }
  if (typeof session.agent?.setSystemPrompt === "function") {
    session.agent.setSystemPrompt(next);
  }
}

export function getPiSessionResourcePromptState(session: any) {
  const resourceLoader =
    session?.resourceLoader ?? session?.[PI_SESSION_PRIVATE.resourceLoader];
  const appendSystemPrompt = resourceLoader?.getAppendSystemPrompt?.();
  const skills = resourceLoader?.getSkills?.()?.skills;
  const agentsFiles = resourceLoader?.getAgentsFiles?.()?.agentsFiles;
  return {
    agentDir: String(resourceLoader?.agentDir || ""),
    systemPrompt: String(resourceLoader?.getSystemPrompt?.() || ""),
    appendSystemPrompt: Array.isArray(appendSystemPrompt)
      ? appendSystemPrompt
      : [],
    skills: Array.isArray(skills) ? skills : [],
    agentsFiles: Array.isArray(agentsFiles) ? agentsFiles : [],
  };
}

export function bindPiSessionSystemPromptRebuilder(session: any) {
  return bindMethod(session, PI_SESSION_PRIVATE.rebuildSystemPrompt);
}

export function replacePiSessionSystemPromptRebuilder(
  session: any,
  replacement: AnyFn,
) {
  return replaceMethod(
    session,
    PI_SESSION_PRIVATE.rebuildSystemPrompt,
    replacement,
  );
}

export function bindPiSessionCompactionChecker(session: any) {
  return bindMethod(session, PI_SESSION_PRIVATE.checkCompaction);
}

export function replacePiSessionCompactionChecker(
  session: any,
  replacement: AnyFn,
) {
  return replaceMethod(
    session,
    PI_SESSION_PRIVATE.checkCompaction,
    replacement,
  );
}

export function bindPiSessionAutoCompactor(session: any) {
  return bindMethod(session, PI_SESSION_PRIVATE.runAutoCompaction);
}

export function replacePiSessionAutoCompactor(
  session: any,
  replacement: AnyFn,
) {
  return replaceMethod(
    session,
    PI_SESSION_PRIVATE.runAutoCompaction,
    replacement,
  );
}

export function runPiSessionAutoCompaction(
  session: any,
  reason: string,
  willRetry: boolean,
) {
  return session?.[PI_SESSION_PRIVATE.runAutoCompaction]?.(reason, willRetry);
}

function computePiCompactionFileDetails(fileOps: any) {
  const read = new Set<string>(fileOps?.read || []);
  const modified = new Set<string>([
    ...(fileOps?.edited || []),
    ...(fileOps?.written || []),
  ]);
  return {
    readFiles: [...read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

export async function runPiNativeCompactionWithoutFileSummary(
  session: any,
  event: any,
) {
  const model = session?.model;
  if (!model)
    throw new Error("Pi AgentSession compaction model is unavailable");
  const getRequestAuth = session?.modelRuntime?.getAuth;
  if (typeof getRequestAuth !== "function") {
    throw new Error("Pi AgentSession model runtime auth is unavailable");
  }
  let requestAuth: AuthResult | undefined;
  try {
    requestAuth = await getRequestAuth.call(session.modelRuntime, model);
  } catch (error) {
    if (typeof session?.agent?.streamFunction !== "function") throw error;
  }
  const headers = requestAuth?.auth?.headers
    ? Object.fromEntries(
        Object.entries(requestAuth.auth.headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
  const apiKey = requestAuth?.auth?.apiKey;
  const env = requestAuth?.env;
  const details = computePiCompactionFileDetails(event?.preparation?.fileOps);
  const retryCallbacks = bindMethod(
    session,
    PI_SESSION_PRIVATE.summarizationRetryCallbacks,
  )?.({ source: "compaction", reason: event?.reason });
  const result = await compact(
    {
      ...event.preparation,
      fileOps: {
        read: new Set<string>(),
        written: new Set<string>(),
        edited: new Set<string>(),
      },
    },
    model,
    apiKey,
    headers,
    event?.customInstructions,
    event?.signal,
    session?.thinkingLevel,
    session?.agent?.streamFunction,
    env,
    session?.settingsManager?.getRetrySettings?.(),
    retryCallbacks,
  );
  return { ...result, details };
}

export function bindPiSessionToolRegistryRefresher(session: any) {
  return bindMethod(session, PI_SESSION_PRIVATE.refreshToolRegistry);
}

export function replacePiSessionToolRegistryRefresher(
  session: any,
  replacement: AnyFn,
) {
  return replaceMethod(
    session,
    PI_SESSION_PRIVATE.refreshToolRegistry,
    replacement,
  );
}

export function refreshPiSessionToolRegistry(session: any) {
  return session?.[PI_SESSION_PRIVATE.refreshToolRegistry]?.();
}

export function emitPiSessionEvent(session: any, event: any) {
  return session?.[PI_SESSION_PRIVATE.emit]?.(event);
}

export async function resumePiSessionTurn(
  session: any,
  invocationContext?: {
    source?: unknown;
    frontendIdentity?: unknown;
    promptContext?: unknown;
  },
) {
  const sessionManager = session?.sessionManager;
  if (sessionManager && invocationContext) {
    sessionManager.__rinLastPromptSource = String(
      invocationContext.source || "",
    ).trim();
    sessionManager.__rinLastPromptContext = invocationContext.promptContext;
    const frontendIdentity = normalizeFrontendIdentity(
      invocationContext.frontendIdentity,
    );
    if (frontendIdentity) {
      sessionManager.__rinFrontend = frontendIdentity;
    } else {
      delete sessionManager.__rinFrontend;
    }
  }
  const runAgentPrompt = bindMethod(session, PI_SESSION_PRIVATE.runAgentPrompt);
  if (!runAgentPrompt) {
    throw new Error("Pi AgentSession continuation runner is unavailable");
  }
  const messages = session?.agent?.state?.messages;
  const lastMessage = Array.isArray(messages) ? messages.at(-1) : undefined;
  if (lastMessage?.role !== "user" && lastMessage?.role !== "toolResult") {
    throw new Error("Pi AgentSession transcript is not continuable");
  }
  // Pi has no public session-level continuation. An empty message list starts
  // its session runner without persisting synthetic user or custom history.
  await runAgentPrompt([]);
}

export function getPiExtensionRunner(session: any) {
  return (
    session?.extensionRunner ?? session?.[PI_SESSION_PRIVATE.extensionRunner]
  );
}

export function getPiSessionExtensionMode(session: any): PiExtensionMode {
  const runner = getPiExtensionRunner(session);
  return normalizePiExtensionMode(
    runner?.mode ?? session?.[PI_SESSION_PRIVATE.extensionMode],
  );
}

export function shutdownPiSessionExtensionHost(session: any) {
  return session?.[PI_SESSION_PRIVATE.extensionShutdownHandler]?.();
}

export function getPiSessionExtensionUIContext(session: any) {
  return session?.[PI_SESSION_PRIVATE.extensionUIContext];
}

export function getPiSessionExtensionCommandContextActions(session: any) {
  return session?.[PI_SESSION_PRIVATE.extensionCommandContextActions];
}

function hasConversationMessageEntry(entries: unknown) {
  return Array.isArray(entries)
    ? entries.some(
        (entry: any) =>
          entry?.type === "message" &&
          (entry?.message?.role === "user" ||
            entry?.message?.role === "assistant"),
      )
    : false;
}

export function patchPiSessionManagerConversationPersistence(
  sessionManager: any,
) {
  if (!sessionManager || typeof sessionManager !== "object") return;
  if (sessionManager[RIN_SESSION_CONVERSATION_PERSIST_KEY]) return;
  const originalRewriteFile = bindMethod(
    sessionManager,
    PI_SESSION_PRIVATE.rewriteFile,
  );
  const originalPersist = bindMethod(
    sessionManager,
    PI_SESSION_PRIVATE.persist,
  );
  if (originalRewriteFile) {
    sessionManager[PI_SESSION_PRIVATE.rewriteFile] = (...args: any[]) => {
      if (
        sessionManager.isPersisted?.() !== false &&
        !hasConversationMessageEntry(sessionManager.fileEntries)
      ) {
        sessionManager.flushed = false;
        return;
      }
      const result = originalRewriteFile(...args);
      updateSessionCatalogFromSessionManagerSync(sessionManager);
      return result;
    };
  }
  if (originalPersist) {
    sessionManager[PI_SESSION_PRIVATE.persist] = (...args: any[]) => {
      const result = originalPersist(...args);
      if (
        sessionManager.isPersisted?.() !== false &&
        hasConversationMessageEntry(sessionManager.fileEntries) &&
        sessionManager.sessionFile &&
        !fsSync.existsSync(sessionManager.sessionFile)
      ) {
        originalRewriteFile?.();
        sessionManager.flushed = true;
      }
      updateSessionCatalogFromSessionManagerSync(sessionManager);
      return result;
    };
  }
  sessionManager[RIN_SESSION_CONVERSATION_PERSIST_KEY] = {
    originalRewriteFile,
    originalPersist,
  };
}

export function bindPiSessionManagerFileRewriter(sessionManager: any) {
  return bindMethod(sessionManager, PI_SESSION_PRIVATE.rewriteFile);
}

export function rewritePiSessionManagerFile(sessionManager: any) {
  return bindPiSessionManagerFileRewriter(sessionManager)?.();
}

export function buildPiSessionManagerIndex(sessionManager: any) {
  return sessionManager?.[PI_SESSION_PRIVATE.buildIndex]?.();
}

export function seedPiInMemorySessionManager(
  sessionManager: any,
  entries: readonly Record<string, any>[],
) {
  if (sessionManager?.isPersisted?.() !== false) {
    throw new Error("Pi session seeding requires a non-persisted manager");
  }
  const header = sessionManager.getHeader?.();
  if (!header) throw new Error("Pi session seeding requires a session header");
  sessionManager.fileEntries = [header, ...entries];
  buildPiSessionManagerIndex(sessionManager);
}
