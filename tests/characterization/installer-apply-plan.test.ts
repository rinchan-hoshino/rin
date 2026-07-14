import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const applyPlan = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "apply-plan.js"),
  ).href
);

test("installer apply-plan writes a private terminal handoff plan and command", () => {
  const writes = [];
  const chmods = [];
  const planPath = applyPlan.writeFinalizeInstallPlanFile(
    { currentUser: "alice", targetUser: "bob", installDir: "/srv/rin" },
    {
      tmpdir: () => "/tmp",
      mkdtempSync(prefix) {
        assert.equal(prefix, "/tmp/rin-install-plan-");
        return "/tmp/rin-install-plan-demo";
      },
      writeFileSync(filePath, value, encoding) {
        writes.push({ filePath, value, encoding });
      },
      chmodSync(filePath, mode) {
        chmods.push({ filePath, mode });
      },
    },
  );
  assert.equal(planPath, "/tmp/rin-install-plan-demo/apply-plan.json");
  assert.equal(writes.length, 1);
  assert.match(writes[0].value, /"targetUser": "bob"/);
  assert.deepEqual(chmods, [{ filePath: planPath, mode: 0o600 }]);
  assert.match(
    applyPlan.buildFinalizeInstallPlanCommand(
      planPath,
      "/opt/rin install/main.js",
    ),
    /^'.+' '\/opt\/rin install\/main.js' --apply-plan-file '\/tmp\/rin-install-plan-demo\/apply-plan.json'$/,
  );
});

test("runFinalizeInstallPlanInChild inherits stdio so sudo prompts stay interactive", async () => {
  const statuses = [];
  const spawnCalls = [];

  const result = await applyPlan.runFinalizeInstallPlanInChild(
    {
      currentUser: "alice",
      targetUser: "bob",
      installDir: "/srv/rin",
    },
    "Publishing runtime and writing configuration with elevated permissions...",
    {
      writeStatus(message) {
        statuses.push(message);
      },
      spawnImpl(command, args, options) {
        spawnCalls.push({ command, args, options });
        const child = new EventEmitter();
        setImmediate(() => {
          const resultPath = args[args.indexOf("--apply-result-file") + 1];
          fs.writeFileSync(resultPath, JSON.stringify({ ok: true }), "utf8");
          child.emit("exit", 0, null);
        });
        return child;
      },
    },
  );

  assert.deepEqual(statuses, [
    "Publishing runtime and writing configuration with elevated permissions...",
  ]);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].options.stdio, [
    "inherit",
    "inherit",
    "inherit",
  ]);
  assert.equal(spawnCalls[0].args.includes("--apply-plan-file"), true);
  assert.equal(spawnCalls[0].options.env, process.env);
  assert.deepEqual(result, { ok: true });
});

test("runFinalizeInstallPlanInChild wires parent signal forwarding", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "apply-plan.ts"),
    "utf8",
  );

  assert.match(source, /FORWARDED_CHILD_SIGNALS/);
  assert.match(source, /process\.once\(signal, handler\)/);
  assert.match(source, /child\.kill\(signal\)/);
  assert.match(source, /process\.exit\(signalExitCode/);
});

test("runFinalizeInstallPlanInChild surfaces child error output on failure", async () => {
  await assert.rejects(
    applyPlan.runFinalizeInstallPlanInChild(
      {
        currentUser: "alice",
        targetUser: "bob",
        installDir: "/srv/rin",
      },
      "Publishing runtime...",
      {
        writeStatus() {},
        spawnImpl(_command, args, _options) {
          const child = new EventEmitter();
          setImmediate(() => {
            const errorPath = args[args.indexOf("--apply-error-file") + 1];
            fs.writeFileSync(errorPath, "sudo interaction failed", "utf8");
            child.emit("exit", 1, null);
          });
          return child;
        },
      },
    ),
    /sudo interaction failed/,
  );
});

test("runFinalizeInstallPlanInChild suppresses parent duplicate when child cannot write error handoff", async () => {
  let error: any;
  try {
    await applyPlan.runFinalizeInstallPlanInChild(
      {
        currentUser: "alice",
        targetUser: "bob",
        installDir: "/srv/rin",
      },
      "Publishing runtime...",
      {
        writeStatus() {},
        spawnImpl() {
          const child = new EventEmitter();
          setImmediate(() => child.emit("exit", 1, null));
          return child;
        },
      },
    );
  } catch (caught) {
    error = caught;
  }

  assert.equal(error?.message, "rin_installer_apply_handoff_missing");
  assert.equal(error?.suppressUserFacingPrint, true);
});
