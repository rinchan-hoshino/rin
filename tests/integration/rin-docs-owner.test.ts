import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

await import("../support/register-rin-docs-owner-fixture.ts");

const docs = await importBuiltModule<
  typeof import("../../src/core/rin/docs.js")
>("dist/core/rin/docs.js");

test("Rin docs rejects unknown internal commands with the normalized command", async () => {
  await assert.rejects(
    docs.runDocsInternal([]),
    /unknown_docs_internal_command:<empty>/,
  );
  await assert.rejects(
    docs.runDocsInternal([" unknown "]),
    /unknown_docs_internal_command:unknown/,
  );
});

test("Rin docs syncs practices into the isolated runtime profile and reports the handoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-docs-owner-"));
  const previousRinDir = process.env.RIN_DIR;
  const output: string[] = [];
  const previousLog = console.log;
  process.env.RIN_DIR = root;
  console.log = (...values: unknown[]) =>
    output.push(values.map(String).join(" "));
  (globalThis as any).__rinDocsOwnerSync = async (agentDir: string) => {
    const targetDir = path.join(agentDir, "docs", "practices");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "README.md"), "# README\n");
    return {
      source: "https://owner.invalid/practices",
      targetDir,
      files: ["README.md"],
      syncedAt: "2026-07-27T00:00:00.000Z",
    };
  };
  try {
    await docs.runDocsInternal([" sync-practices "]);
  } finally {
    delete (globalThis as any).__rinDocsOwnerSync;
    console.log = previousLog;
    if (previousRinDir === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
  }
  try {
    assert.equal(output.length, 1);
    const result = JSON.parse(output[0]);
    assert.equal(result.synced, true);
    assert.ok(result.fileCount > 0);
    assert.equal(
      path.resolve(result.targetDir).startsWith(path.resolve(root)),
      true,
    );
    assert.equal((await fs.stat(result.targetDir)).isDirectory(), true);
    assert.equal(typeof result.source, "string");
    assert.match(result.syncedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
