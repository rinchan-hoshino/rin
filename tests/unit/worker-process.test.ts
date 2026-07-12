import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const workerProcess = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "worker-process.js"),
  ).href
);

test("worker process factory writes private resource options and spawns the managed worker", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-worker-process-"));
  const calls = [];
  try {
    const child = { marker: "child" };
    const result = workerProcess.spawnWorkerProcess(
      {
        workerPath: "/opt/rin/worker.js",
        cwd: "/srv/rin",
        resourceOptionsDir: tempDir,
      },
      { tools: ["read"] },
      {
        executable: "/opt/node",
        pid: 42,
        randomHex: () => "abc123",
        spawnImpl(command, args, options) {
          calls.push({ command, args, options });
          return child;
        },
      },
    );
    assert.equal(result, child);
    const optionsPath = path.join(tempDir, "worker-options-42-abc123.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(optionsPath, "utf8")), {
      tools: ["read"],
    });
    assert.equal(fs.statSync(optionsPath).mode & 0o777, 0o600);
    assert.deepEqual(calls, [
      {
        command: "/opt/node",
        args: ["/opt/rin/worker.js", "--resource-options-file", optionsPath],
        options: {
          cwd: "/srv/rin",
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
          windowsHide: true,
        },
      },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
