import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { importBuiltModule } from "../support/import-built-module.js";

const common = await importBuiltModule<
  typeof import("../../src/core/rin-install/common.js")
>("dist/core/rin-install/common.js");

function forwardedSignalExitCode(signal: NodeJS.Signals) {
  return new Promise<number>((resolve, reject) => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "dist/core/rin-install/common.js"),
    ).href;
    const source = `
const common = await import(${JSON.stringify(moduleUrl)});
const pending = common.runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"] , { stdio: "ignore" });
console.log("READY");
console.log("CODE=" + await pending);
`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let signalSent = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!signalSent && stdout.includes("READY")) {
        signalSent = true;
        child.kill(signal);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      const match = stdout.match(/CODE=(\d+)/);
      if (!match) {
        reject(new Error(`signal helper result missing: ${stdout}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`signal helper failed: ${code}: ${stderr}`));
        return;
      }
      resolve(Number(match[1]));
    });
  });
}

test("installer command runner reports exits, signals, and spawn errors", async () => {
  assert.equal(
    await common.runCommand(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    }),
    0,
  );
  assert.equal(
    await common.runCommand(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    }),
    7,
  );
  await assert.rejects(
    common.runCommand(
      process.execPath,
      ["-e", 'process.kill(process.pid, "SIGTERM")'],
      { stdio: "ignore" },
    ),
    /terminated:SIGTERM/,
  );
  await assert.rejects(
    common.runCommand("rin-command-that-does-not-exist", [], {
      stdio: "ignore",
    }),
    /ENOENT/,
  );
  assert.equal(await forwardedSignalExitCode("SIGINT"), 130);
  assert.equal(await forwardedSignalExitCode("SIGTERM"), 143);
  assert.equal(await forwardedSignalExitCode("SIGHUP"), 129);
});

test("installer command helpers select shell and invoking user semantics", () => {
  assert.equal(common.shouldRunCommandThroughShell("rin.cmd", "win32"), true);
  assert.equal(common.shouldRunCommandThroughShell("", "win32"), false);
  assert.equal(common.shouldRunCommandThroughShell("rin.BAT", "win32"), true);
  assert.equal(common.shouldRunCommandThroughShell("node.exe", "win32"), false);
  assert.equal(common.shouldRunCommandThroughShell("rin.cmd", "linux"), false);

  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  const previous = {
    sudo: process.env.SUDO_USER,
    username: process.env.USERNAME,
    logname: process.env.LOGNAME,
    user: process.env.USER,
  };
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.SUDO_USER = "  deployment-owner  ";
    assert.equal(common.detectCurrentUser(), "deployment-owner");

    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.USERNAME = "  DesktopOwner  ";
    assert.equal(common.detectCurrentUser(), "DesktopOwner");
  } finally {
    if (platformDescriptor)
      Object.defineProperty(process, "platform", platformDescriptor);
    for (const [key, value] of Object.entries(previous)) {
      const envKey =
        key === "sudo"
          ? "SUDO_USER"
          : key === "username"
            ? "USERNAME"
            : key.toUpperCase();
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }

  assert.equal(common.repoRootFromHere(), process.cwd());
});
