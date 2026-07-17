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
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

globalThis.__rinDeploymentOwnerEvents = [];
let missingCommand = "";
let inspectExists = false;
let vmExists = false;
let failMode = "";
globalThis.__rinDeploymentOwnerSpawn = (command, args) => {
  const isProbe =
    ((command === "docker" || command === "podman") && args[0] === "container" && args[1] === "inspect") ||
    (command === "multipass" && args[0] === "info");
  if (!isProbe && failMode === "error") { failMode = ""; return { error: new Error("owner spawn failed"), status: null }; }
  if (!isProbe && failMode === "status") { failMode = ""; return { status: 17 }; }
  if ((command === "docker" || command === "podman") && args[0] === "container" && args[1] === "inspect") return { status: inspectExists ? 0 : 1 };
  if (command === "multipass" && args[0] === "info") return { status: vmExists ? 0 : 1 };
  return { status: 0 };
};
globalThis.__rinDeploymentOwnerCapture = (command, args) => {
  if (command === "sh" && missingCommand && args[1].includes(missingCommand)) throw new Error("missing");
  if (command === "hcloud" && args[0] === "server" && args[1] === "ip") return "203.0.113.10\n";
  if (command === "doctl" && args[0] === "compute" && args[1] === "ssh-key" && args[2] === "list") return globalThis.__rinDeploymentOwnerDoctlKeys ?? "42 rin-owner-cloud\n";
  if (command === "doctl" && args[0] === "compute" && args[1] === "droplet" && args[2] === "get") return "203.0.113.20\n";
  return "/usr/bin/" + String(args.at(-1) || command) + "\n";
};

const targets = await import(
  pathToFileURL(path.resolve("dist/core/rin-install/deployment-targets.js")).href
);
assert.equal(
  targets.defaultSshControlPath(" Owner Box "),
  path.join(process.env.RIN_TEST_DEPLOYMENT_TMP, "rin-ssh-owner-box-%C"),
);
assert.equal(
  targets.defaultSshControlPath(""),
  path.join(process.env.RIN_TEST_DEPLOYMENT_TMP, "rin-ssh-target-%C"),
);

const ssh = targets.installExistingSshTarget({ kind: "ssh", name: "Owner SSH", host: "alice@example.test" });
assert.deepEqual(ssh.runtime, {
  kind: "ssh",
  host: "alice@example.test",
  controlPath: path.join(process.env.RIN_TEST_DEPLOYMENT_TMP, "rin-ssh-owner-ssh-%C"),
});

await assert.rejects(async () => targets.installContainerTarget({ kind: "container", name: "!!!", engine: "docker", image: "node:22" }), /rin_container_name_required/);
inspectExists = false;
const container = targets.installContainerTarget({ kind: "container", name: "Owner Box", engine: "docker", image: "node:22" });
assert.equal(container.runtime.container, "owner-box");
inspectExists = true;
targets.installContainerTarget({ kind: "container", name: "Owner Box", engine: "podman", image: "node:22" });

failMode = "error";
assert.throws(() => targets.installContainerTarget({ kind: "container", name: "Error Box", engine: "docker", image: "node:22" }), /owner spawn failed/);
failMode = "status";
assert.throws(() => targets.installContainerTarget({ kind: "container", name: "Status Box", engine: "docker", image: "node:22" }), /rin_command_failed:docker:17/);

const hetzner = targets.installCloudTarget({
  kind: "cloud", name: "Owner Cloud", provider: "hetzner", token: "secret",
  region: "fsn1", size: "cx22", image: "ubuntu-24.04",
});
assert.deepEqual(hetzner.runtime, {
  kind: "ssh", host: "203.0.113.10", user: "root",
  identityFile: path.join(process.env.RIN_TEST_DEPLOYMENT_HOME, ".rin", "targets", "keys", "owner-cloud"),
});
assert.equal(fs.readFileSync(path.join(process.env.RIN_TEST_DEPLOYMENT_TMP, "rin-cloud-init-owner-cloud.yml"), "utf8").includes("#cloud-config"), true);

const digitalOcean = targets.installCloudTarget({
  kind: "cloud", name: "Owner Cloud", provider: "digitalocean", token: "secret",
  region: "nyc3", size: "s-1vcpu-1gb", image: "ubuntu-24-04-x64",
});
assert.equal(digitalOcean.label, "DigitalOcean 203.0.113.20");
globalThis.__rinDeploymentOwnerDoctlKeys = "77 another-key\n";
assert.throws(() => targets.installCloudTarget({
  kind: "cloud", name: "Missing Key", provider: "digitalocean", token: "secret",
  region: "nyc3", size: "small", image: "ubuntu",
}), /rin_digitalocean_ssh_key_not_found/);
assert.throws(() => targets.installCloudTarget({ kind: "cloud", name: "Other", provider: "other", token: "", region: "", size: "", image: "" }), /rin_cloud_provider_not_implemented:other/);
missingCommand = "hcloud";
assert.throws(() => targets.installCloudTarget({
  kind: "cloud", name: "No Tool", provider: "hetzner", token: "secret",
  region: "fsn1", size: "cx22", image: "ubuntu",
}), /rin_missing_required_tool:hcloud/);
missingCommand = "";

const nas = targets.installNasTarget({
  kind: "nas", name: "Owner NAS", provider: "synology", host: "nas.test",
  engine: "docker", image: "node:22",
});
assert.deepEqual(nas.runtime, {
  kind: "command", command: "ssh",
  argsBeforeRin: ["nas.test", "docker", "exec", "owner-nas"],
});
vmExists = false;
const vm = targets.installVmTarget({ kind: "vm", name: "Owner VM", provider: "multipass", image: "24.04" });
assert.deepEqual(vm.runtime.argsBeforeRin, ["exec", "owner-vm", "--"]);
vmExists = true;
targets.installVmTarget({ kind: "vm", name: "Owner VM", provider: "multipass", image: "24.04" });
assert.deepEqual(targets.registerLocalUserTarget("alice"), {
  name: "alice", kind: "local-user", label: "alice",
  runtime: { kind: "local-user", user: "alice" },
  metadata: { installedBy: "rin-install" },
});
assert.equal(targets.registerLocalUserTarget("alice", "workstation").name, "workstation");

const events = globalThis.__rinDeploymentOwnerEvents;
assert.equal(events.filter(([name]) => name === "upsert").length, 10);
assert.equal(events.some(([name, command, args]) => name === "spawn" && command === "ssh-keygen" && args.includes("ed25519")), true);
assert.equal(events.some(([name, command, args]) => name === "spawn" && command === "ssh" && args.includes("-tt")), true);
assert.equal(events.some(([name, command, args]) => name === "spawn" && command === "docker" && args[0] === "run"), true);
assert.equal(events.some(([name, command, args]) => name === "spawn" && command === "multipass" && args[0] === "launch"), true);
console.log(JSON.stringify({ events: events.length, upserts: 10 }));
`;

test("deployment target installers execute each provider contract and persist its runtime identity", async () => {
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
          RIN_TEST_DEPLOYMENT_HOME: home,
          RIN_TEST_DEPLOYMENT_TMP: tmp,
        },
      },
    );
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.upserts, 10);
    assert.equal(summary.events > 35, true);
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
