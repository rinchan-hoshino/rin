import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const store = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-targets", "store.js"))
    .href
);
const registry = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-targets", "registry.js"),
  ).href
);
const runner = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-targets", "runner.js"))
    .href
);

test("rin target store upserts, defaults, and removes targets", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-targets-"));
  const filePath = path.join(dir, "targets.json");

  const first = store.upsertTarget(
    {
      name: "Demo Box",
      kind: "ssh",
      runtime: { kind: "ssh", host: "demo" },
    },
    filePath,
  );
  assert.equal(first.name, "demo-box");
  assert.equal(store.getDefaultTarget(filePath).name, "demo-box");

  store.upsertTarget(
    {
      name: "local",
      kind: "local-user",
      runtime: { kind: "local-user", user: "rin" },
      default: true,
    },
    filePath,
  );
  assert.deepEqual(
    store.listTargets(filePath).map((target) => target.name),
    ["demo-box", "local"],
  );
  assert.equal(store.getDefaultTarget(filePath).name, "local");
  assert.equal(store.removeTarget("local", filePath), true);
  assert.equal(store.getDefaultTarget(filePath), undefined);
});

test("rin target registry lists only closed-loop deployment providers", () => {
  assert.ok(registry.findDeploymentProvider("cloud", "hetzner"));
  assert.ok(registry.findDeploymentProvider("cloud", "digitalocean"));
  assert.equal(registry.findDeploymentProvider("cloud", "aws"), undefined);
  assert.ok(registry.findDeploymentProvider("nas", "synology"));
  assert.ok(registry.findDeploymentProvider("vm", "multipass"));
  assert.equal(registry.findDeploymentProvider("vm", "hyperv"), undefined);
  assert.ok(registry.findDeploymentProvider("container", "docker"));
});

test("rin target runner strips target wrapper args before delegation", () => {
  assert.deepEqual(
    runner.stripTargetWrapperArgs(["--target", "box", "status", "--watch"]),
    ["status", "--watch"],
  );
  assert.deepEqual(
    runner.stripTargetWrapperArgs(["--target=box", "update", "--beta"]),
    ["update", "--beta"],
  );
});
