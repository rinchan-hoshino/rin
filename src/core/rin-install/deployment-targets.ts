import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { normalizeTargetName } from "../rin-targets/registry.js";
import { upsertTarget } from "../rin-targets/store.js";

export type LocalInstallTarget = {
  kind: "local";
  targetUser: string;
  installDir: string;
  defaultDir?: string;
};

export type SshInstallTarget = {
  kind: "ssh";
  name: string;
  host: string;
};

export type ContainerInstallTarget = {
  kind: "container";
  name: string;
  engine: "docker" | "podman";
  image: string;
};

export type InstallTargetSelection =
  | LocalInstallTarget
  | SshInstallTarget
  | ContainerInstallTarget;

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh";

export function defaultSshControlPath(targetName: string) {
  return path.join(
    os.tmpdir(),
    `rin-ssh-${normalizeTargetName(targetName) || "target"}-%C`,
  );
}

function run(command: string, args: string[], options: any = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`rin_command_failed:${command}:${result.status}`);
}

export function installExistingSshTarget(target: SshInstallTarget) {
  const controlPath = defaultSshControlPath(target.name);
  const commonArgs = [
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=10m",
    "-o",
    `ControlPath=${controlPath}`,
    target.host,
  ];
  run("ssh", [...commonArgs, "true"]);
  run("ssh", ["-tt", ...commonArgs, "sh", "-lc", INSTALL_COMMAND]);
  return upsertTarget({
    name: target.name,
    kind: "ssh",
    label: target.host,
    runtime: { kind: "ssh", host: target.host, controlPath },
    metadata: { installedBy: "rin-install", installMode: "ssh" },
  });
}

export function installContainerTarget(target: ContainerInstallTarget) {
  const engine = target.engine;
  const container = normalizeTargetName(target.name);
  if (!container) throw new Error("rin_container_name_required");
  const exists =
    spawnSync(engine, ["container", "inspect", container], {
      stdio: "ignore",
    }).status === 0;
  if (!exists) {
    run(engine, [
      "run",
      "-d",
      "--name",
      container,
      "-v",
      `${container}-rin:/home/rin/.rin`,
      "-v",
      `${container}-workspace:/workspace`,
      "-w",
      "/workspace",
      target.image,
      "sleep",
      "infinity",
    ]);
  }
  run(engine, ["exec", container, "sh", "-lc", INSTALL_COMMAND]);
  return upsertTarget({
    name: target.name,
    kind: "container",
    label: `${engine}:${container}`,
    runtime: { kind: "container", engine, container },
    metadata: { installedBy: "rin-install", image: target.image },
  });
}

export function registerLocalUserTarget(targetUser: string, name = targetUser) {
  return upsertTarget({
    name,
    kind: "local-user",
    label: targetUser,
    runtime: { kind: "local-user", user: targetUser },
    metadata: { installedBy: "rin-install" },
  });
}
