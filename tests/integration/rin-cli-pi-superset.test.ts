import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const rinEntry = path.join(rootDir, "dist", "app", "rin", "main.js");
const piEntry = path.join(
  rootDir,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
const { tryRunPiCliCommand } = await import(
  pathToFileURL(path.join(rootDir, "dist/core/rin/pi-command-adapter.js")).href
);

async function runCli(entry: string, args: string[]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cli-pi-"));
  try {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: home,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: path.join(home, ".rin"),
        RIN_DIR: path.join(home, ".rin"),
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    });
    assert.equal(result.signal, null, result.stderr || result.stdout);
    return result;
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("rin reuses Pi package command implementations", async () => {
  for (const command of ["install", "remove", "list", "config"]) {
    const [pi, rin] = await Promise.all([
      runCli(piEntry, [command, "--help"]),
      runCli(rinEntry, [command, "--help"]),
    ]);
    assert.equal(rin.status, pi.status, `${command} exit status`);
    assert.equal(rin.stdout, pi.stdout, `${command} help output`);
    assert.equal(rin.stderr, pi.stderr, `${command} help diagnostics`);
  }
});

test("rin top-level help includes Pi options and adds Rin commands", async () => {
  const result = await runCli(rinEntry, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--api-key <key>/);
  assert.match(result.stdout, /--session-id <id>/);
  assert.match(result.stdout, /install <source>/);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /tasks/);
});

test("the Pi command adapter owns only Pi commands and Rin update overlays", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cli-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  const previousExitCode = process.exitCode;
  try {
    process.env.PI_CODING_AGENT_DIR = path.join(home, ".rin");
    process.env.PI_OFFLINE = "1";
    assert.equal(await tryRunPiCliCommand([]), "rin");
    assert.equal(await tryRunPiCliCommand(["not-a-pi-command"]), "rin");
    assert.equal(await tryRunPiCliCommand(["update"]), "rin");
    assert.equal(await tryRunPiCliCommand(["update", "self"]), "rin");
    assert.equal(await tryRunPiCliCommand(["update", "--self"]), "rin");
    assert.equal(await tryRunPiCliCommand(["update", "pi"]), "rin");
    assert.equal(await tryRunPiCliCommand(["update", "--force"]), "rin");
    assert.equal(await tryRunPiCliCommand(["update", "--approve"]), "rin");
    assert.equal(await tryRunPiCliCommand(["update", "--no-approve"]), "rin");
    assert.equal(await tryRunPiCliCommand(["update", "--help"]), "handled");
    assert.equal(await tryRunPiCliCommand(["config", "--help"]), "handled");
    assert.equal(await tryRunPiCliCommand(["auth", "--help"]), "handled");
    assert.equal(await tryRunPiCliCommand(["update", "--all"]), "rin-after-pi");
    assert.equal(
      await tryRunPiCliCommand(["update", "--all", "--approve"]),
      "rin-after-pi",
    );
    assert.equal(
      await tryRunPiCliCommand(["update", "--all", "--no-approve"]),
      "rin-after-pi",
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    process.exitCode = previousExitCode;
    await fs.rm(home, { recursive: true, force: true });
  }
});
