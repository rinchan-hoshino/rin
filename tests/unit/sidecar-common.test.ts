import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const sidecar = await importBuiltModule<{
  writeInstanceState(file: string, state: Record<string, unknown>): void;
  readInstanceState(file: string): Record<string, unknown> | null;
  listInstanceIds(root: string): string[];
}>("dist/core/sidecar/common.js");

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-sidecar-unit-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("sidecar state writes atomically and lists only valid instances", async () => {
  await withTempDir(async (dir) => {
    const instances = path.join(dir, "instances");
    const statePath = path.join(instances, "demo", "state.json");
    sidecar.writeInstanceState(statePath, { pid: 123, ownerPid: 456 });
    await fs.mkdir(path.join(instances, "empty"), { recursive: true });
    await fs.writeFile(path.join(instances, "note.txt"), "ignore");
    assert.deepEqual(sidecar.readInstanceState(statePath), {
      pid: 123,
      ownerPid: 456,
    });
    assert.deepEqual(sidecar.listInstanceIds(instances), ["demo"]);
    assert.deepEqual(sidecar.listInstanceIds(path.join(dir, "missing")), []);
  });
});

test("sidecar state rejects missing, malformed, array, and null payloads", async () => {
  await withTempDir(async (dir) => {
    const statePath = path.join(dir, "instances", "bad", "state.json");
    assert.equal(sidecar.readInstanceState(statePath), null);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    for (const value of ["bad", '"bad"', '["bad"]', "null"]) {
      await fs.writeFile(statePath, value);
      assert.equal(sidecar.readInstanceState(statePath), null);
    }
  });
});
