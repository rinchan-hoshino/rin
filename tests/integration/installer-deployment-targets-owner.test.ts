import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const registerFixture = path.resolve(
  "tests/support/register-deployment-targets-owner-fixture.ts",
);

const childScript = String.raw`
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

globalThis.__rinDeploymentOwnerEvents = [];
let containerExists = false;
let failNextMutation = "";
globalThis.__rinDeploymentOwnerSpawn = (command, args) => {
  const isInspect =
    (command === "docker" || command === "podman") &&
    args[0] === "container" && args[1] === "inspect";
  if (isInspect) return { status: containerExists ? 0 : 1 };
  if (failNextMutation === "error") {
    failNextMutation = "";
    return { error: new Error("owner isolated spawn failed"), status: null };
  }
  if (failNextMutation === "status") {
    failNextMutation = "";
    return { status: 17 };
  }
  return { status: 0 };
};
globalThis.__rinDeploymentOwnerCapture = () => {
  throw new Error("isolated deployment test must not execute capture commands");
};

const targets = await import(
  pathToFileURL(path.resolve("dist/core/rin-install/deployment-targets.js")).href
);
const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh";

assert.equal("installCloudTarget" in targets, false);
assert.equal("installNasTarget" in targets, false);
assert.equal("installVmTarget" in targets, false);
assert.equal("withTemporaryCloudInit" in targets, false);

const sshStart = globalThis.__rinDeploymentOwnerEvents.length;
const ssh = targets.installExistingSshTarget({
  kind: "ssh",
  name: "Owner SSH",
  host: "alice@example.test",
});
const controlPath = path.join(
  process.env.RIN_TEST_DEPLOYMENT_TMP,
  "rin-ssh-owner-ssh-%C",
);
assert.deepEqual(ssh.runtime, {
  kind: "ssh",
  host: "alice@example.test",
  controlPath,
});
const sshEvents = globalThis.__rinDeploymentOwnerEvents.slice(sshStart);
assert.deepEqual(
  sshEvents.filter(([name]) => name === "spawn").map(([, command, args]) => [command, args]),
  [
    ["ssh", [
      "-o", "ControlMaster=auto",
      "-o", "ControlPersist=10m",
      "-o", "ControlPath=" + controlPath,
      "alice@example.test", "true",
    ]],
    ["ssh", [
      "-tt",
      "-o", "ControlMaster=auto",
      "-o", "ControlPersist=10m",
      "-o", "ControlPath=" + controlPath,
      "alice@example.test", "sh", "-lc", INSTALL_COMMAND,
    ]],
  ],
);
assert.equal(sshEvents.at(-1)[0], "upsert");

const upsertsBeforeSshFailure = globalThis.__rinDeploymentOwnerEvents.filter(
  ([name]) => name === "upsert",
).length;
failNextMutation = "status";
assert.throws(
  () => targets.installExistingSshTarget({
    kind: "ssh", name: "Broken SSH", host: "broken@example.test",
  }),
  /rin_command_failed:ssh:17/,
);
assert.equal(
  globalThis.__rinDeploymentOwnerEvents.filter(([name]) => name === "upsert").length,
  upsertsBeforeSshFailure,
);

assert.throws(
  () => targets.installContainerTarget({
    kind: "container", name: "!!!", engine: "docker", image: "node:22",
  }),
  /rin_container_name_required/,
);
containerExists = false;
const containerStart = globalThis.__rinDeploymentOwnerEvents.length;
const container = targets.installContainerTarget({
  kind: "container", name: "Owner Box", engine: "docker", image: "node:22",
});
assert.equal(container.runtime.container, "owner-box");
const containerEvents = globalThis.__rinDeploymentOwnerEvents.slice(containerStart);
assert.deepEqual(
  containerEvents.filter(([name]) => name === "spawn").map(([, command, args]) => [command, args]),
  [
    ["docker", ["container", "inspect", "owner-box"]],
    ["docker", [
      "run", "-d", "--name", "owner-box",
      "-v", "owner-box-rin:/home/rin/.rin",
      "-v", "owner-box-workspace:/workspace",
      "-w", "/workspace", "node:22", "sleep", "infinity",
    ]],
    ["docker", ["exec", "owner-box", "sh", "-lc", INSTALL_COMMAND]],
  ],
);
assert.equal(containerEvents.at(-1)[0], "upsert");

containerExists = true;
const existingStart = globalThis.__rinDeploymentOwnerEvents.length;
targets.installContainerTarget({
  kind: "container", name: "Owner Box", engine: "podman", image: "node:22",
});
const existingEvents = globalThis.__rinDeploymentOwnerEvents.slice(existingStart);
assert.deepEqual(
  existingEvents.filter(([name]) => name === "spawn").map(([, command, args]) => [command, args]),
  [
    ["podman", ["container", "inspect", "owner-box"]],
    ["podman", ["exec", "owner-box", "sh", "-lc", INSTALL_COMMAND]],
  ],
);

const upsertsBeforeContainerFailure = globalThis.__rinDeploymentOwnerEvents.filter(
  ([name]) => name === "upsert",
).length;
failNextMutation = "error";
assert.throws(
  () => targets.installContainerTarget({
    kind: "container", name: "Broken Box", engine: "docker", image: "node:22",
  }),
  /owner isolated spawn failed/,
);
assert.equal(
  globalThis.__rinDeploymentOwnerEvents.filter(([name]) => name === "upsert").length,
  upsertsBeforeContainerFailure,
);

assert.deepEqual(targets.registerLocalUserTarget("alice"), {
  name: "alice",
  kind: "local-user",
  label: "alice",
  runtime: { kind: "local-user", user: "alice" },
  metadata: { installedBy: "rin-install" },
});
assert.equal(
  targets.registerLocalUserTarget("alice", "workstation").name,
  "workstation",
);

const events = globalThis.__rinDeploymentOwnerEvents;
assert.equal(events.some(([name]) => name === "capture"), false);
console.log(JSON.stringify({
  events: events.length,
  upserts: events.filter(([name]) => name === "upsert").length,
}));
`;

test("SSH and container installers stay isolated and persist only after successful commands", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-deployment-owner-"),
  );
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(tmp, { recursive: true });
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        registerFixture,
        "--input-type=module",
        "-e",
        childScript,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: tmp,
          RIN_TEST_DEPLOYMENT_HOME: home,
          RIN_TEST_DEPLOYMENT_TMP: tmp,
        },
      },
    );
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.upserts, 5);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
