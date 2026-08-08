import { resolveRuntimeProfile } from "../rin-lib/profile.js";
import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { createConfiguredAgentSession } from "../rin-lib/runtime.js";

export async function tryRunExtensionCommandCli(options: {
  argv: string[];
  installDir?: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  dependencies: {
    resolveProfile: typeof resolveRuntimeProfile;
    loadSessionManager: typeof loadRinSessionManagerModule;
    createSession: typeof createConfiguredAgentSession;
  };
}): Promise<boolean> {
  const name = String(options.argv[0] || "").trim();
  if (!name || name.startsWith("-")) return false;
  const stdout = options.stdout;
  const stderr = options.stderr;
  const profile = options.dependencies.resolveProfile({
    agentDir: options.installDir,
  });
  const { SessionManager } = await options.dependencies.loadSessionManager();
  const sessionManager = SessionManager.inMemory(profile.cwd);
  const { session, runtime } = await options.dependencies.createSession({
    cwd: profile.cwd,
    agentDir: profile.agentDir,
    sessionManager,
  });
  try {
    const command = session.extensionRunner?.getCommand?.(name);
    if (!command) return false;
    const output: string[] = [];
    session.extensionRunner.setUIContext({
      hasUI: false,
      notify(message: unknown) {
        const text = String(message || "").trim();
        if (text) output.push(text);
      },
    });
    try {
      await session.prompt(`/${options.argv.join(" ")}`, { source: "cli" });
    } catch (error) {
      stderr.write(`${String((error as Error)?.message || error)}\n`);
      process.exitCode = 1;
      return true;
    }
    if (output.length > 0) stdout.write(`${output.join("\n")}\n`);
    return true;
  } finally {
    await runtime.dispose?.();
  }
}
