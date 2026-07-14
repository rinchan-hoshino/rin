import { spawnSync } from "node:child_process";

export function networkIsolatedNodeInvocation(
  nodeArgs: string[],
  env: NodeJS.ProcessEnv,
  options: { commandExists?: (command: string) => boolean } = {},
) {
  if (
    env.RIN_TEST_NETWORK_NAMESPACE_INNER === "1" ||
    env.RIN_SYSTEM_TEST_CONTAINER_INNER === "1"
  ) {
    return { command: process.execPath, args: nodeArgs, env };
  }
  if (process.platform !== "linux") {
    throw new Error(
      "network_isolation_unavailable:run tests through the networkless local-CI container",
    );
  }
  const commandExists =
    options.commandExists ??
    ((command: string) => {
      const probe = spawnSync("sh", ["-c", `command -v ${command}`], {
        encoding: "utf8",
      });
      return probe.status === 0;
    });
  for (const command of ["unshare", "ip"]) {
    if (!commandExists(command)) {
      throw new Error(`network_isolation_command_missing:${command}`);
    }
  }
  return {
    command: "unshare",
    args: [
      "--user",
      "--map-root-user",
      "--net",
      "sh",
      "-c",
      'ip link set lo up && exec "$@"',
      "rin-test-network",
      process.execPath,
      ...nodeArgs,
    ],
    env: { ...env, RIN_TEST_NETWORK_NAMESPACE_INNER: "1" },
  };
}
