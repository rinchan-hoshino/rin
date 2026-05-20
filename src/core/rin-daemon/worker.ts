#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { createConfiguredAgentSession } from "../rin-lib/runtime.js";
import { runCustomRpcMode } from "./rpc-mode.js";

type WorkerResourceOptions = {
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

export async function startWorker(options: WorkerResourceOptions = {}) {
  const sessionManagerModule = await loadRinSessionManagerModule();
  const mergedOptions = { ...readWorkerResourceOptions(), ...options };
  const { runtime } = await createConfiguredAgentSession({
    additionalExtensionPaths: mergedOptions.additionalExtensionPaths,
    noExtensions: mergedOptions.noExtensions,
    extensionFlagValues: new Map(mergedOptions.extensionFlagValues || []),
    additionalSkillPaths: mergedOptions.additionalSkillPaths,
    noSkills: mergedOptions.noSkills,
    additionalPromptTemplatePaths: mergedOptions.additionalPromptTemplatePaths,
    noPromptTemplates: mergedOptions.noPromptTemplates,
    additionalThemePaths: mergedOptions.additionalThemePaths,
    noThemes: mergedOptions.noThemes,
    noContextFiles: mergedOptions.noContextFiles,
    systemPrompt: mergedOptions.systemPrompt,
    appendSystemPrompt: mergedOptions.appendSystemPrompt,
  });
  await runCustomRpcMode(runtime, {
    SessionManager: sessionManagerModule.SessionManager,
    reuseFreshSessionForInitialNewSession: true,
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
