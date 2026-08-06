import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);
const agentRuntimeMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "agent-runtime.js"),
  ).href
);

export async function buildFinalAppSystemPrompt(options = {}) {
  const cwd = options.cwd || rootDir;
  const agentDir =
    options.agentDir ||
    fs.mkdtempSync(path.join(os.tmpdir(), "rin-final-prompt-agent-"));
  const prompt = options.prompt || "";
  const images = options.images;

  const agentRuntimeModule = await agentRuntimeMod.loadRinAgentRuntime();
  const { SessionManager } = agentRuntimeModule;
  const sessionManager = SessionManager.inMemory(cwd);

  const previousRinDir = process.env.RIN_DIR;
  process.env.RIN_DIR = agentDir;

  try {
    const { session } = await runtimeMod.createConfiguredAgentSession({
      cwd,
      agentDir,
      sessionManager,
    });

    const baseSystemPrompt = String(
      runtimeMod.ensureSessionBaseSystemPrompt(session),
    );
    const finalSystemPrompt = baseSystemPrompt;

    return {
      session,
      baseSystemPrompt,
      finalSystemPrompt,
    };
  } finally {
    if (previousRinDir == null) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
  }
}
