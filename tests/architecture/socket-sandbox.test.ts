import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSocketTestSandbox } from "../support/socket-test-sandbox.js";

test("socket test sandbox rejects live and outside paths before removal", async () => {
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const outsideRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-socket-outside-"),
  );
  const outsideSocket = path.join(outsideRoot, "daemon.sock");
  const liveServer = net.createServer((socket) => socket.end("still live"));
  await new Promise<void>((resolve, reject) => {
    liveServer.once("error", reject);
    liveServer.listen(outsideSocket, resolve);
  });

  const sandbox = createSocketTestSandbox("architecture");
  try {
    assert.equal(process.env.XDG_RUNTIME_DIR, sandbox.runtimeDir);
    assert.throws(
      () => sandbox.assertOwnedSocketPath(sandbox.liveSocketPath),
      /test_socket_path_outside_sandbox/,
    );
    assert.throws(
      () =>
        sandbox.assertOwnedSocketPath("/run/user/1001/rin-daemon/daemon.sock"),
      /test_socket_path_outside_sandbox/,
    );
    await assert.rejects(
      () => sandbox.removeOwnedSocket(outsideSocket),
      /test_socket_path_outside_sandbox/,
    );

    const response = await new Promise<string>((resolve, reject) => {
      let received = "";
      const client = net.createConnection(outsideSocket);
      client.setEncoding("utf8");
      client.on("data", (chunk) => {
        received += chunk;
      });
      client.once("end", () => resolve(received));
      client.once("error", reject);
    });
    assert.equal(response, "still live");

    const symlinkEscape = path.join(sandbox.runtimeDir, "outside-link");
    await fs.symlink(outsideRoot, symlinkEscape);
    assert.throws(
      () =>
        sandbox.assertOwnedSocketPath(path.join(symlinkEscape, "daemon.sock")),
      /test_socket_path_symlink_escape/,
    );

    const ownedSocket = path.join(
      sandbox.runtimeDir,
      "rin-daemon",
      "daemon.sock",
    );
    sandbox.assertOwnedSocketPath(ownedSocket);
    await fs.mkdir(path.dirname(ownedSocket), { recursive: true });
    await fs.writeFile(ownedSocket, "test owned");
    await sandbox.removeOwnedSocket(ownedSocket);
    await assert.rejects(() => fs.access(ownedSocket), /ENOENT/);
  } finally {
    sandbox.cleanup();
    await new Promise<void>((resolve, reject) => {
      liveServer.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }

  assert.equal(process.env.XDG_RUNTIME_DIR, previousRuntimeDir);
  await assert.rejects(() => fs.access(sandbox.root), /ENOENT/);
});
