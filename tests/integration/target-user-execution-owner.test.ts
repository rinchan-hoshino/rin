import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTargetUserExecutionContext,
  resolveRuntimeAgentDirForTarget,
} from "../../dist/core/rin/target-user-execution.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("one target-user owner derives identity, environment, commands, and socket authority", async () => {
  const calls: unknown[][] = [];
  let directSocketProbes = 0;
  const deps = {
    buildUserShell(
      targetUser: string,
      argv: string[],
      env: Record<string, string>,
    ) {
      calls.push(["shell", targetUser, argv, env]);
      return {
        command: "target-shell",
        args: [targetUser, ...argv],
        env: { OWNER_ENV: "1" },
      };
    },
    canConnectDaemonSocket: async (socketPath: string, timeoutMs: number) => {
      directSocketProbes += 1;
      calls.push(["direct-probe", socketPath, timeoutMs]);
      return true;
    },
    execFileSync(
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) {
      calls.push(["exec", command, args, options]);
      if (options.encoding === "utf8") return "captured";
      return undefined;
    },
    fileExists: (filePath: string) => filePath === "/usr/bin/systemctl",
  };

  const cross = createTargetUserExecutionContext(
    {
      targetUser: "owner",
      currentUser: "launcher",
      targetHome: "/home/owner",
      installDir: "/srv/rin",
      cwd: "/repo",
    },
    deps,
  );
  assert.equal(cross.isTargetUser, false);
  assert.equal(cross.targetHome, "/home/owner");
  assert.equal(cross.installDir, "/srv/rin");
  assert.equal(cross.agentDir, "/srv/rin");
  assert.equal(cross.socketPath, "/srv/rin/data/core/daemon/bridge.sock");
  assert.equal(cross.systemctl, "/usr/bin/systemctl");
  cross.exec(["owner", "exec"]);
  assert.equal(cross.capture(["owner", "capture"]), "captured");
  assert.equal(await cross.canConnectSocket(), true);
  assert.equal(directSocketProbes, 0);
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "shell" &&
        entry[1] === "owner" &&
        Array.isArray(entry[2]) &&
        entry[2][0] === process.execPath &&
        entry[2][1] === "-e",
    ),
  );

  const local = createTargetUserExecutionContext(
    {
      targetUser: "launcher",
      currentUser: "launcher",
      targetHome: "/home/launcher",
      installDir: "/srv/local",
    },
    deps,
  );
  assert.equal(local.isTargetUser, true);
  assert.equal(await local.canConnectSocket(), true);
  assert.equal(directSocketProbes, 1);
});

test("runtime agent-dir selection preserves same-user explicit roots and cross-user install ownership", () => {
  assert.equal(
    resolveRuntimeAgentDirForTarget("owner", "owner", "/install", {
      RIN_DIR: "/explicit",
    }),
    "/explicit",
  );
  assert.equal(
    resolveRuntimeAgentDirForTarget("owner", "launcher", "/install", {
      RIN_DIR: "/must-not-win",
    }),
    "/install",
  );
});

test("managed runtime service projects the canonical target-user execution owner", async () => {
  const source = await fs.readFile(
    path.join(root, "src/core/rin/managed-runtime-service.ts"),
    "utf8",
  );
  assert.match(source, /createTargetUserExecutionContext/);
  assert.doesNotMatch(source, /canConnectDaemonSocket/);
  assert.doesNotMatch(source, /buildUserShell/);
  assert.doesNotMatch(source, /execFileSync/);
});

test("target-user execution covers fallback identities, systemctl paths, and failed remote probes", async () => {
  assert.equal(
    resolveRuntimeAgentDirForTarget("", "", "", { RIN_DIR: "/explicit" }),
    "/explicit",
  );
  assert.equal(
    resolveRuntimeAgentDirForTarget("owner", "launcher", "", {}),
    "",
  );
  assert.equal(
    resolveRuntimeAgentDirForTarget("owner", "launcher", "", {
      RIN_DIR: "/fallback",
    }),
    "/fallback",
  );

  const baseDependencies = {
    buildUserShell(
      targetUser: string,
      argv: string[],
      env: Record<string, string>,
    ) {
      return { command: "shell", args: [targetUser, ...argv], env };
    },
    canConnectDaemonSocket: async () => false,
  };
  const binSystemctl = createTargetUserExecutionContext(
    {
      targetUser: "owner",
      currentUser: "launcher",
      targetHome: "/home/owner",
      installDir: "/srv/rin",
    },
    {
      ...baseDependencies,
      fileExists: (filePath: string) => filePath === "/bin/systemctl",
      execFileSync() {
        throw new Error("unreachable");
      },
    },
  );
  assert.equal(binSystemctl.systemctl, "/bin/systemctl");
  assert.equal(await binSystemctl.canConnectSocket(), false);

  const defaults = createTargetUserExecutionContext(
    {
      targetUser: "",
      currentUser: "",
      targetHome: "",
      installDir: "",
      cwd: "",
    },
    {
      ...baseDependencies,
      fileExists: () => false,
      execFileSync: () => undefined,
    },
  );
  assert.equal(defaults.targetUser, defaults.currentUser);
  assert.ok(defaults.targetHome);
  assert.ok(defaults.installDir);

  const nativeDependencies = createTargetUserExecutionContext({
    targetUser: process.env.USER || process.env.LOGNAME || "rin",
    currentUser: process.env.USER || process.env.LOGNAME || "rin",
    targetHome: "/home/rin",
    installDir: "/home/rin/.rin",
  });
  assert.equal(nativeDependencies.isTargetUser, true);

  const noSystemctl = createTargetUserExecutionContext(
    {
      targetUser: "launcher",
      currentUser: "launcher",
      targetHome: "/home/launcher",
    },
    {
      ...baseDependencies,
      fileExists: () => false,
      execFileSync: () => undefined,
    },
  );
  assert.equal(noSystemctl.systemctl, "");
  assert.equal(noSystemctl.capture(["empty"]), "");
  assert.equal(await noSystemctl.canConnectSocket(), false);
});
