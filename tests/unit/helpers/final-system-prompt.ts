import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
);

const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);
const loaderMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "loader.js")).href
);

export async function buildFinalAppSystemPrompt(options = {}) {
  const cwd = options.cwd || rootDir;
  const agentDir =
    options.agentDir ||
    fs.mkdtempSync(path.join(os.tmpdir(), "rin-final-prompt-agent-"));
  const prompt = options.prompt || "";
  const images = options.images;

  const codingAgentModule = await loaderMod.loadRinCodingAgent();
  const { SessionManager } = codingAgentModule;
  const sessionManager = SessionManager.inMemory(cwd);

  const previousRinDir = process.env.RIN_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.RIN_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;

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
    if (previousPiAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  }
}
