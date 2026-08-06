import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { importBuiltModule } from "../support/import-built-module.js";

const { normalizeAgentPracticesManifest, syncAgentPracticesDocs } =
  await importBuiltModule<
    typeof import("../../src/core/docs/practices-sync.js")
  >("dist/core/docs/practices-sync.js");

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
    () => normalizeAgentPracticesManifest(null),
    /invalid_practices_manifest/,
  );
  assert.throws(
    () => normalizeAgentPracticesManifest({ files: "README.md" }),
    /invalid_practices_manifest/,
  );
  assert.throws(
    () => normalizeAgentPracticesManifest({ files: ["manifest.json"] }),
    /invalid_practices_manifest_path/,
  );
  assert.throws(
    () => normalizeAgentPracticesManifest({ files: ["nested//README.md"] }),
    /invalid_practices_manifest_path/,
  );
  assert.deepEqual(
    normalizeAgentPracticesManifest({
      files: ["z.md", "a.md", "z.md", "nested\\guide.md"],
    }),
    ["a.md", "nested/guide.md", "z.md"],
  );
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

test("agent practices sync records fetch failures and warns the caller", async () => {
  const agentDir = await tempAgentDir();
  const warnings: string[] = [];
  await assert.rejects(
    syncAgentPracticesDocs(agentDir, {
      rawBaseUrl: "https://example.test/main/",
      fetch: createFetch({
        "manifest.json": JSON.stringify({ files: ["missing.md"] }),
      }) as any,
      logger: { warn: (message) => warnings.push(message) },
    }),
    /agent_practices_fetch_failed:404/,
  );
  assert.deepEqual(warnings, [
    "agent practices docs sync failed: agent_practices_fetch_failed:404:https://example.test/main/missing.md",
  ]);
  const state = JSON.parse(
    await fs.readFile(
      path.join(agentDir, "data", "core", "docs", "agent-practices-sync.json"),
      "utf8",
    ),
  );
  assert.equal(state.status, "error");
  assert.match(state.error, /agent_practices_fetch_failed:404/);
  assert.equal(state.source, "https://example.test/main");
});

test("agent practices sync uses default source and preserves manifest newlines", async () => {
  const agentDir = await tempAgentDir();
  const result = await syncAgentPracticesDocs(agentDir, {
    fetch: createFetch({
      "manifest.json": `${JSON.stringify({ files: [] })}\n`,
    }) as any,
  });
  assert.equal(
    result.source,
    "https://raw.githubusercontent.com/rinchan-hoshino/rin-agent-practices/main",
  );
  assert.equal(
    await fs.readFile(
      path.join(agentDir, "docs", "rin", "practices", "manifest.json"),
      "utf8",
    ),
    `${JSON.stringify({ files: [] })}\n`,
  );
});

test("agent practices sync reports missing response status as zero", async () => {
  const agentDir = await tempAgentDir();
  await assert.rejects(
    syncAgentPracticesDocs(agentDir, {
      rawBaseUrl: "https://example.test/main",
      fetch: async () => ({ ok: false, text: async () => "" }),
    }),
    /agent_practices_fetch_failed:0/,
  );
});

test("agent practices sync reports successful synchronization", async () => {
  const agentDir = await tempAgentDir();
  const messages: string[] = [];
  const result = await syncAgentPracticesDocs(agentDir, {
    rawBaseUrl: "https://example.test/main/",
    fetch: createFetch({
      "manifest.json": JSON.stringify({ files: [] }),
    }) as any,
    logger: { info: (message) => messages.push(message) },
  });
  assert.equal(result.source, "https://example.test/main");
  assert.deepEqual(result.files, []);
  assert.deepEqual(messages, [
    "agent practices docs synced: 0 files from https://example.test/main",
  ]);
});

test("agent practices sync owns and closes its HTTP transport", async () => {
  const agentDir = await tempAgentDir();
  const server = http.createServer((request, response) => {
    if (request.url === "/manifest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ files: ["README.md"] }));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("# Local practices\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await syncAgentPracticesDocs(agentDir, {
      rawBaseUrl: `http://127.0.0.1:${address.port}`,
    });
    assert.deepEqual(result.files, ["README.md"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
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
