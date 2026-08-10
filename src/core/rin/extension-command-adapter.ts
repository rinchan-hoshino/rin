import { resolveRuntimeProfile } from "../rin-lib/profile.js";
import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { createConfiguredAgentSession } from "../rin-lib/runtime.js";

type ExtensionCommandCliDependencies = {
  resolveProfile: typeof resolveRuntimeProfile;
  loadSessionManager: typeof loadRinSessionManagerModule;
  createSession: typeof createConfiguredAgentSession;
};

type ExtensionCommandCliOptions = {
  argv: string[];
  installDir?: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  dependencies: ExtensionCommandCliDependencies;
};

async function createExtensionCommandSession(
  options: Pick<ExtensionCommandCliOptions, "installDir" | "dependencies">,
) {
  const profile = options.dependencies.resolveProfile({
    agentDir: options.installDir,
  });
  const { SessionManager } = await options.dependencies.loadSessionManager();
  const sessionManager = SessionManager.inMemory(profile.cwd);
  return await options.dependencies.createSession({
    cwd: profile.cwd,
    agentDir: profile.agentDir,
    sessionManager,
  });
}

export async function listExtensionCliCommands(
  options: Pick<ExtensionCommandCliOptions, "installDir" | "dependencies">,
): Promise<Array<readonly [string, string]>> {
  const { session, runtime } = await createExtensionCommandSession(options);
  try {
    return (session.extensionRunner?.getRegisteredCommands?.() || [])
      .map((command): readonly [string, string] => [
        String(command.invocationName || command.name || "").trim(),
        String(command.description || "Pi extension command").trim(),
      ])
      .filter(([name]) => Boolean(name))
      .sort(([left], [right]) => left.localeCompare(right));
  } finally {
    await runtime.dispose?.();
  }
}

export async function tryRunExtensionCommandCli(
  options: ExtensionCommandCliOptions,
): Promise<boolean> {
  const name = String(options.argv[0] || "").trim();
  if (!name || name.startsWith("-")) return false;
  const stdout = options.stdout;
  const stderr = options.stderr;
  const { session, runtime } = await createExtensionCommandSession(options);
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
