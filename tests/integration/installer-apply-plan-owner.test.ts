import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const applyPlan = await importBuiltModule<
  typeof import("../../src/core/rin-install/apply-plan.js")
>("dist/core/rin-install/apply-plan.js");

const options = {
  currentUser: "alice",
  targetUser: "bob",
  installDir: "/srv/rin",
};

test("installer apply-plan writes a private handoff and shell-safe child command", () => {
  const writes: any[] = [];
  const chmods: any[] = [];
  const planPath = applyPlan.writeFinalizeInstallPlanFile(options, {
    tmpdir: () => "/tmp",
    mkdtempSync(prefix) {
      assert.equal(prefix, "/tmp/rin-install-plan-");
      return "/tmp/rin install owner";
    },
    writeFileSync(filePath, value, encoding) {
      writes.push({ filePath, value, encoding });
    },
    chmodSync(filePath, mode) {
      chmods.push({ filePath, mode });
    },
  });
  assert.equal(planPath, "/tmp/rin install owner/apply-plan.json");
  assert.equal(JSON.parse(writes[0].value).targetUser, "bob");
  assert.equal(writes[0].encoding, "utf8");
  assert.deepEqual(chmods, [{ filePath: planPath, mode: 0o600 }]);
  assert.match(
    applyPlan.buildFinalizeInstallPlanCommand(
      planPath,
      "/opt/rin install/main.js",
    ),
    /--apply-plan-file '\/tmp\/rin install owner\/apply-plan\.json'$/,
  );

  const actualPlan = applyPlan.writeFinalizeInstallPlanFile(options);
  try {
    assert.equal(
      JSON.parse(fs.readFileSync(actualPlan, "utf8")).installDir,
      "/srv/rin",
    );
    assert.equal(fs.statSync(actualPlan).mode & 0o777, 0o600);
    assert.match(
      applyPlan.buildFinalizeInstallPlanCommand(actualPlan),
      /--apply-plan-file/,
    );
    const previousEntry = process.argv[1];
    process.argv[1] = "";
    try {
      assert.match(
        applyPlan.buildFinalizeInstallPlanCommand(actualPlan),
        /apply-plan\.js|apply-plan-file/,
      );
    } finally {
      process.argv[1] = previousEntry;
    }
  } finally {
    assert.equal(
      applyPlan.cleanupConsumedFinalizeInstallPlan(actualPlan),
      true,
    );
  }
});

test("installer apply-plan removes only an owned temporary handoff", () => {
  const removals: any[] = [];
  const validStat = {
    isSymbolicLink: () => false,
    isDirectory: () => true,
  };
  const deps = {
    tmpdir: () => "/tmp",
    realpathSync: (value: fs.PathLike) => path.resolve(String(value)),
    lstatSync: () => validStat as fs.Stats,
    rmSync: (value: fs.PathLike, options: any) =>
      removals.push({ value: String(value), options }),
  };
  const planPath = "/tmp/rin-install-plan-owner/apply-plan.json";
  assert.equal(
    applyPlan.cleanupConsumedFinalizeInstallPlan(planPath, deps),
    true,
  );
  assert.deepEqual(removals, [
    {
      value: "/tmp/rin-install-plan-owner",
      options: { recursive: true, force: true },
    },
  ]);
  assert.equal(
    applyPlan.cleanupConsumedFinalizeInstallPlan(
      "/tmp/rin-install-plan-owner/other.json",
      deps,
    ),
    false,
  );
  assert.equal(
    applyPlan.cleanupConsumedFinalizeInstallPlan(
      "/tmp/not-owned/apply-plan.json",
      deps,
    ),
    false,
  );
  assert.equal(
    applyPlan.cleanupConsumedFinalizeInstallPlan(planPath, {
      ...deps,
      lstatSync: () =>
        ({ isSymbolicLink: () => true, isDirectory: () => true }) as fs.Stats,
    }),
    false,
  );
  assert.equal(
    applyPlan.cleanupConsumedFinalizeInstallPlan(planPath, {
      ...deps,
      lstatSync: () =>
        ({ isSymbolicLink: () => false, isDirectory: () => false }) as fs.Stats,
    }),
    false,
  );
  assert.equal(
    applyPlan.cleanupConsumedFinalizeInstallPlan(planPath, {
      ...deps,
      tmpdir: () => "/var/tmp",
    }),
    false,
  );
  assert.equal(
    applyPlan.cleanupConsumedFinalizeInstallPlan(planPath, {
      ...deps,
      lstatSync: () => {
        throw new Error("owner lstat failed");
      },
    }),
    false,
  );
});

function fakeChild(
  run: (
    child: EventEmitter & { killed: boolean; kill: (signal: string) => void },
  ) => void,
) {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    kill: (signal: string) => void;
  };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  setImmediate(() => run(child));
  return child as any;
}

