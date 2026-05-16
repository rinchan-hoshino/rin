import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { safeString } from "../text-utils.js";
import { shellQuote } from "../rin-lib/system.js";
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

export type CloudInstallTarget = {
  kind: "cloud";
  name: string;
  provider: "hetzner" | "digitalocean";
  token: string;
  region: string;
  size: string;
  image: string;
};

export type NasInstallTarget = {
  kind: "nas";
  name: string;
  provider: "synology" | "qnap" | "truenas-scale" | "unraid";
  host: string;
  engine: "docker" | "podman";
  image: string;
};

export type VmInstallTarget = {
  kind: "vm";
  name: string;
  provider: "multipass";
  image: string;
};

export type InstallTargetSelection =
  | LocalInstallTarget
  | SshInstallTarget
  | ContainerInstallTarget
  | CloudInstallTarget
  | NasInstallTarget
  | VmInstallTarget;

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh";

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

function capture(command: string, args: string[], options: any = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
    ...options,
  }).trim();
}

function requireCommand(command: string) {
  try {
    capture("sh", ["-lc", `command -v ${shellQuote(command)}`]);
  } catch {
    throw new Error(`rin_missing_required_tool:${command}`);
  }
}

function ensureSshKey(targetName: string) {
  const name = normalizeTargetName(targetName) || "target";
  const keyDir = path.join(os.homedir(), ".rin", "targets", "keys");
  const privateKey = path.join(keyDir, name);
  const publicKey = `${privateKey}.pub`;
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(privateKey) || !fs.existsSync(publicKey)) {
    run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", privateKey]);
  }
  return { privateKey, publicKey };
}

