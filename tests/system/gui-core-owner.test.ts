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
  "tests/support/register-gui-main-owner-fixture.ts",
);

const childScript = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.RIN_TEST_GUI_MAIN_ROOT;
const socketPath = path.join(process.env.XDG_RUNTIME_DIR, "rin-daemon", "daemon.sock");
await fs.mkdir(path.dirname(socketPath), { recursive: true });
const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolve);
});
const { runGui } = await import(
  pathToFileURL(path.resolve("dist/core/rin-gui/main.js")).href
);
const parsed = {
  command: "gui",
  targetUser: os.userInfo().username,
  targetName: "",
  installDir: path.join(root, "install"),
  passthrough: [],
  explicitUser: false,
  explicitTarget: false,
  hasSavedInstall: false,
  releaseChannel: "stable",
  releaseBranch: "",
  releaseVersion: "",
  explicitReleaseChannel: false,
  updateAssumeYes: false,
};
try {
  await runGui(parsed, ["gui"]);
  process.env.RIN_TEST_GUI_MAIN_MODE = "fail";
  await assert.rejects(() => runGui(parsed, ["gui"]), /owner_gui_failure/);
  await assert.rejects(
    () => runGui(parsed, ["gui", "--unsupported-owner-option"]),
    /rin_gui_unrecognized_arg/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const calls = (await fs.readFile(process.env.RIN_TEST_GUI_MAIN_LOG, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(calls.map((entry) => entry.mode), ["success", "fail"]);
  assert.equal(calls.every((entry) => entry.connected), true);
  assert.equal(
    calls.every((entry) => entry.settingsPath === path.join(parsed.installDir, "settings.json")),
    true,
  );
  assert.equal(sockets.size, 0);
  console.log(JSON.stringify({ calls: calls.length, connectedAfterFinally: sockets.size }));
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}
`;

test("GUI core owns parse, daemon connection, desktop handoff, and disconnect", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-gui-core-owner-"));
  try {
    const sandbox = await createTestSandbox(root);
    const logFile = path.join(root, "gui-main.jsonl");
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
      {
        env: {
          ...sandbox.env,
          XDG_RUNTIME_DIR: sandbox.runtimeDir,
          RIN_TEST_GUI_MAIN_ROOT: root,
          RIN_TEST_GUI_MAIN_LOG: logFile,
          RIN_TEST_GUI_MAIN_MODE: "success",
        },
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      calls: 2,
      connectedAfterFinally: 0,
    });
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
