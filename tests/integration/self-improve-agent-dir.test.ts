import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const agentDir = await importBuiltModule<
  typeof import("../../src/core/self-improve/agent-dir.js")
>("dist/core/self-improve/agent-dir.js");

test("self-improve agent dir follows override, runtime, then home precedence", () => {
  const previous = process.env.RIN_DIR;
  try {
    delete process.env.RIN_DIR;
    assert.equal(
      agentDir.resolveAgentDir(),
      path.resolve(os.homedir(), ".rin"),
    );

    process.env.RIN_DIR = "/tmp/rin-agent";
    assert.equal(agentDir.resolveAgentDir(), path.resolve("/tmp/rin-agent"));
    assert.equal(
      agentDir.resolveAgentDir(" /tmp/override-agent "),
      path.resolve("/tmp/override-agent"),
    );
  } finally {
    if (previous === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previous;
  }
});
