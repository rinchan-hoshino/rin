#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { createConfiguredAgentSession } from "../rin-lib/runtime.js";
import {
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/profile.js";
import { getManagedSessionDir } from "../session/managed-paths.js";
import { runCustomRpcMode } from "./rpc-mode.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";

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
  },
) {
  const initial = options.initialSession;
  const runtimeSessionDir = getRuntimeSessionDir(options.cwd, options.agentDir);
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
      ? getManagedSessionDir(options.agentDir, initial.managedSessionLeaf)
      : runtimeSessionDir;
  const sessionManager = SessionManager.create(options.cwd, sessionDir);
  if (initial.parentSession) {
    sessionManager.newSession({ parentSession: initial.parentSession });
  }
  return sessionManager;
}

export async function startWorker(options: WorkerResourceOptions = {}) {
  const sessionManagerModule = await loadRinSessionManagerModule();
  const runtimeProfile = resolveRuntimeProfile();
  const mergedOptions = { ...readWorkerResourceOptions(), ...options };
  const sessionManager = createInitialWorkerSessionManager(
    sessionManagerModule.SessionManager,
    {
      cwd: runtimeProfile.cwd,
      agentDir: runtimeProfile.agentDir,
      initialSession: mergedOptions.__rinInitialSession,
    },
  );
  const { runtime } = await createConfiguredAgentSession({
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
  await runCustomRpcMode(runtime, {
    SessionManager: sessionManagerModule.SessionManager,
  });
}

async function main() {
  await startWorker();
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    const message = String(
      error && error.message ? error.message : error || "rin_worker_failed",
    );
    console.error(message);
    process.exit(1);
  });
}
