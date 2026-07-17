import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const catalogModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "catalog.js"))
    .href
);

const {
  listCatalogCommands,
  listCatalogAllModels,
  listCatalogModels,
  getCatalogOAuthState,
} = catalogModule;

async function createTestAgentDir() {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  await fs.writeFile(
    path.join(agentDir, "auth.json"),
    JSON.stringify({
      openai: { type: "api_key", key: "test-key" },
    }),
  );
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({}));
  return agentDir;
}

async function withTestAgentDir(fn) {
  const agentDir = await createTestAgentDir();
  try {
    await fn(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("daemon catalog lists builtin and extension commands without session worker", async () => {
  await withTestAgentDir(async (agentDir) => {
    const commands = await listCatalogCommands({
      cwd: rootDir,
      agentDir,
      additionalExtensionPaths: ["", "   "],
    });
    const names = new Set(commands.map((item) => item.name));
    assert.equal(names.has("settings"), true);
    assert.equal(names.has("model"), true);
    assert.equal(names.has("clone"), true);
    assert.equal(names.has("trust"), true);
    assert.equal(names.has("usage"), true);
    assert.equal(names.has("todos"), false);
    assert.equal(names.has("init"), false);
  });
});

test("daemon catalog honors command-level extension resource options", async () => {
  await withTestAgentDir(async (agentDir) => {
    const extensionPath = path.join(agentDir, "catalog-extension.ts");
    await fs.writeFile(
      extensionPath,
      `export default function(pi: any) {
        pi.registerCommand("catalog-ext", {
          description: "catalog extension command",
          handler: async () => {},
        });
      }\n`,
    );

    const commands = await listCatalogCommands({
      cwd: rootDir,
      agentDir,
      additionalExtensionPaths: [extensionPath],
    });
    assert.equal(
      commands.find((item) => item.name === "catalog-ext")?.description,
      "catalog extension command",
    );
  });
});

test("daemon catalog lists all and available models directly", async () => {
  await withTestAgentDir(async (agentDir) => {
    const allModels = await listCatalogAllModels({
      cwd: rootDir,
      agentDir,
    });
    const availableModels = await listCatalogModels({
      cwd: rootDir,
      agentDir,
    });
    assert.equal(Array.isArray(allModels), true);
    assert.equal(Array.isArray(availableModels), true);
    assert.equal(allModels.length >= availableModels.length, true);
    assert.equal(availableModels.length > 0, true);
  });
});

test("daemon catalog reads oauth state directly", async () => {
  await withTestAgentDir(async (agentDir) => {
    const state = await getCatalogOAuthState({
      cwd: rootDir,
      agentDir,
    });
    assert.equal(Array.isArray(state.providers), true);
    assert.equal(typeof state.credentials, "object");
  });
});

test("daemon catalog restores process cwd after read-only queries", async () => {
  await withTestAgentDir(async (agentDir) => {
    const queryCwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "rin-catalog-cwd-"),
    );
    const previousCwd = process.cwd();
    try {
      await listCatalogCommands({ cwd: queryCwd, agentDir });
      assert.equal(process.cwd(), previousCwd);

      await listCatalogModels({ cwd: queryCwd, agentDir });
      assert.equal(process.cwd(), previousCwd);

      await getCatalogOAuthState({ cwd: queryCwd, agentDir });
      assert.equal(process.cwd(), previousCwd);
    } finally {
      await fs.rm(queryCwd, { recursive: true, force: true });
    }
  });
});
