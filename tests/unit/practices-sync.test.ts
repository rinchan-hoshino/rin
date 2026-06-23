import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  normalizeAgentPracticesManifest,
  syncAgentPracticesDocs,
} from "../../src/core/docs/practices-sync.js";

async function tempAgentDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "rin-practices-sync-"));
}

function createFetch(files: Record<string, string>) {
  return async (url: string) => {
    const key = new URL(url).pathname.split("/").pop() || "";
    const nestedKey = new URL(url).pathname.replace(/^.*\/main\//, "");
    const body = files[nestedKey] ?? files[key];
    return {
      ok: typeof body === "string",
      status: typeof body === "string" ? 200 : 404,
      text: async () => body || "",
    };
  };
}

test("agent practices sync writes manifest files to installed docs path", async () => {
  const agentDir = await tempAgentDir();
  const manifest = JSON.stringify({
    schemaVersion: 1,
    files: ["README.md", "browser/README.md"],
  });
  const result = await syncAgentPracticesDocs(agentDir, {
    rawBaseUrl: "https://example.test/main",
    fetch: createFetch({
      "manifest.json": manifest,
      "README.md": "# Practices\n",
      "browser/README.md": "# Browser\n",
    }) as any,
  });

  assert.equal(result.files.length, 2);
  assert.equal(
    await fs.readFile(
      path.join(agentDir, "docs", "rin", "practices", "README.md"),
      "utf8",
    ),
    "# Practices\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(agentDir, "docs", "rin", "practices", "browser", "README.md"),
      "utf8",
    ),
    "# Browser\n",
  );
});

test("agent practices sync rejects unsafe manifest paths", async () => {
  assert.throws(
    () => normalizeAgentPracticesManifest({ files: ["../secret.md"] }),
    /invalid_practices_manifest_path/,
  );
  assert.throws(
    () => normalizeAgentPracticesManifest({ files: ["/abs.md"] }),
    /invalid_practices_manifest_path/,
  );
  assert.throws(
    () => normalizeAgentPracticesManifest({ files: ["notes.txt"] }),
    /invalid_practices_manifest_path/,
  );
});

test("agent practices sync replaces stale installed practice files", async () => {
  const agentDir = await tempAgentDir();
  const targetDir = path.join(agentDir, "docs", "rin", "practices");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, "stale.md"), "old", "utf8");

  await syncAgentPracticesDocs(agentDir, {
    rawBaseUrl: "https://example.test/main",
    fetch: createFetch({
      "manifest.json": JSON.stringify({ files: ["README.md"] }),
      "README.md": "# Fresh\n",
    }) as any,
  });

  assert.equal(
    await fs.readFile(path.join(targetDir, "README.md"), "utf8"),
    "# Fresh\n",
  );
  await assert.rejects(fs.access(path.join(targetDir, "stale.md")), /ENOENT/);
});
