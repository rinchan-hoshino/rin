import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const registerFixture = path.resolve(
  "tests/support/register-daemon-worker-core-owner-fixture.ts",
);

const childScript = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

globalThis.__rinWorkerCoreOwnerEvents = [];
const worker = await import(
  pathToFileURL(path.resolve("dist/core/rin-daemon/worker.js")).href
);
const directManager = worker.createTemporaryWorkerSessionManager(
  {
    inMemory(cwd) {
      return { cwd, sessionDir: "before" };
    },
  },
  { cwd: "/direct/project", sessionDir: "/direct/sessions" },
);
assert.deepEqual(directManager, {
  cwd: "/direct/project",
  sessionDir: "/direct/sessions",
});

const root = process.env.RIN_TEST_WORKER_CORE_ROOT;
const validFile = path.join(root, "managed.json");
fs.writeFileSync(validFile, JSON.stringify({
  additionalExtensionPaths: ["from-file"],
  tools: ["read"],
  extensionFlagValues: [["file-flag", true]],
  __rinInitialSession: {
    kind: "managed",
    managedSessionLeaf: "chat/owner",
    parentSession: { id: "parent-managed" },
  },
}));
process.argv = [process.execPath, "worker", "--resource-options-file", validFile];
await worker.startWorker({
  additionalExtensionPaths: ["explicit"],
  noExtensions: true,
  excludeTools: ["bash"],
  noTools: false,
  additionalSkillPaths: ["/skills"],
  noSkills: true,
  additionalPromptTemplatePaths: ["/prompts"],
  noPromptTemplates: true,
  additionalThemePaths: ["/themes"],
  noThemes: true,
  noContextFiles: true,
  piStartupOptions: { mode: "owner" },
  systemPrompt: "owner system",
  appendSystemPrompt: ["owner append"],
  disabledRinCapabilities: ["memory"],
});
assert.equal(fs.existsSync(validFile), false);

process.argv = [process.execPath, "worker"];
await worker.startWorker({
  __rinInitialSession: { kind: "open", sessionFile: "/sessions/open.jsonl" },
});
await worker.startWorker({
  __rinInitialSession: { kind: "new", parentSession: { id: "parent-new" } },
});
await worker.startWorker({ __rinInitialSession: { kind: "new" } });
await worker.startWorker();

const malformed = path.join(root, "malformed.json");
fs.writeFileSync(malformed, "{");
process.argv = [process.execPath, "worker", "--resource-options-file=" + malformed];
await worker.startWorker();
assert.equal(fs.existsSync(malformed), false);
const primitive = path.join(root, "primitive.json");
fs.writeFileSync(primitive, "42");
process.argv = [process.execPath, "worker", "--resource-options-file", primitive];
await worker.startWorker();
const directory = path.join(root, "directory-resource");
fs.mkdirSync(directory);
process.argv = [process.execPath, "worker", "--resource-options-file", directory];
await worker.startWorker();
assert.equal(fs.existsSync(directory), true);

const events = globalThis.__rinWorkerCoreOwnerEvents;
const configured = events.filter(([name]) => name === "configured");
assert.equal(configured.length, 8);
assert.equal(configured[0][1].cwd, "/workspace/owner");
assert.equal(configured[0][1].agentDir, "/agent/owner");
assert.equal(configured[0][1].sessionManager.kind, "create");
assert.equal(configured[0][1].sessionManager.sessionDir, "/agent/owner/sessions/managed/chat/owner");
assert.deepEqual(configured[0][1].additionalExtensionPaths, ["explicit"]);
assert.deepEqual(configured[0][1].extensionFlagValues, new Map([["file-flag", true]]));
assert.deepEqual(configured[0][1].tools, ["read"]);
assert.deepEqual(configured[0][1].excludeTools, ["bash"]);
assert.equal(configured[1][1].sessionManager.kind, "open");
assert.equal(configured[2][1].sessionManager.kind, "create");
assert.equal(configured[3][1].sessionManager.kind, "create");
assert.equal(configured[4][1].sessionManager.kind, "memory");
assert.deepEqual(
  events.filter(([name]) => name === "newSession").map(([, value]) => value),
  [{ parentSession: { id: "parent-managed" } }, { parentSession: { id: "parent-new" } }],
);
assert.equal(events.filter(([name]) => name === "rpc").length, 8);
console.log(JSON.stringify({ configured: configured.length, rpc: 8 }));
`;

test("daemon worker core consumes one-shot resource options and selects each session ownership mode", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-worker-core-owner-"),
  );
  const sandbox = await createTestSandbox(root);
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        registerFixture,
        "--input-type=module",
        "-e",
        childScript,
      ],
      {
        env: { ...sandbox.env, RIN_TEST_WORKER_CORE_ROOT: root },
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), { configured: 8, rpc: 8 });
    assert.equal(result.stderr, "");

    const entrypoint = path.resolve("dist/core/rin-daemon/worker.js");
    const executionEntrypoint = [
      "--import",
      "tsx",
      "--import",
      registerFixture,
      entrypoint,
      "--execution-plane",
    ];
    const direct = await execFileAsync(process.execPath, executionEntrypoint, {
      env: sandbox.env,
    });
    assert.equal(direct.stdout, "");
    assert.equal(direct.stderr, "");
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, executionEntrypoint, {
          env: { ...sandbox.env, RIN_TEST_WORKER_CORE_FAILURE: "error" },
        }),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /owner worker failed/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, executionEntrypoint, {
          env: { ...sandbox.env, RIN_TEST_WORKER_CORE_FAILURE: "empty" },
        }),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /rin_worker_failed/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("daemon worker process keeps RPC in a supervisor and exits its execution child on shutdown", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-worker-supervisor-entry-"),
  );
  const sandbox = await createTestSandbox(root);
  try {
    const entrypoint = path.resolve("dist/core/rin-daemon/worker.js");
    const resourceOptionsFile = path.join(root, "resource-options.json");
    await fs.writeFile(
      resourceOptionsFile,
      JSON.stringify({
        agentDir: sandbox.agentDir,
        __rinInitialSession: { kind: "new" },
        noExtensions: true,
        noTools: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      [entrypoint, "--resource-options-file", resourceOptionsFile],
      {
        cwd: path.resolve("."),
        env: sandbox.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const responses: any[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      while (stdoutBuffer.includes("\n")) {
        const newline = stdoutBuffer.indexOf("\n");
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) responses.push(JSON.parse(line));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const waitForResponse = async (id: string) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const response = responses.find(
          (candidate) => candidate.type === "response" && candidate.id === id,
        );
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`worker response timeout:${id}:${stderr}`);
    };

    try {
      child.stdin.write(
        `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
      );
      assert.equal((await waitForResponse("state")).success, true);
      child.stdin.write(`${JSON.stringify({ id: "abort", type: "abort" })}\n`);
      assert.equal((await waitForResponse("abort")).success, true);
    } finally {
      child.kill("SIGTERM");
    }
    const exit = await exited;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
