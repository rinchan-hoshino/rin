import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const targets = await importBuiltModule<
  typeof import("../../src/core/rin/targets.js")
>("dist/core/rin/targets.js");
const store = await importBuiltModule<
  typeof import("../../src/core/rin-targets/store.js")
>("dist/core/rin-targets/store.js");

async function captureLogs(run: () => Promise<void>) {
  const lines: string[] = [];
  const log = mock.method(console, "log", (...args) =>
    lines.push(args.join(" ")),
  );
  try {
    await run();
  } finally {
    log.mock.restore();
  }
  return lines;
}

async function resetStore() {
  await fs.rm(path.join(os.homedir(), ".rin", "targets.json"), { force: true });
}

test("target commands register, select, show, and remove local users", async () => {
  await resetStore();
  assert.deepEqual(
    await captureLogs(() => targets.runTargetCommand(["target", "list"])),
    ["No Rin targets configured."],
  );
  await assert.rejects(
    () =>
      targets.runTargetCommand(["target", "register-local-user", "", "rin"]),
    /rin_target_register_local_user_usage/,
  );

  assert.deepEqual(
    await captureLogs(() =>
      targets.runTargetCommand([
        "rin",
        "target",
        "register-local-user",
        " Local Owner ",
        "rin",
      ]),
    ),
    ["Registered Rin target: local-owner"],
  );
  await assert.rejects(
    () => targets.runTargetCommand(["target", "use", "missing"]),
    /rin_target_not_found:missing/,
  );
  assert.deepEqual(
    await captureLogs(() =>
      targets.runTargetCommand(["target", "use", "LOCAL OWNER"]),
    ),
    ["Default Rin target: local-owner"],
  );

  const shown = await captureLogs(() =>
    targets.runTargetCommand(["target", "show", "local-owner"]),
  );
  assert.equal(JSON.parse(shown[0]).runtime.user, "rin");
  await assert.rejects(
    () => targets.runTargetCommand(["target", "show", "missing"]),
    /rin_target_not_found:missing/,
  );

  assert.deepEqual(
    await captureLogs(() =>
      targets.runTargetCommand(["target", "remove", "local-owner"]),
    ),
    ["Removed Rin target: local-owner"],
  );
  assert.deepEqual(
    await captureLogs(() =>
      targets.runTargetCommand(["target", "remove", "local-owner"]),
    ),
    ["Rin target not found: local-owner"],
  );
});

test("target list renders every runtime transport without exposing store internals", async () => {
  await resetStore();
  const filePath = store.targetStorePath();
  const now = "2026-07-16T00:00:00.000Z";
  store.writeTargetStore(
    {
      defaultTarget: "local",
      targets: [
        {
          name: "ssh-user",
          kind: "ssh",
          createdAt: now,
          updatedAt: now,
          runtime: { kind: "ssh", host: "host", user: "owner" },
        },
        {
          name: "ssh-host",
          kind: "ssh",
          createdAt: now,
          updatedAt: now,
          runtime: { kind: "ssh", host: "host-only" },
        },
        {
          name: "container",
          kind: "container",
          createdAt: now,
          updatedAt: now,
          runtime: { kind: "container", engine: "docker", container: "rin" },
        },
        {
          name: "local",
          kind: "local-user",
          default: true,
          createdAt: now,
          updatedAt: now,
          runtime: { kind: "local-user", user: "rin" },
        },
        {
          name: "unknown",
          kind: "vm",
          createdAt: now,
          updatedAt: now,
          runtime: { kind: "command", command: "runner", argsBeforeRin: [] },
        } as any,
      ],
    },
    filePath,
  );

  const lines = await captureLogs(() => targets.runTargetCommand(["list"]));
  assert.ok(lines.some((line) => line === "* local\tLocal user\trin"));
  assert.ok(lines.some((line) => line.endsWith("owner@host")));
  assert.ok(lines.some((line) => line.endsWith("host-only")));
  assert.ok(lines.some((line) => line.endsWith("docker:rin")));
  assert.ok(lines.some((line) => line.endsWith("unknown")));
  await assert.rejects(
    () => targets.runTargetCommand(["target", "use", "unknown"]),
    /rin_target_unsupported:vm/,
  );
});

test("target provider catalog supports filtered and complete listings", async () => {
  const containers = await captureLogs(() =>
    targets.runTargetCommand(["target", "providers", "container"]),
  );
  assert.ok(
    containers.some((line) => line.startsWith("container/docker\tDocker\t")),
  );
  assert.ok(
    containers.some((line) => line.startsWith("container/podman\tPodman\t")),
  );
  assert.equal(
    containers.some((line) => line.startsWith("cloud/")),
    false,
  );

  const all = await captureLogs(() =>
    targets.runTargetCommand(["target", "providers"]),
  );
  assert.deepEqual(all, containers);
  const removed = await captureLogs(() =>
    targets.runTargetCommand(["target", "providers", "cloud"]),
  );
  assert.deepEqual(removed, []);
});

test("target command reports missing names and unknown command usage", async () => {
  await assert.rejects(
    () => targets.runTargetCommand(["target", "use"]),
    /rin_target_name_required/,
  );
  await assert.rejects(
    () => targets.runTargetCommand(["target", "remove"]),
    /rin_target_name_required/,
  );
  const lines = await captureLogs(() =>
    targets.runTargetCommand(["target", "wat"]),
  );
  assert.deepEqual(lines, [
    [
      "Usage:",
      "  rin target list",
      "  rin target use <name>",
      "  rin target remove <name>",
      "  rin target providers [container]",
    ].join("\n"),
  ]);
});
