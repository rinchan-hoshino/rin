import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { safeString } from "../text-utils.js";
import {
  normalizeTargetName,
  type DeploymentProviderKind,
} from "../rin-targets/registry.js";
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

export type ProvisionedInstallTarget = {
  kind: Exclude<DeploymentProviderKind, "container">;
  name: string;
  provider: string;
};

export type InstallTargetSelection =
  | LocalInstallTarget
  | SshInstallTarget
  | ContainerInstallTarget
  | ProvisionedInstallTarget;

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
  run("ssh", [
    "-tt",
    ...commonArgs,
    "sh",
    "-lc",
    "curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh",
  ]);
  return upsertTarget({
    name: target.name,
    kind: "ssh",
    label: target.host,
    runtime: { kind: "ssh", host: target.host },
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
  const installCommand =
    "curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh";
  run(engine, ["exec", container, "sh", "-lc", installCommand]);
  return upsertTarget({
    name: target.name,
    kind: "container",
    label: `${engine}:${container}`,
    runtime: { kind: "container", engine, container },
    metadata: { installedBy: "rin-install", image: target.image },
  });
}

export function provisionedTargetPendingMessage(
  target: ProvisionedInstallTarget,
) {
  const provider = safeString(target.provider).trim();
  const name = normalizeTargetName(target.name);
  return [
    `Target ${name} selected provider ${provider}.`,
    "This provider needs a provisioner adapter that creates the environment, injects cloud-init/bootstrap, and returns a runtime transport.",
    `Rin has recorded the provider shape, but ${target.kind}/${provider} is not safe to execute until its adapter has provider-specific validation and rollback.`,
  ].join("\n");
}

export function registerProvisionedTargetPlaceholder(
  target: ProvisionedInstallTarget,
) {
  return upsertTarget({
    name: target.name,
    kind: target.kind as any,
    label: `${target.kind}:${target.provider}`,
    runtime: {
      kind: "ssh",
      host: `${normalizeTargetName(target.name)}.pending`,
    },
    metadata: {
      installedBy: "rin-install",
      provider: target.provider,
      provisionerStatus: "pending-adapter",
    },
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
