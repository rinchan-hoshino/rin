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

test("target registry exposes only the three maintained deployment modes", () => {
  assert.deepEqual(Object.keys(registry.TARGET_KIND_LABELS).sort(), [
    "container",
    "local-user",
    "ssh",
  ]);
  assert.deepEqual(
    registry.DEPLOYMENT_PROVIDERS.map(
      (provider) => `${provider.kind}/${provider.id}`,
    ),
    ["container/docker", "container/podman"],
  );
});

test("target registry filters container providers", () => {
  assert.deepEqual(
    registry
      .findDeploymentProviders("container")
      .map((provider) => provider.id),
    ["docker", "podman"],
  );
  assert.equal(
    registry.DEPLOYMENT_PROVIDERS.every(
      (provider) =>
        provider.requiredInputs.length > 0 && provider.notes.length > 0,
    ),
    true,
  );
  assert.equal(registry.TARGET_KIND_LABELS.ssh, "Existing SSH host");
});

test("target registry accepts only matching maintained target records", () => {
  for (const target of [
    { kind: "local-user", runtime: { kind: "local-user", user: "rin" } },
    { kind: "ssh", runtime: { kind: "ssh", host: "example.test" } },
    {
      kind: "container",
      runtime: { kind: "container", engine: "docker", container: "rin" },
    },
  ]) {
    assert.equal(registry.isSupportedTargetRecord(target), true);
  }
  for (const target of [
    null,
    {},
    { kind: "ssh" },
    { kind: "local-user", runtime: { kind: "ssh" } },
    { kind: "ssh", runtime: { kind: "container" } },
    { kind: "container", runtime: { kind: "local-user" } },
    { kind: "cloud", runtime: { kind: "ssh" } },
  ]) {
    assert.equal(registry.isSupportedTargetRecord(target), false);
  }
});