test("installer apply-plan returns the child result with inherited terminal IO", async () => {
  const statuses: string[] = [];
  const result = await applyPlan.runFinalizeInstallPlanInChild(
    options,
    "Applying owner plan",
    {
      entryPath: "/owner/installer-main.js",
      writeStatus: (message) => statuses.push(message),
      spawnImpl(command, args, spawnOptions) {
        assert.equal(command, process.execPath);
        assert.equal(args[0], "/owner/installer-main.js");
        assert.deepEqual(spawnOptions.stdio, ["inherit", "inherit", "inherit"]);
        assert.equal(spawnOptions.env, process.env);
        return fakeChild((child) => {
          const resultPath = args[args.indexOf("--apply-result-file") + 1];
          fs.writeFileSync(resultPath, JSON.stringify({ status: "ok" }));
          child.emit("exit", 0, null);
        });
      },
    },
  );
  assert.deepEqual(statuses, ["Applying owner plan"]);
  assert.deepEqual(result, { status: "ok" });
});

test("installer apply-plan uses its default status writer", async () => {
  const result = await applyPlan.runFinalizeInstallPlanInChild(
    options,
    "Applying with default status",
    {
      spawnImpl(_command, args) {
        return fakeChild((child) => {
          const resultPath = args[args.indexOf("--apply-result-file") + 1];
          fs.writeFileSync(resultPath, JSON.stringify({ defaultStatus: true }));
          child.emit("exit", 0, null);
        });
      },
    },
  );
  assert.deepEqual(result, { defaultStatus: true });
});

test("installer apply-plan reports explicit, missing, and malformed child handoffs", async () => {
  await assert.rejects(
    applyPlan.runFinalizeInstallPlanInChild(options, "fail", {
      writeStatus() {},
      spawnImpl(_command, args) {
        return fakeChild((child) => {
          const errorPath = args[args.indexOf("--apply-error-file") + 1];
          fs.writeFileSync(errorPath, "target writer failed");
          child.emit("exit", 1, null);
        });
      },
    }),
    /target writer failed/,
  );

  let missingError: any;
  try {
    await applyPlan.runFinalizeInstallPlanInChild(options, "fail", {
      writeStatus() {},
      spawnImpl() {
        return fakeChild((child) => child.emit("exit", null, null));
      },
    });
  } catch (error) {
    missingError = error;
  }
  assert.equal(missingError.message, "rin_installer_apply_handoff_missing");
  assert.equal(missingError.suppressUserFacingPrint, true);

  await assert.rejects(
    applyPlan.runFinalizeInstallPlanInChild(options, "malformed", {
      writeStatus() {},
      spawnImpl(_command, args) {
        return fakeChild((child) => {
          const resultPath = args[args.indexOf("--apply-result-file") + 1];
          fs.writeFileSync(resultPath, "{bad");
          child.emit("exit", 0, null);
        });
      },
    }),
    /rin_installer_apply_result_missing/,
  );

  await assert.rejects(
    applyPlan.runFinalizeInstallPlanInChild(options, "spawn", {
      writeStatus() {},
      spawnImpl() {
        return fakeChild((child) =>
          child.emit("error", new Error("spawn failed")),
        );
      },
    }),
    /spawn failed/,
  );
});

test("installer apply-plan forwards parent termination with the shell exit code", async () => {
  const originalExit = process.exit;
  const before = new Set(process.listeners("SIGINT"));
  let killedWith = "";
  (process as any).exit = (code: number) => {
    throw new Error(`exit:${code}`);
  };
  try {
    await assert.rejects(
      applyPlan.runFinalizeInstallPlanInChild(options, "signal", {
        writeStatus() {},
        spawnImpl() {
          const child = new EventEmitter() as any;
          child.killed = false;
          child.kill = (signal: string) => {
            child.killed = true;
            killedWith = signal;
          };
          const originalOn = child.on.bind(child);
          child.on = (event: string, listener: (...args: any[]) => void) => {
            originalOn(event, listener);
            if (event === "exit") {
              const signalHandler = process
                .listeners("SIGINT")
                .find((candidate) => !before.has(candidate));
              assert.ok(signalHandler);
              signalHandler();
              listener(null, null);
            }
            return child;
          };
          return child;
        },
      }),
      /rin_process_termination_requested:130/,
    );
    assert.equal(killedWith, "SIGINT");

    await assert.rejects(
      applyPlan.runFinalizeInstallPlanInChild(options, "unknown signal", {
        writeStatus() {},
        spawnImpl() {
          const child = new EventEmitter() as any;
          child.killed = false;
          child.kill = () => {};
          const originalOn = child.on.bind(child);
          child.on = (event: string, listener: (...args: any[]) => void) => {
            originalOn(event, listener);
            if (event === "exit") listener(null, "SIGUSR1");
            return child;
          };
          return child;
        },
      }),
      /rin_process_termination_requested:1/,
    );
  } finally {
    (process as any).exit = originalExit;
  }
});
