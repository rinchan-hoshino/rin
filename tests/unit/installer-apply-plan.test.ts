import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
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

test("installer apply-plan cleans only consumed Rin-owned handoff directories", async () => {
  const ownedRoot = await fs.promises.mkdtemp(
    path.join(
      process.env.RIN_TEST_TMPDIR || "/home/rin/tmp",
      "rin-install-plan-",
    ),
  );
  const ownedPlan = path.join(ownedRoot, "apply-plan.json");
  fs.writeFileSync(ownedPlan, "{}\n");
  applyPlan.cleanupConsumedFinalizeInstallPlan(ownedPlan, {
    tmpdir: () => path.dirname(ownedRoot),
  });
  assert.equal(fs.existsSync(ownedRoot), false);

  const unrelatedRoot = await fs.promises.mkdtemp(
    path.join(process.env.RIN_TEST_TMPDIR || "/home/rin/tmp", "other-plan-"),
  );
  const unrelatedPlan = path.join(unrelatedRoot, "apply-plan.json");
  fs.writeFileSync(unrelatedPlan, "{}\n");
  applyPlan.cleanupConsumedFinalizeInstallPlan(unrelatedPlan, {
    tmpdir: () => path.dirname(unrelatedRoot),
  });
  assert.equal(fs.existsSync(unrelatedPlan), true);
  await fs.promises.rm(unrelatedRoot, { recursive: true, force: true });

  const outsideRoot = await fs.promises.mkdtemp(
    path.join(process.env.RIN_TEST_TMPDIR || "/home/rin/tmp", "outside-"),
  );
  const lookalikeRoot = path.join(outsideRoot, "rin-install-plan-lookalike");
  const lookalikePlan = path.join(lookalikeRoot, "apply-plan.json");
  await fs.promises.mkdir(lookalikeRoot);
  fs.writeFileSync(lookalikePlan, "{}\n");
  applyPlan.cleanupConsumedFinalizeInstallPlan(lookalikePlan, {
    tmpdir: () => path.dirname(outsideRoot),
  });
  assert.equal(fs.existsSync(lookalikePlan), true);
  await fs.promises.rm(outsideRoot, { recursive: true, force: true });
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

test("installer consumes external apply plans with owned handoff cleanup", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "main.ts"),
    "utf8",
  );
  const branch = source.slice(
    source.indexOf("if (cli.applyPlanFile)"),
    source.indexOf("if (cli.guiDisabled)"),
  );
  assert.match(branch, /finally/);
  assert.match(branch, /cleanupConsumedFinalizeInstallPlan/);
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
