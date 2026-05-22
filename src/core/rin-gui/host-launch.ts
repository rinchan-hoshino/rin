export type DesktopHostLaunch = {
  command: string;
  args: string[];
};

export const DEFAULT_RIN_DESKTOP_HOST = "rin-desktop-host";

function splitDesktopHostCommand(value: string) {
  return value.trim().split(/\s+/).filter(Boolean);
}

function resolveDesktopHostCommand(
  env: NodeJS.ProcessEnv,
  envNames: readonly string[],
  defaultCommand = DEFAULT_RIN_DESKTOP_HOST,
) {
  for (const envName of envNames) {
    const value = String(env[envName] || "").trim();
    if (value) return value;
  }
  return defaultCommand;
}

export function buildDesktopHostLaunch(
  env: NodeJS.ProcessEnv,
  envNames: readonly string[],
  trailingArgs: readonly string[],
  defaultCommand = DEFAULT_RIN_DESKTOP_HOST,
): DesktopHostLaunch {
  const parts = splitDesktopHostCommand(
    resolveDesktopHostCommand(env, envNames, defaultCommand),
  );
  const command = parts.shift() || DEFAULT_RIN_DESKTOP_HOST;
  return { command, args: [...parts, ...trailingArgs] };
}
