import "../support/require-test-sandbox.ts";
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

test("container image references reject shell and whitespace syntax", () => {
  for (const value of [
    "node:22-bookworm",
    "ghcr.io/rinchan/rin@sha256:abc123",
    "registry.test:5000/team/image_v1",
  ]) {
    assert.equal(registry.isValidContainerImageReference(value), true);
  }
  for (const value of [
    "",
    "/absolute/image",
    "image with spaces",
    "image;touch-owned",
    "$(touch-owned)",
  ]) {
    assert.equal(registry.isValidContainerImageReference(value), false);
  }
});

test("target registry exposes only the three maintained target transports", () => {
  assert.deepEqual(Object.keys(registry.TARGET_KIND_LABELS).sort(), [
    "container",
    "local-user",
    "ssh",
  ]);
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
