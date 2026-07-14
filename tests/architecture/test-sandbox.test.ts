import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildInstallToTuiContainerArgs,
  rootDir,
} from "../support/install-to-tui-harness.js";
import {
  assertTestSandbox,
  createTestSandbox,
} from "../support/test-sandbox.js";

test("test sandbox redirects every persistent Rin path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-test-sandbox-"));
  const previousSecret = process.env.RIN_TEST_SECRET;
  process.env.RIN_TEST_SECRET = "must-not-leak";
  t.after(async () => {
    if (previousSecret == null) delete process.env.RIN_TEST_SECRET;
    else process.env.RIN_TEST_SECRET = previousSecret;
    await fs.rm(root, { recursive: true, force: true });
  });

  const sandbox = await createTestSandbox(root, {
    TERM: "dumb",
    RIN_DIR: "/tmp/must-not-escape",
    HTTP_PROXY: "http://example.invalid",
    NODE_OPTIONS: "--import=/tmp/must-not-load.js",
  });

  assertTestSandbox(sandbox.env, root);
  assert.equal(sandbox.env.RIN_TEST_SECRET, undefined);
  assert.equal(sandbox.env.RIN_OFFLINE, "1");
  assert.equal(sandbox.env.RIN_DIR, sandbox.agentDir);
  assert.equal(sandbox.env.HTTP_PROXY, "http://127.0.0.1:9");
  assert.equal(sandbox.env.NODE_OPTIONS, undefined);
  assert.equal(sandbox.env.TERM, "dumb");
  await assert.doesNotReject(() =>
    fs.access(path.join(sandbox.agentDir, "self_improve", "skills")),
  );
  await assert.doesNotReject(() =>
    fs.access(path.join(sandbox.agentDir, "docs", "rin", "builtin-skills")),
  );
  assert.throws(
    () => assertTestSandbox({ ...sandbox.env, RIN_DIR: "/tmp/outside" }, root),
    /RIN_DIR escapes/,
  );
});

test("install sandbox separates host source from the container workspace", () => {
  const args = buildInstallToTuiContainerArgs({ mode: "smoke-test" });
  const mount = args[args.indexOf("--mount") + 1];
  const workdir = args[args.indexOf("-w") + 1];
  const network = args[args.indexOf("--network") + 1];
  const entrypoint = args[args.indexOf("--entrypoint") + 1];
  const innerScript = args.at(-1) || "";

  assert.equal(
    mount,
    `type=bind,source=${rootDir},target=/source/rin,readonly`,
  );
  assert.ok(args.includes("--pull=never"));
  assert.equal(workdir, "/workspace");
  assert.equal(network, "none");
  assert.equal(entrypoint, "/bin/sh");
  assert.match(innerScript, /--exclude='\.\/node_modules'/);
  assert.match(innerScript, /ln -s \/opt\/rin\/node_modules/);
  assert.match(innerScript, /cd '\/workspace\/rin'/);
  assert.match(innerScript, /setpriv --reuid=1000 --regid=1000/);
});

test("install sandbox exposes an explicit writable coverage handoff", () => {
  const coverageDir = path.join(path.parse(rootDir).root, "tmp", "coverage");
  const args = buildInstallToTuiContainerArgs({
    mode: "smoke-test",
    coverageDir,
  });

  assert.ok(
    args.includes(
      `type=bind,source=${path.resolve(coverageDir)},target=/coverage`,
    ),
  );
  assert.ok(args.includes("NODE_V8_COVERAGE=/coverage"));
});
