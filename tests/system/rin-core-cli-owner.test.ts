import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const registerFixture = path.resolve(
  "tests/support/register-rin-main-owner-fixture.ts",
);

const childScript = String.raw`
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

globalThis.__rinMainOwnerEvents = [];
globalThis.__rinMainOwnerCommands = [];
const main = await import(pathToFileURL(path.resolve("dist/core/rin/main.js")).href);
assert.equal(main.defaultLaunchModeForPlatform("linux"), "tui");
assert.equal(main.defaultLaunchModeForPlatform("win32"), "tui");
assert.equal(main.resolveInternalRinDispatch(["unknown"]), undefined);
assert.equal(
  main.isExplicitRinUpdateInvocation(["update", "--git", "--branch", "main", "--yes"]),
  true,
);
assert.equal(
  main.isExplicitRinUpdateInvocation(["--user", "owner", "update"]),
  true,
);
assert.equal(
  main.isExplicitRinUpdateInvocation(["update", "--extensions"]),
  false,
);
assert.equal(
  main.isExplicitRinUpdateInvocation(["install", "--git"]),
  false,
);

for (const [marker, expected] of [
  ["__memory_index_internal", "memory-index-internal"],
  ["__self_improve_internal", "self-improve-internal"],
  ["__status_internal", "status-internal"],
  ["__tasks_internal", "tasks-internal"],
  ["__docs_internal", "docs-internal"],
]) {
  const dispatch = main.resolveInternalRinDispatch([marker, "owner"]);
  assert.deepEqual(dispatch.args, ["owner"]);
  await dispatch.run(dispatch.args);
  assert.equal(globalThis.__rinMainOwnerEvents.at(-1)[0], expected);
}
for (const command of ["memory-index", "self-improve", "status", "tasks"]) {
  const dispatch = main.resolveInternalRinDispatch([command, "--help"]);
  assert.deepEqual(dispatch.args, ["--help"]);
  await dispatch.run(dispatch.args);
}

const logs = [];
const originalLog = console.log;
console.log = (value) => logs.push(String(value));
async function run(argv) {
  process.argv = [process.execPath, "rin-owner", ...argv];
  return await main.startRinCli();
}
try {
  await run(["version"]);
  await run(["__docs_internal", "manual"]);
  await run(["-p", "--help"]);
  await run(["--help"]);
  await run(["-p", "owner prompt"]);
  await run(["target", "list"]);
  await run(["version", "--target=remote"]);
  await assert.rejects(() => run(["status", "--target=missing"]), /rin_target_not_found:missing/);
  for (const command of [
    "update", "start", "stop", "restart", "doctor", "status", "tasks",
    "self-improve", "versions", "rollback", "memory-index",
  ]) await run([command]);
  await run(["update", "self"]);
  await run(["update", "--self", "--force"]);
  await run(["update", "--all"]);
  await run(["update", "--git", "--branch", "main", "--yes"]);
  await run(["--user", "owner"]);
  await run(["version", "--target", "remote-two"]);
  await run(["version", "--yes"]);
  await run([]);
} finally {
  console.log = originalLog;
}
assert.deepEqual(
  logs.filter((value) => value === "9.8.7-owner"),
  ["9.8.7-owner", "9.8.7-owner"],
);
assert.equal(process.exitCode, 23);
process.exitCode = 0;
const names = globalThis.__rinMainOwnerEvents.map(([name]) => name);
for (const expected of [
  "print-help", "run", "target", "resolve-target", "run-target",
  "update", "start", "stop", "restart", "doctor", "status", "tasks",
  "self-improve", "versions", "rollback", "memory-index", "launch",
]) assert.equal(names.includes(expected), true, expected);
assert.equal(globalThis.__rinMainOwnerCommands.length >= 14, true);
console.log = originalLog;
originalLog(JSON.stringify({ events: names.length, commands: globalThis.__rinMainOwnerCommands.length }));
`;

test("Rin core CLI dispatches every local, internal, target, and default command boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-main-owner-"));
  const sandbox = await createTestSandbox(root);
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
      { env: sandbox.env },
    );
    const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.equal(summary.events >= 24, true);
    assert.equal(summary.commands >= 14, true);
    assert.equal(result.stderr, "");

    const failureScript = String.raw`
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      globalThis.__rinMainOwnerEvents = [];
      globalThis.__rinMainOwnerCommands = [];
      const main = await import(pathToFileURL(path.resolve("dist/core/rin/main.js")).href);
      process.argv = [
        process.execPath,
        "rin-owner",
        ...JSON.parse(process.env.RIN_TEST_MAIN_FAILURE_ARGV),
      ];
      await main.startRinCli();
    `;
    for (const [argv, target] of [
      [["__memory_index_internal"], "dist/core/rin/memory-index.js"],
      [["__self_improve_internal"], "dist/core/rin/self-improve.js"],
      [["__status_internal"], "dist/core/rin/status.js"],
      [["__tasks_internal"], "dist/core/rin/tasks.js"],
      [["__docs_internal"], "dist/core/rin/docs.js"],
      [["-p", "owner prompt"], "dist/core/rin/run.js"],
      [["target", "list"], "dist/core/rin/targets.js"],
      [["status", "--target=remote"], "dist/core/rin-targets/runner.js"],
      [["update"], "dist/core/rin/shared.js"],
      [["start"], "dist/core/rin/control.js"],
      [["stop"], "dist/core/rin/control.js"],
      [["restart"], "dist/core/rin/control.js"],
      [["doctor"], "dist/core/rin/doctor.js"],
      [["status"], "dist/core/rin/status.js"],
      [["tasks"], "dist/core/rin/tasks.js"],
      [["self-improve"], "dist/core/rin/self-improve.js"],
      [["versions"], "dist/core/rin/versions.js"],
      [["rollback"], "dist/core/rin/versions.js"],
      [["memory-index"], "dist/core/rin/memory-index.js"],
      [["unknown"], "dist/core/rin/launch.js"],
    ] as const) {
      await assert.rejects(
        () =>
          execFileAsync(
            process.execPath,
            [
              "--import",
              "tsx",
              "--import",
              registerFixture,
              "--input-type=module",
              "-e",
              failureScript,
            ],
            {
              env: {
                ...sandbox.env,
                RIN_TEST_MAIN_FAILURE_ARGV: JSON.stringify(argv),
                RIN_TEST_MAIN_IMPORT_FAILURE: target,
              },
            },
          ),
        (error: any) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /owner_main_import_failed/);
          return true;
        },
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
