import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

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
  const previousFetch = globalThis.fetch;
  process.env.RIN_DIR = root;
  console.log = (...values: unknown[]) =>
    output.push(values.map(String).join(" "));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.endsWith("/manifest.json")
      ? JSON.stringify({ files: ["README.md", "nested/guide.md"] })
      : `# ${path.basename(url)}\n`;
    return { ok: true, text: async () => body } as Response;
  }) as typeof fetch;
  try {
    await docs.runDocsInternal([" sync-practices "]);
  } finally {
    globalThis.fetch = previousFetch;
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
