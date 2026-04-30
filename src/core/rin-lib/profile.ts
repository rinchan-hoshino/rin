import os from "node:os";
import path from "node:path";

export const RIN_DIR_ENV = "RIN_DIR";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export function resolveRuntimeProfile(
  options: { cwd?: string; agentDir?: string } = {},
) {
  const cwd = options.cwd || os.homedir();
  const agentDir =
    options.agentDir ||
    process.env[RIN_DIR_ENV]?.trim() ||
    process.env[PI_AGENT_DIR_ENV]?.trim() ||
    path.join(os.homedir(), ".rin");
  return { cwd, agentDir };
}

export function applyRuntimeProfileEnvironment(profile: { agentDir: string }) {
  if (profile.agentDir) {
    process.env[PI_AGENT_DIR_ENV] = profile.agentDir;
  }
}

export function getRuntimeSessionDir(_cwd: string, agentDir: string) {
  return path.join(agentDir, "sessions");
}
