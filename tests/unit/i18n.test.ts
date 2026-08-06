import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const i18n =
  await importBuiltModule<typeof import("../../src/core/i18n.js")>(
    "dist/core/i18n.js",
  );

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-i18n-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("i18n catalogs flatten nested records while rejecting blank and non-record values", () => {
  assert.deepEqual(i18n.resolveRinI18nCatalog(), {});
  assert.deepEqual(i18n.resolveRinI18nCatalog(null), {});
  assert.deepEqual(i18n.resolveRinI18nCatalog(["not", "a", "record"]), {});
  assert.deepEqual(
    i18n.resolveRinI18nCatalog({
      greeting: "Hello",
      blank: "   ",
      " ": "ignored key",
      nested: {
        title: "Welcome",
        deep: { body: "Keep going" },
        ignored: 3,
      },
      ignored: false,
    }),
    {
      greeting: "Hello",
      "nested.title": "Welcome",
      "nested.deep.body": "Keep going",
    },
  );
});

test("i18n paths and file reads use the agent root and fail closed", async () => {
  assert.equal(i18n.rinI18nPath("  /tmp/agent  "), "/tmp/agent/i18n.json");
  assert.equal(i18n.rinI18nPath(""), "i18n.json");
  assert.deepEqual(i18n.readRinI18nCatalog("  "), {});

  await withAgentDir(async (agentDir) => {
    assert.deepEqual(i18n.readRinI18nCatalog(agentDir), {});
    await fs.writeFile(i18n.rinI18nPath(agentDir), "invalid", "utf8");
    assert.deepEqual(i18n.readRinI18nCatalog(agentDir), {});

    await fs.writeFile(
      i18n.rinI18nPath(agentDir),
      JSON.stringify({ chat: { ready: "Ready" } }),
      "utf8",
    );
    assert.deepEqual(i18n.readRinI18nCatalog(` ${agentDir} `), {
      "chat.ready": "Ready",
    });
  });
});