function writeCloudInit(targetName: string) {
  const filePath = path.join(
    os.tmpdir(),
    `rin-cloud-init-${normalizeTargetName(targetName)}.yml`,
  );
  fs.writeFileSync(
    filePath,
    [
      "#cloud-config",
      "package_update: true",
      "packages:",
      "  - curl",
      "  - nodejs",
      "  - npm",
      "runcmd:",
      `  - ${INSTALL_COMMAND}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

function waitForSsh(host: string, identityFile?: string, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const args = [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=5",
    ];
    if (identityFile) args.push("-i", identityFile);
    args.push(host, "true");
    const result = spawnSync("ssh", args, { stdio: "ignore" });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  throw new Error(`rin_ssh_not_ready:${host}`);
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

export function installCloudTarget(target: CloudInstallTarget) {
  if (target.provider === "hetzner") return installHetznerTarget(target);
  if (target.provider === "digitalocean")
    return installDigitalOceanTarget(target);
  throw new Error(`rin_cloud_provider_not_implemented:${target.provider}`);
}

function installHetznerTarget(target: CloudInstallTarget) {
  requireCommand("hcloud");
  const { privateKey, publicKey } = ensureSshKey(target.name);
  const cloudInit = writeCloudInit(target.name);
  const env = { ...process.env, HCLOUD_TOKEN: target.token };
  const keyName = `rin-${normalizeTargetName(target.name)}`;
  spawnSync(
    "hcloud",
    [
      "ssh-key",
      "create",
      "--name",
      keyName,
      "--public-key-from-file",
      publicKey,
    ],
    { stdio: "ignore", env },
  );
  run(
    "hcloud",
    [
      "server",
      "create",
      "--name",
      normalizeTargetName(target.name),
      "--type",
      target.size,
      "--image",
      target.image,
      "--location",
      target.region,
      "--ssh-key",
      keyName,
      "--user-data-from-file",
      cloudInit,
    ],
    { env },
  );
  const ip = capture(
    "hcloud",
    ["server", "ip", normalizeTargetName(target.name), "-o", "noheader"],
    { env },
  );
  waitForSsh(`root@${ip}`, privateKey);
  run("ssh", ["-i", privateKey, `root@${ip}`, "sh", "-lc", INSTALL_COMMAND]);
  return upsertTarget({
    name: target.name,
    kind: "cloud",
    label: `Hetzner ${ip}`,
    runtime: { kind: "ssh", host: ip, user: "root", identityFile: privateKey },
    metadata: {
      provider: target.provider,
      region: target.region,
      size: target.size,
    },
  });
}

function installDigitalOceanTarget(target: CloudInstallTarget) {
  requireCommand("doctl");
  const { privateKey, publicKey } = ensureSshKey(target.name);
  const cloudInit = writeCloudInit(target.name);
  const env = { ...process.env, DIGITALOCEAN_ACCESS_TOKEN: target.token };
  const keyName = `rin-${normalizeTargetName(target.name)}`;
  spawnSync(
    "doctl",
    ["compute", "ssh-key", "import", keyName, "--public-key-file", publicKey],
    { stdio: "ignore", env },
  );
  const keyId = capture(
    "doctl",
    ["compute", "ssh-key", "list", "--format", "ID,Name", "--no-header"],
    { env },
  )
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 2))
    .find(([, name]) => name === keyName)?.[0];
  if (!keyId) throw new Error("rin_digitalocean_ssh_key_not_found");
  run(
    "doctl",
    [
      "compute",
      "droplet",
      "create",
      normalizeTargetName(target.name),
      "--region",
      target.region,
      "--size",
      target.size,
      "--image",
      target.image,
      "--ssh-keys",
      keyId,
      "--user-data-file",
      cloudInit,
      "--wait",
    ],
    { env },
  );
  const ip = capture(
    "doctl",
    [
      "compute",
      "droplet",
      "get",
      normalizeTargetName(target.name),
      "--format",
      "PublicIPv4",
      "--no-header",
    ],
    { env },
  );
  waitForSsh(`root@${ip}`, privateKey);
  run("ssh", ["-i", privateKey, `root@${ip}`, "sh", "-lc", INSTALL_COMMAND]);
  return upsertTarget({
    name: target.name,
    kind: "cloud",
    label: `DigitalOcean ${ip}`,
    runtime: { kind: "ssh", host: ip, user: "root", identityFile: privateKey },
    metadata: {
      provider: target.provider,
      region: target.region,
      size: target.size,
    },
  });
}

export function installNasTarget(target: NasInstallTarget) {
  const container = normalizeTargetName(target.name);
  const remoteRun = [
    `${target.engine} container inspect ${shellQuote(container)} >/dev/null 2>&1 || ${target.engine} run -d --name ${shellQuote(container)} -v ${shellQuote(`${container}-rin`)}:/home/rin/.rin -v ${shellQuote(`${container}-workspace`)}:/workspace -w /workspace ${shellQuote(target.image)} sleep infinity`,
    `${target.engine} exec ${shellQuote(container)} sh -lc ${shellQuote(INSTALL_COMMAND)}`,
  ].join(" && ");
  run("ssh", [target.host, "sh", "-lc", remoteRun]);
  return upsertTarget({
    name: target.name,
    kind: "nas",
    label: `${target.provider}:${target.host}`,
    runtime: {
      kind: "command",
      command: "ssh",
      argsBeforeRin: [target.host, target.engine, "exec", container],
    },
    metadata: {
      provider: target.provider,
      engine: target.engine,
      image: target.image,
    },
  });
}

export function installVmTarget(target: VmInstallTarget) {
  requireCommand("multipass");
  const name = normalizeTargetName(target.name);
  const cloudInit = writeCloudInit(target.name);
  const exists =
    spawnSync("multipass", ["info", name], { stdio: "ignore" }).status === 0;
  if (!exists) {
    run("multipass", [
      "launch",
      target.image,
      "--name",
      name,
      "--cloud-init",
      cloudInit,
    ]);
  }
  run("multipass", ["exec", name, "--", "sh", "-lc", INSTALL_COMMAND]);
  return upsertTarget({
    name: target.name,
    kind: "vm",
    label: `Multipass ${name}`,
    runtime: {
      kind: "command",
      command: "multipass",
      argsBeforeRin: ["exec", name, "--"],
    },
    metadata: { provider: target.provider, image: target.image },
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
