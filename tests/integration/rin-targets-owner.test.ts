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

test("target commands list and remove installer-owned records", async () => {
  await resetStore();
  assert.deepEqual(
    await captureLogs(() => targets.runTargetCommand(["target", "list"])),
    ["No Rin targets configured."],
  );
  store.upsertTarget({
    name: "Local Owner",
    kind: "local-user",
    runtime: { kind: "local-user", user: "rin" },
  });
  const listed = await captureLogs(() =>
    targets.runTargetCommand(["target", "list"]),
  );
  assert.deepEqual(listed, ["  local-owner\tLocal user\trin"]);
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

test("target list renders every maintained runtime transport", async () => {
  await resetStore();
  const now = "2026-07-16T00:00:00.000Z";
  store.writeTargetStore({
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
        createdAt: now,
        updatedAt: now,
        runtime: { kind: "local-user", user: "rin" },
      },
    ],
  });

  const lines = await captureLogs(() => targets.runTargetCommand(["list"]));
  assert.ok(lines.some((line) => line === "  local\tLocal user\trin"));
  assert.ok(lines.some((line) => line.endsWith("owner@host")));
  assert.ok(lines.some((line) => line.endsWith("host-only")));
  assert.ok(lines.some((line) => line.endsWith("docker:rin")));
});

test("target command keeps only list/remove surface", async () => {
  await assert.rejects(
    () => targets.runTargetCommand(["target", "remove"]),
    /rin_target_name_required/,
  );
  const usage = [
    "Usage:",
    "  rin target list",
    "  rin target remove <name>",
  ].join("\n");
  for (const command of [
    "use",
    "providers",
    "show",
    "register-local-user",
    "wat",
  ]) {
    assert.deepEqual(
      await captureLogs(() => targets.runTargetCommand(["target", command])),
      [usage],
    );
  }
});
