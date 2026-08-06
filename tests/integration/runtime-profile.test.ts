import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const profile = await importBuiltModule<
  typeof import("../../src/core/rin-lib/profile.js")
>("dist/core/rin-lib/profile.js");

test("runtime profile resolves explicit, environment, and home defaults", () => {
  const previousRinDir = process.env.RIN_DIR;
  try {
    delete process.env.RIN_DIR;
    assert.deepEqual(profile.resolveRuntimeProfile(), {
      cwd: os.homedir(),
      agentDir: path.join(os.homedir(), ".rin"),
    });
    process.env.RIN_DIR = " /tmp/rin-env ";
    assert.deepEqual(profile.resolveRuntimeProfile({ cwd: "/tmp/cwd" }), {
      cwd: "/tmp/cwd",
      agentDir: "/tmp/rin-env",
    });
    assert.deepEqual(
      profile.resolveRuntimeProfile({ agentDir: "/tmp/explicit" }),
      {
        cwd: os.homedir(),
        agentDir: "/tmp/explicit",
      },
    );
  } finally {
    if (previousRinDir === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
  }
});

test("runtime profile applies shared environment and session paths", () => {
  const previousRinDir = process.env.RIN_DIR;
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    profile.applyRuntimeProfileEnvironment({ agentDir: "" });
    profile.applyRuntimeProfileEnvironment({ agentDir: "/tmp/agent" });
    assert.equal(process.env.RIN_DIR, "/tmp/agent");
    assert.equal(process.env.PI_CODING_AGENT_DIR, "/tmp/agent");
    assert.equal(
      profile.getRuntimeSessionDir("/ignored", "/tmp/agent"),
      path.join("/tmp/agent", "sessions"),
    );
  } finally {
    if (previousRinDir === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
    if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiDir;
  }
});
