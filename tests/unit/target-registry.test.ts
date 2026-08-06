import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const registry = await importBuiltModule<
  typeof import("../../src/core/rin-targets/registry.js")
>("dist/core/rin-targets/registry.js");

test("target names normalize to stable CLI identifiers", () => {
  assert.equal(registry.normalizeTargetName("  Demo Box  "), "demo-box");
  assert.equal(registry.normalizeTargetName("--A / B__C..--"), "a-b__c..");
  assert.equal(registry.normalizeTargetName(" !!! "), "");
  assert.equal(registry.normalizeTargetName(""), "");

  assert.equal(registry.isValidTargetName("demo-box_1.local"), true);
  assert.equal(registry.isValidTargetName("A".repeat(64)), true);
  assert.equal(registry.isValidTargetName("A".repeat(65)), false);
  assert.equal(registry.isValidTargetName("-demo"), false);
  assert.equal(registry.isValidTargetName("demo box"), false);
  assert.equal(registry.isValidTargetName("   "), false);
});

test("target registry exposes only deployment providers with closed loops", () => {
  assert.ok(registry.findDeploymentProvider("cloud", "hetzner"));
  assert.ok(registry.findDeploymentProvider("cloud", "digitalocean"));
  assert.equal(registry.findDeploymentProvider("cloud", "aws"), undefined);
  assert.ok(registry.findDeploymentProvider("nas", "synology"));
  assert.ok(registry.findDeploymentProvider("vm", "multipass"));
  assert.equal(registry.findDeploymentProvider("vm", "hyperv"), undefined);
  assert.ok(registry.findDeploymentProvider("container", "docker"));
});

test("target registry filters provider groups and normalizes provider ids", () => {
  assert.deepEqual(
    registry
      .findDeploymentProviders("container")
      .map((provider) => provider.id),
    ["docker", "podman"],
  );
  assert.deepEqual(
    registry.findDeploymentProviders("cloud").map((provider) => provider.id),
    ["hetzner", "digitalocean"],
  );
  assert.equal(
    registry.findDeploymentProvider("container", "  PODMAN  ")?.label,
    "Podman",
  );
  assert.equal(registry.findDeploymentProvider("nas", "unknown"), undefined);
  assert.equal(
    registry.DEPLOYMENT_PROVIDERS.every(
      (provider) =>
        provider.requiredInputs.length > 0 && provider.notes.length > 0,
    ),
    true,
  );
  assert.equal(registry.TARGET_KIND_LABELS.ssh, "Existing SSH host");
});
