import fs from "node:fs";

import type { ProcessTermination } from "../platform/process-lifetime.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";
import { runWorkerSupervisor } from "./worker-supervisor.js";

type InitialWorkerSession =
  | { kind: "new"; parentSession?: unknown }
  | { kind: "managed"; managedSessionLeaf: string; parentSession?: unknown }
  | { kind: "open"; sessionFile: string };

type WorkerResourceOptions = RinToolStartupOptions & {
  piStartupOptions?: Record<string, unknown>;
  additionalExtensionPaths?: string[];
  noExtensions?: boolean;
  extensionFlagValues?: Array<[string, boolean | string]>;
  additionalSkillPaths?: string[];
  noSkills?: boolean;
  additionalPromptTemplatePaths?: string[];
  noPromptTemplates?: boolean;
  additionalThemePaths?: string[];
  noThemes?: boolean;
  noContextFiles?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  disabledRinCapabilities?: string[];
  __rinInitialSession?: InitialWorkerSession;
};

function readValueArg(argv: string[], name: string) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value === name) return String(argv[index + 1] || "").trim();
    if (value.startsWith(`${name}=`))
      return value.slice(name.length + 1).trim();
  }
  return "";
}

function readWorkerResourceOptions(
  argv = process.argv.slice(2),
): WorkerResourceOptions {
  const filePath = readValueArg(argv, "--resource-options-file");
  if (!filePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  } finally {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
}

export function createTemporaryWorkerSessionManager(
  SessionManager: any,
  options: { cwd: string; sessionDir: string },
) {
  const sessionManager = SessionManager.inMemory(options.cwd);
  sessionManager.sessionDir = options.sessionDir;
  return sessionManager;
}

function createInitialWorkerSessionManager(
  SessionManager: any,
  options: {
    cwd: string;
    agentDir: string;
    initialSession?: InitialWorkerSession;
    getRuntimeSessionDir: (cwd: string, agentDir: string) => string;
    getManagedSessionDir: (agentDir: string, leaf: string) => string;
  },
) {
  const initial = options.initialSession;
  const runtimeSessionDir = options.getRuntimeSessionDir(
    options.cwd,
    options.agentDir,
  );
  if (!initial) {
    return createTemporaryWorkerSessionManager(SessionManager, {
      cwd: options.cwd,
      sessionDir: runtimeSessionDir,
    });
  }
  if (initial.kind === "open") {
    return SessionManager.open(initial.sessionFile, runtimeSessionDir);
  }
  const sessionDir =
    initial.kind === "managed"
      ? options.getManagedSessionDir(
          options.agentDir,
          initial.managedSessionLeaf,
        )
      : runtimeSessionDir;
  const sessionManager = SessionManager.create(options.cwd, sessionDir);
  if (initial.parentSession) {
    sessionManager.newSession({ parentSession: initial.parentSession });
  }
  return sessionManager;
}

export async function startWorker(
  options: WorkerResourceOptions = {},
  host: { terminateProcess?: ProcessTermination } = {},
) {
  const [loader, runtimeModule, profile, managedPaths, rpcMode] =
    await Promise.all([
      import("../rin-lib/loader.js"),
      import("../rin-lib/runtime.js"),
      import("../rin-lib/profile.js"),
      import("../session/managed-paths.js"),
      import("./rpc-mode.js"),
    ]);
  const sessionManagerModule = await loader.loadRinSessionManagerModule();
  const runtimeProfile = profile.resolveRuntimeProfile();
  const mergedOptions = { ...readWorkerResourceOptions(), ...options };
  const sessionManager = createInitialWorkerSessionManager(
    sessionManagerModule.SessionManager,
    {
      cwd: runtimeProfile.cwd,
      agentDir: runtimeProfile.agentDir,
      initialSession: mergedOptions.__rinInitialSession,
      getRuntimeSessionDir: profile.getRuntimeSessionDir,
      getManagedSessionDir: managedPaths.getManagedSessionDir,
    },
  );
  const { runtime } = await runtimeModule.createConfiguredAgentSession({
    cwd: runtimeProfile.cwd,
    agentDir: runtimeProfile.agentDir,
    sessionManager,
    additionalExtensionPaths: mergedOptions.additionalExtensionPaths,
    noExtensions: mergedOptions.noExtensions,
    extensionFlagValues: new Map(mergedOptions.extensionFlagValues || []),
    tools: mergedOptions.tools,
    excludeTools: mergedOptions.excludeTools,
    noTools: mergedOptions.noTools,
    additionalSkillPaths: mergedOptions.additionalSkillPaths,
    noSkills: mergedOptions.noSkills,
    additionalPromptTemplatePaths: mergedOptions.additionalPromptTemplatePaths,
    noPromptTemplates: mergedOptions.noPromptTemplates,
    additionalThemePaths: mergedOptions.additionalThemePaths,
    noThemes: mergedOptions.noThemes,
    noContextFiles: mergedOptions.noContextFiles,
    piStartupOptions: mergedOptions.piStartupOptions,
    systemPrompt: mergedOptions.systemPrompt,
    appendSystemPrompt: mergedOptions.appendSystemPrompt,
    disabledRinCapabilities: mergedOptions.disabledRinCapabilities,
  });
  await rpcMode.runCustomRpcMode(runtime, {
    SessionManager: sessionManagerModule.SessionManager,
    terminateProcess: host.terminateProcess,
  });
}

function hasArg(argv: string[], name: string) {
  return argv.some((value) => value === name);
}

type WorkerSignalHost = {
  once(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
};

export async function startWorkerProcess(host: {
  executionPath: string;
  terminateProcess: ProcessTermination;
  signals?: WorkerSignalHost;
}) {
  const argv = process.argv.slice(2);
  const resourceOptions = readWorkerResourceOptions(argv);
  if (hasArg(argv, "--execution-plane")) {
    await startWorker(resourceOptions, host);
    return;
  }
  const shutdown = new AbortController();
  const requestShutdown = () => shutdown.abort();
  const signals = host.signals ?? process;
  signals.once("SIGTERM", requestShutdown);
  signals.once("SIGINT", requestShutdown);
  try {
    await runWorkerSupervisor(resourceOptions, {
      executionPath: host.executionPath,
      signal: shutdown.signal,
    });
  } finally {
    signals.off("SIGTERM", requestShutdown);
    signals.off("SIGINT", requestShutdown);
  }
}
