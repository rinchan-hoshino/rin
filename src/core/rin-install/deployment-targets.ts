import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  isValidContainerImageReference,
  normalizeTargetName,
} from "../rin-targets/registry.js";
import { upsertTarget } from "../rin-targets/store.js";

export type LocalInstallTarget = {
  kind: "local";
  targetUser: string;
  installDir: string;
  defaultDir?: string;
  createSystemUser?: boolean;
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
  const commonOptions = [
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=10m",
    "-o",
    `ControlPath=${controlPath}`,
  ];
  run("ssh", [...commonOptions, "--", target.host, "true"]);
  run("ssh", ["-tt", ...commonOptions, "--", target.host, INSTALL_COMMAND]);
  return upsertTarget({
    name: target.name,
    kind: "ssh",
    label: target.host,
    runtime: { kind: "ssh", host: target.host, controlPath },
    metadata: { installedBy: "rin-install", installMode: "ssh" },
  });
}

export function installContainerTarget(
  target: ContainerInstallTarget,
  io: { stdinIsTTY?: boolean; stdoutIsTTY?: boolean } = {},
) {
  const engine = target.engine;
  const container = normalizeTargetName(target.name);
  if (!container) throw new Error("rin_container_name_required");
  const image = String(target.image || "").trim();
  if (!isValidContainerImageReference(image)) {
    throw new Error("rin_container_image_invalid");
  }
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
      "--user",
      "root",
      "-v",
      `${container}-rin:/root/.rin`,
      "-v",
      `${container}-workspace:/workspace`,
      "-w",
      "/workspace",
      image,
      "sleep",
      "infinity",
    ]);
  }
  const execArgs = ["exec"];
  if (io.stdinIsTTY ?? process.stdin.isTTY) execArgs.push("-i");
  if (io.stdoutIsTTY ?? process.stdout.isTTY) execArgs.push("-t");
  execArgs.push("-u", "root");
  run(engine, [...execArgs, container, "sh", "-lc", INSTALL_COMMAND]);
  return upsertTarget({
    name: target.name,
    kind: "container",
    label: `${engine}:${container}`,
    runtime: {
      kind: "container",
      engine,
      container,
      user: "root",
      installDir: "/root/.rin",
    },
    metadata: { installedBy: "rin-install", image },
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
