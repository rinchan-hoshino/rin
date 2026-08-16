import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
await import("../support/register-worker-pool-owner-fixture.ts");
const { WorkerPool } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "worker-pool.js"),
  ).href
);
const turnLedger = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "turn-ledger.js"),
  ).href
);
const ownerGlobal = globalThis as any;
const spawnCalls = ownerGlobal.__rinWorkerPoolOwnerSpawnCalls as any[][];

const activeDirs = new Set<string>();
const activePools = new Set<any>();
const activeChildren = new Set<any>();
const originalCreateWorker = WorkerPool.prototype.createWorker;

WorkerPool.prototype.createWorker = function trackedCreateWorker(...args) {
  activePools.add(this);
  const worker = originalCreateWorker.apply(this, args);
  activeChildren.add(worker.child);
  worker.child.once("exit", () => {
    activeChildren.delete(worker.child);
  });
  return worker;
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCommandLog(logPath: string) {
  try {
    return (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForCommandLogPrefix(
  logPath: string,
  expected: string[],
  timeoutMs = 1000,
) {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() <= deadline) {
    try {
      last = await readCommandLog(logPath);
      if (expected.every((item, index) => last[index] === item)) return last;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(10);
  }
  return last;
}

async function waitForChildExit(child: any, timeoutMs = 1000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

afterEach(async () => {
  for (const pool of activePools) {
    pool.destroyAll();
  }
  activePools.clear();
  const children = Array.from(activeChildren);
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  await Promise.all(children.map((child) => waitForChildExit(child)));
  activeChildren.clear();
  for (const dir of activeDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  activeDirs.clear();
});

test("daemon workers spawn through the isolated Node lifecycle without a console window", async () => {
  const dir = await makeTempDir("rin-worker-pool-spawn-options-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  spawnCalls.length = 0;
  const resourceOptionsDir = path.join(dir, "worker-options");
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 50,
    resourceOptionsDir,
  });

  const worker = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][0], process.execPath);
  assert.equal(spawnCalls[0][1][0], workerPath);
  assert.deepEqual(spawnCalls[0][1].slice(1, 2), ["--resource-options-file"]);
  assert.equal(path.dirname(spawnCalls[0][1][2]), resourceOptionsDir);
  assert.equal(spawnCalls[0][2].cwd, dir);
  assert.deepEqual(spawnCalls[0][2].stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(spawnCalls[0][2].windowsHide, true);
  assert.ok(Number.isInteger(worker.child.pid) && worker.child.pid > 0);
});

test("worker-pool injected-spawn branch: worker cgroup attachment completes before the worker is returned", async () => {
  const dir = await makeTempDir("rin-worker-pool-cgroup-order-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const attached: Array<{ workerId: string; pid: number }> = [];
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 5000,
    workerCgroupIsolation: {
      attachWorker(workerId: string, pid: number) {
        attached.push({ workerId, pid });
        return {
          wasOomKilled: () => false,
          cleanup: async () => true,
        };
      },
    },
  });

  const worker = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );

  assert.deepEqual(attached, [{ workerId: worker.id, pid: worker.child.pid! }]);
  assert.ok(worker.cgroupLease);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: worker creation fails closed when cgroup attachment fails", async () => {
  const dir = await makeTempDir("rin-worker-pool-cgroup-failure-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  let spawnedPid = 0;
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 5000,
    workerCgroupIsolation: {
      attachWorker(_workerId: string, pid: number) {
        spawnedPid = pid;
        throw new Error("cgroup attach failed");
      },
    },
  });

  assert.throws(
    () =>
      pool.resolveWorkerForCommand(
        { socket: { destroyed: false, write() {} }, clientBuffer: "" },
        { type: "new_session" },
      ),
    /cgroup attach failed/,
  );
  assert.ok(spawnedPid > 0);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!fsSync.existsSync(`/proc/${spawnedPid}`)) break;
    await sleep(10);
  }
  assert.equal(fsSync.existsSync(`/proc/${spawnedPid}`), false);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

async function makeTempDir(prefix) {
  const root = process.env.RIN_TEST_TMPDIR ?? os.tmpdir();
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, prefix));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}\n');
  activeDirs.add(dir);
  return dir;
}

test("worker-pool injected-spawn branch: new session workers receive rpc resource options through a private file", async () => {
  const dir = await makeTempDir("rin-worker-pool-resources-");
  const outputPath = path.join(dir, "resource-options.json");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    `import fs from "node:fs";\nconst index = process.argv.indexOf("--resource-options-file");\nconst file = index >= 0 ? process.argv[index + 1] : "";\nfs.writeFileSync(${JSON.stringify(outputPath)}, file ? fs.readFileSync(file, "utf8") : "");\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
  );

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 50,
    resourceOptionsDir: path.join(dir, "worker-options"),
  });
  const worker = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    {
      type: "new_session",
      resourceOptions: {
        additionalExtensionPaths: ["/ext"],
        noExtensions: true,
        extensionFlagValues: [["flag", true]],
        tools: ["read", "grep"],
        excludeTools: ["grep"],
        noTools: "builtin",
        additionalSkillPaths: ["/skill"],
        noSkills: true,
        additionalPromptTemplatePaths: ["/prompt"],
        noPromptTemplates: true,
        additionalThemePaths: ["/theme"],
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "system",
        appendSystemPrompt: ["append"],
      },
    },
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const raw = await fs.readFile(outputPath, "utf8");
      assert.deepEqual(JSON.parse(raw), {
        additionalExtensionPaths: ["/ext"],
        noExtensions: true,
        extensionFlagValues: [["flag", true]],
        tools: ["read", "grep"],
        excludeTools: ["grep"],
        noTools: "builtin",
        additionalSkillPaths: ["/skill"],
        noSkills: true,
        additionalPromptTemplatePaths: ["/prompt"],
        noPromptTemplates: true,
        additionalThemePaths: ["/theme"],
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "system",
        appendSystemPrompt: ["append"],
        __rinInitialSession: { kind: "new" },
      });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await sleep(25);
    }
  }
});

test("worker-pool injected-spawn branch: getRestorableSessionSelectors keeps live session workers and remembers turn state", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );
  worker.sessionFile = "/tmp/test-session.jsonl";
  worker.turnActive = false;

  assert.deepEqual(pool.getRestorableSessionSelectors(), [
    { sessionFile: "/tmp/test-session.jsonl", resumeTurn: false },
  ]);

  worker.turnActive = true;
  assert.deepEqual(pool.getRestorableSessionSelectors(), [
    { sessionFile: "/tmp/test-session.jsonl", resumeTurn: true },
  ]);

  worker.turnActive = false;
  worker.pendingResponses.set("prompt-1", {
    id: "prompt-1",
    commandType: "prompt",
  });
  assert.deepEqual(pool.getRestorableSessionSelectors(), [
    { sessionFile: "/tmp/test-session.jsonl", resumeTurn: true },
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: getRestorableSessionSelectors normalizes duplicate session files and preserves resume intent", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const first = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );
  first.sessionFile = " /tmp/test-session.jsonl ";
  first.turnActive = false;
  const second = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );
  second.sessionFile = "/tmp/test-session.jsonl";
  second.turnActive = true;

  assert.deepEqual(pool.getRestorableSessionSelectors(), [
    { sessionFile: "/tmp/test-session.jsonl", resumeTurn: true },
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: restoreSessionWorker only attaches the session worker", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import process from "node:process";
const logPath = ${JSON.stringify(logPath)};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    fs.appendFileSync(logPath, command.type + "\\n");
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  pool.restoreSessionWorker({ sessionFile: "/tmp/session.jsonl" });
  await sleep(100);

  assert.deepEqual(await readCommandLog(logPath), []);
  assert.equal(
    pool.getStatusSnapshot().workers[0]?.sessionFile,
    "/tmp/session.jsonl",
  );

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("an idle worker rejects an unowned versioned start without metadata changes", async () => {
  const dir = await makeTempDir("rin-worker-pool-unowned-start-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const writes: string[] = [];
  const connection = {
    socket: {
      destroyed: false,
      write(value: string) {
        writes.push(String(value));
      },
    },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, agentDir: dir });
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.attachWorkerToConnection(connection, worker);
  const metadataBefore = {
    sessionFile: worker.sessionFile,
    sessionId: worker.sessionId,
    turnActive: worker.turnActive,
    turnRecoveryPending: worker.turnRecoveryPending,
    activeRequestTag: worker.activeRequestTag,
    activeTurnGeneration: worker.activeTurnGeneration,
    activeLifecycleRequestTag: worker.activeLifecycleRequestTag,
    lastTurnGeneration: worker.lastTurnGeneration,
    versionedLifecycleSeen: worker.versionedLifecycleSeen,
    legacyTurnActive: worker.legacyTurnActive,
    legacyTurnSettled: worker.legacyTurnSettled,
  };

  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rpc_turn_event",
      event: "start",
      turnGeneration: 7,
      requestTag: "orphan",
      sessionFile,
      sessionId: "orphan-session",
    })}\n`,
  );
  await sleep(10);

  assert.deepEqual(
    {
      sessionFile: worker.sessionFile,
      sessionId: worker.sessionId,
      turnActive: worker.turnActive,
      turnRecoveryPending: worker.turnRecoveryPending,
      activeRequestTag: worker.activeRequestTag,
      activeTurnGeneration: worker.activeTurnGeneration,
      activeLifecycleRequestTag: worker.activeLifecycleRequestTag,
      lastTurnGeneration: worker.lastTurnGeneration,
      versionedLifecycleSeen: worker.versionedLifecycleSeen,
      legacyTurnActive: worker.legacyTurnActive,
      legacyTurnSettled: worker.legacyTurnSettled,
    },
    metadataBefore,
  );
  assert.equal(writes.length, 0);
});

test("worker-pool injected-spawn branch: non-turn resumable worker commands persist a running record until they finish", async () => {
  const dir = await makeTempDir("rin-worker-pool-running-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  const statePath = path.join(
    dir,
    "data",
    "core",
    "workers",
    "running-workers.json",
  );
  await fs.writeFile(
    workerPath,
    String.raw`process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { sessionFile: command.sessionFile, sessionId: 'active' },
      }) + '\n');
    }, 100);
  }
});
setInterval(() => {}, 1000);
`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 50,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  worker.sessionFile = sessionFile;
  pool.requestWorker(
    worker,
    connection,
    { id: "compact-1", type: "compact", sessionFile },
    true,
  );

  const runningState = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(runningState, {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
  });

  await sleep(180);

  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [],
  });

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: detached worker survives eviction while response is pending", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    String.raw`process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === 'sleep_session') process.exit(0);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { ok: true },
      }) + '\n');
    }, 50);
  }
});
setInterval(() => {}, 1000);
`,
  );

  const writes = [];
  const connection = {
    socket: {
      destroyed: false,
      write(value) {
        writes.push(String(value));
      },
    },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.requestWorker(
    worker,
    connection,
    { id: "req_1", type: "get_commands" },
    false,
  );
  pool.evictDetachedWorkers();

  await sleep(200);

  assert.equal(writes.length > 0, true);
  const payload = JSON.parse(writes[0]);
  assert.equal(payload.id, "req_1");
  assert.equal(payload.success, true);

  await sleep(80);
  pool.evictDetachedWorkers();
  for (let i = 0; i < 100; i += 1) {
    if (pool.getStatusSnapshot().workerCount === 0) break;
    await sleep(10);
  }
  assert.equal(pool.getStatusSnapshot().workerCount, 0);
});

test("worker-pool injected-spawn branch: attached idle worker sleeps while preserving the selected session", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  const commandPath = path.join(dir, "attached-idle-commands.jsonl");
  const sessionFile = "/tmp/attached-idle.jsonl";
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    fs.appendFileSync(${JSON.stringify(commandPath)}, command.type + '\n');
    if (command.type === 'sleep_session') process.exit(0);
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: { sessionFile: command.sessionPath || ${JSON.stringify(sessionFile)}, sessionId: 'attached-idle' },
    }) + '\n');
  }
});
setInterval(() => {}, 1000);
`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 20,
    sweepIntervalMs: 10,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.setWorkerSessionRefs(worker, {
    sessionFile,
    sessionId: "attached-idle",
  });
  pool.attachWorker(connection, worker);

  for (let i = 0; i < 200; i += 1) {
    if (pool.getStatusSnapshot().workerCount === 0) break;
    await sleep(10);
  }

  assert.equal(pool.getStatusSnapshot().workerCount, 0);
  assert.equal(connection.attachedWorker, undefined);
  assert.equal(connection.sessionFile, sessionFile);
  assert.equal(connection.sessionId, "attached-idle");

  const replacement = await pool.ensureSelectedWorker(connection);

  assert.equal(Boolean(replacement), true);
  assert.equal(connection.attachedWorker, replacement);
  assert.equal(pool.getStatusSnapshot().workerCount, 1);
  assert.deepEqual(
    (await fs.readFile(commandPath, "utf8")).trim().split("\n"),
    ["sleep_session"],
  );

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("selected session recovery ignores workers that are already stopping", async () => {
  const dir = await makeTempDir("rin-worker-pool-stopping-route-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  const sessionFile = "/tmp/stopping-route.jsonl";
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
const logPath = ${JSON.stringify(logPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    fs.appendFileSync(logPath, command.type + '\n');
    if (command.type === 'sleep_session') {
      setTimeout(() => process.exit(0), 250);
      continue;
    }
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: { cancelled: false, sessionFile, sessionId: 'stopping-route' },
    }) + '\n');
  }
});
setInterval(() => {}, 1000);
`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const original = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.setWorkerSessionRefs(original, {
    sessionFile,
    sessionId: "stopping-route",
  });
  pool.attachWorker(connection, original);

  pool.sleepWorkerGracefully(original);
  await waitForCommandLogPrefix(logPath, ["sleep_session"]);

  const replacement = await pool.ensureSelectedWorker(connection);

  assert.ok(replacement);
  assert.notEqual(replacement, original);
  assert.equal(connection.attachedWorker, replacement);
  assert.deepEqual((await fs.readFile(logPath, "utf8")).trim().split("\n"), [
    "sleep_session",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: detached idle worker sleeps instead of terminating the session", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  const commandPath = path.join(dir, "commands.jsonl");
  await fs.writeFile(
    workerPath,
    `import fs from "node:fs";\nlet buffer = "";\nprocess.on("SIGTERM", () => {\n  fs.appendFileSync(${JSON.stringify(commandPath)}, JSON.stringify({ signal: "SIGTERM" }) + "\\n");\n  process.exit(0);\n});\nprocess.stdin.on("data", (chunk) => {\n  buffer += String(chunk);\n  let index;\n  while ((index = buffer.indexOf("\\n")) >= 0) {\n    const line = buffer.slice(0, index).trim();\n    buffer = buffer.slice(index + 1);\n    if (!line) continue;\n    const command = JSON.parse(line);\n    fs.appendFileSync(${JSON.stringify(commandPath)}, JSON.stringify({ type: command.type }) + "\\n");\n    if (command.type === "get_state") {\n      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");\n    }\n    if (command.type === "sleep_session") process.exit(0);\n  }\n});\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 20,
    sweepIntervalMs: 10,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.requestWorker(worker, connection, { type: "get_state" }, true);
  pool.detachWorker(connection);

  await sleep(350);

  assert.equal(worker.idleSince !== null, true);
  assert.equal(pool.getStatusSnapshot().workerCount, 0);
  const commands = (await fs.readFile(commandPath, "utf8"))
    .trim()
    .split(/\n+/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    commands.map((command) => command.type || command.signal),
    ["get_state", "sleep_session"],
  );

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: detached worker stays alive while turnActive is true even if streaming is false", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 20,
    sweepIntervalMs: 10,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  worker.turnActive = true;
  pool.detachWorker(connection);

  await sleep(80);

  assert.equal(pool.getStatusSnapshot().workerCount, 1);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: remembered session selection can pull a replacement worker without an explicit switch", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  const sessionFile = "/tmp/remembered-session.jsonl";
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
const logPath = ${JSON.stringify(logPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
function log(type) {
  fs.appendFileSync(logPath, String(type) + '\n');
}
process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    log(command.type);
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: command.type === 'switch_session'
        ? { cancelled: false, sessionFile, sessionId: 'remembered-session' }
        : { sessionFile, sessionId: 'remembered-session', isStreaming: false, isCompacting: false },
    }) + '\n');
  }
});
setInterval(() => {}, 1000);
`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  await pool.selectSession(connection, { sessionFile });
  const firstWorker = connection.attachedWorker;

  assert.equal(Boolean(firstWorker), true);
  assert.equal(connection.sessionFile, sessionFile);

  pool.detachWorker(connection);
  pool.destroyWorker(firstWorker);

  const replacement = await pool.ensureSelectedWorker(connection);

  assert.equal(Boolean(replacement), true);
  assert.notEqual(replacement, firstWorker);
  assert.equal(connection.attachedWorker, replacement);
  assert.equal(pool.getStatusSnapshot().workerCount, 1);
  assert.deepEqual(await readCommandLog(logPath), []);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: selectSession shuts down the previous session before resuming another session", async () => {
  const dir = await makeTempDir("rin-worker-pool-select-shutdown-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
const logPath = ${JSON.stringify(logPath)};
function log(type) {
  fs.appendFileSync(logPath, String(type) + '\n');
}
process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    log(command.type);
    if (command.type === 'shutdown_session') process.exit(0);
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: { cancelled: false, sessionFile: command.sessionPath, sessionId: 'selected-session' },
    }) + '\n');
  }
});
setInterval(() => {}, 1000);
`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const current = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.setWorkerSessionRefs(current, {
    sessionFile: "/tmp/current.jsonl",
    sessionId: "current-session",
  });
  pool.attachWorker(connection, current);

  const selected = await pool.selectSession(connection, {
    sessionFile: "/tmp/selected.jsonl",
  });

  assert.notEqual(selected, current);
  assert.equal(connection.attachedWorker, selected);
  assert.equal(connection.sessionFile, "/tmp/selected.jsonl");
  const commands = await waitForCommandLogPrefix(logPath, ["shutdown_session"]);
  assert.equal(commands[0], "shutdown_session");
  assert.equal(commands.includes("switch_session"), false);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: selectSession keeps a previous session alive while another connection is still attached", async () => {
  const dir = await makeTempDir("rin-worker-pool-select-shared-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
const logPath = ${JSON.stringify(logPath)};
function log(type) {
  fs.appendFileSync(logPath, String(type) + '\n');
}
process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    log(command.type);
    if (command.type === 'shutdown_session') process.exit(0);
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: { cancelled: false, sessionFile: command.sessionPath, sessionId: 'selected-session' },
    }) + '\n');
  }
});
setInterval(() => {}, 1000);
`,
  );

  const switchingConnection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const remainingConnection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const current = pool.resolveWorkerForCommand(switchingConnection, {
    type: "new_session",
  });
  pool.setWorkerSessionRefs(current, {
    sessionFile: "/tmp/current.jsonl",
    sessionId: "current-session",
  });
  pool.attachWorker(switchingConnection, current);
  pool.attachWorker(remainingConnection, current);

  const selected = await pool.selectSession(switchingConnection, {
    sessionFile: "/tmp/selected.jsonl",
  });

  assert.notEqual(selected, current);
  assert.equal(switchingConnection.attachedWorker, selected);
  assert.equal(remainingConnection.attachedWorker, current);
  assert.equal(current.gracefulShutdownRequested, false);
  assert.deepEqual(await readCommandLog(logPath), []);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: selectSession lazily restores the chosen session worker", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    String.raw`process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: command.type === 'switch_session'
        ? { cancelled: false, sessionFile: command.sessionPath, sessionId: 'selected-session' }
        : { sessionFile: command.sessionPath || '/tmp/selected.jsonl', sessionId: 'selected-session', isStreaming: false, isCompacting: false },
    }) + '\n');
  }
});
setInterval(() => {}, 1000);
`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = await pool.selectSession(connection, {
    sessionFile: "/tmp/selected.jsonl",
  });
  const sameWorker = await pool.ensureSelectedWorker(connection);

  assert.equal(worker?.sessionFile, "/tmp/selected.jsonl");
  assert.equal(connection.attachedWorker, worker);
  assert.equal(connection.sessionFile, "/tmp/selected.jsonl");
  assert.equal(sameWorker, worker);
  assert.equal(pool.getStatusSnapshot().workerCount, 1);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: concurrent selectSession calls reuse one worker for the same session", async () => {
  const dir = await makeTempDir("rin-worker-pool-concurrent-select-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = "/tmp/concurrent-selected.jsonl";
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const firstConnection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const secondConnection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const [firstWorker, secondWorker] = await Promise.all([
    pool.selectSession(firstConnection, { sessionFile }),
    pool.selectSession(secondConnection, { sessionFile }),
  ]);

  assert.equal(firstWorker, secondWorker);
  assert.equal(firstConnection.attachedWorker, firstWorker);
  assert.equal(secondConnection.attachedWorker, firstWorker);
  assert.equal(pool.getStatusSnapshot().workerCount, 1);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: duplicate restoreSessionWorker calls converge to one session worker", async () => {
  const dir = await makeTempDir("rin-worker-pool-restore-dedupe-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = "/tmp/restore-dedupe.jsonl";
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const first = pool.restoreSessionWorker({ sessionFile });
  const second = pool.restoreSessionWorker({ sessionFile });

  const status = pool.getStatusSnapshot();
  assert.equal(first, second);
  assert.equal(status.workerCount, 1);
  assert.equal(status.workers[0]?.sessionFile, sessionFile);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: restoreSessionWorker indexes the session when creating an initial-session worker", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = "/tmp/restored-initial-session.jsonl";
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.restoreSessionWorker({ sessionFile });

  assert.equal(worker?.sessionFile, sessionFile);
  assert.equal(
    pool
      .getStatusSnapshot()
      .workers.some((worker) => worker.sessionFile === sessionFile),
    true,
  );

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: worker events are forwarded only to matching selected session", async () => {
  const dir = await makeTempDir("rin-worker-pool-session-filter-");
  const workerPath = path.join(dir, "worker-source");
  const sessionA = path.join(dir, "a.jsonl");
  const sessionB = path.join(dir, "b.jsonl");
  await fs.writeFile(
    workerPath,
    `process.stdin.resume();
setInterval(() => {}, 1000);
`,
  );

  const writes: string[] = [];
  const connection = {
    socket: {
      destroyed: false,
      write(chunk: string) {
        writes.push(String(chunk));
      },
    },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  worker.sessionFile = sessionA;
  pool.attachWorker(connection, worker);
  connection.sessionFile = sessionB;

  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "test_event", sessionFile: sessionA })}\n`,
  );
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "test_event", sessionFile: sessionB })}\n`,
  );
  await sleep(20);

  const forwarded = writes
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].sessionFile, sessionB);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: selectSession with only sessionId ignores stale remembered sessionFile", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const originalWorker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  const targetWorker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });

  pool.setWorkerSessionRefs(originalWorker, {
    sessionFile: "/tmp/original.jsonl",
    sessionId: "original-session",
  });
  pool.setWorkerSessionRefs(targetWorker, {
    sessionId: "target-session",
  });
  pool.attachWorker(connection, originalWorker);

  const selected = await pool.selectSession(connection, {
    sessionId: "target-session",
  });

  assert.equal(selected, targetWorker);
  assert.equal(connection.attachedWorker, targetWorker);
  assert.equal(connection.sessionFile, undefined);
  assert.equal(connection.sessionId, "target-session");

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: worker session ref updates clear stale attached connection selectors", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });

  pool.setWorkerSessionRefs(worker, {
    sessionFile: "/tmp/original.jsonl",
    sessionId: "original-session",
  });
  pool.attachWorker(connection, worker);
  pool.setWorkerSessionRefs(worker, {
    sessionId: "memory-session",
  });

  assert.equal(connection.attachedWorker, worker);
  assert.equal(connection.sessionFile, undefined);
  assert.equal(connection.sessionId, "memory-session");

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: worker OOM is reported without turning it into an ordinary exit", async () => {
  const dir = await makeTempDir("rin-worker-pool-oom-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "setTimeout(() => process.exit(33), 100); process.stdin.resume();\n",
  );

  const writes: string[] = [];
  const cleaned: string[] = [];
  const connection = {
    socket: { destroyed: false, write: (line: string) => writes.push(line) },
    clientBuffer: "",
  };
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 5000,
    workerCgroupIsolation: {
      attachWorker(workerId: string) {
        return {
          wasOomKilled: () => true,
          cleanup: async () => {
            cleaned.push(workerId);
            return true;
          },
        };
      },
    },
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.attachWorker(connection, worker);

  await waitForChildExit(worker.child);
  await sleep(20);

  const events = writes.map((line) => JSON.parse(line));
  assert.ok(
    events.some(
      (event) =>
        event.type === "worker_oom" &&
        event.code === 33 &&
        event.signal === null,
    ),
  );
  assert.equal(
    events.some((event) => event.type === "worker_exit"),
    false,
  );
  assert.deepEqual(cleaned, [worker.id]);
});

test("worker-pool injected-spawn branch: graceful worker commands destroy workers with closed stdin", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );

  worker.child.stdin.end();
  await new Promise((resolve) => worker.child.stdin.once("finish", resolve));

  pool.sleepWorkerGracefully(worker);

  assert.equal(pool.getStatusSnapshot().workerCount, 0);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: internal worker commands time out cleanly without leaking late responses", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    String.raw`process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { sessionFile: '/tmp/delayed.jsonl', sessionId: 'delayed-session' },
      }) + '\n');
    }, 80);
  }
});
setInterval(() => {}, 1000);
`,
  );

  const writes = [];
  const connection = {
    socket: {
      destroyed: false,
      write(value) {
        writes.push(String(value));
      },
    },
    clientBuffer: "",
  };

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 50,
    internalCommandTimeoutMs: 20,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.attachWorker(connection, worker);

  await assert.rejects(
    pool.sendInternalCommand(worker, {
      type: "switch_session",
      sessionPath: "/tmp/delayed.jsonl",
    }),
    /rin_internal_timeout:switch_session/,
  );
  await sleep(150);

  assert.equal(worker.pendingResponses.size, 0);
  assert.deepEqual(writes, []);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: internal worker commands reject closed stdin without unhandled stream errors", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 50,
    internalCommandTimeoutMs: 200,
  });
  const worker = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );

  worker.child.stdin.end();
  await new Promise((resolve) => worker.child.stdin.once("finish", resolve));

  await assert.rejects(
    pool.sendInternalCommand(worker, {
      type: "switch_session",
      sessionPath: "/tmp/closed-stdin.jsonl",
    }),
    /rin_worker_stdin_unavailable:switch_session/,
  );

  assert.equal(worker.pendingResponses.size, 0);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: internal worker commands handle async stdin write errors", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 50,
    internalCommandTimeoutMs: 200,
  });
  const worker = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );

  const originalWrite = worker.child.stdin.write.bind(worker.child.stdin);
  worker.child.stdin.write = ((chunk: any, callback?: any) => {
    const error = new Error("synthetic async stdin failure");
    queueMicrotask(() => callback?.(error));
    return true;
  }) as typeof worker.child.stdin.write;

  await assert.rejects(
    pool.sendInternalCommand(worker, {
      type: "switch_session",
      sessionPath: "/tmp/async-write-error.jsonl",
    }),
    /synthetic async stdin failure/,
  );

  worker.child.stdin.write = originalWrite;
  assert.equal(worker.pendingResponses.size, 0);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: switch_session internal commands can outlive the generic internal timeout", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    String.raw`process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { sessionFile: '/tmp/slow-switch.jsonl', sessionId: 'slow-switch' },
      }) + '\n');
    }, 80);
  }
});
setInterval(() => {}, 1000);
`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 50,
    internalCommandTimeoutMs: 20,
    switchSessionCommandTimeoutMs: 200,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.attachWorker(connection, worker);

  const result = await pool.sendInternalCommand(worker, {
    type: "switch_session",
    sessionPath: "/tmp/slow-switch.jsonl",
  });

  assert.equal(result?.data?.sessionFile, "/tmp/slow-switch.jsonl");

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker-pool injected-spawn branch: worker status snapshot exposes graceful shutdown state", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );

  pool.terminateWorkerGracefully(worker);

  const status = pool.getStatusSnapshot();
  assert.equal(status.activeWorkerCount, 0);
  assert.equal(status.workers[0]?.gracefulShutdownRequested, true);
  assert.equal(status.workers[0]?.state, "stopping");

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker pool defaults tolerate an unknown command without synthetic resource options", async () => {
  const dir = await makeTempDir("rin-worker-pool-default-fallbacks-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 0 });
  const internals = pool as any;
  const before = spawnCalls.length;
  const worker = internals.createWorker();
  assert.deepEqual(spawnCalls[before][1], [workerPath]);

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  assert.equal(pool.resolveWorkerForCommand(connection, undefined), undefined);
  pool.requestWorker(worker, connection, undefined, false);
  assert.equal(pool.getStatusSnapshot().workerCount, 1);
  pool.evictDetachedWorkers();
  assert.equal(pool.getStatusSnapshot().workerCount, 0);
});

test("worker output integration forwards raw stdout, stderr, and activity state transitions", async () => {
  const dir = await makeTempDir("rin-worker-pool-output-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const writes: string[] = [];
  const connection = {
    socket: {
      destroyed: false,
      write(value: string) {
        writes.push(String(value));
      },
    },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 5_000 });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.attachWorkerToConnection(connection, worker);

  worker.child.stdout.emit("data", "owner raw stdout\n");
  worker.child.stderr.emit("data", "owner stderr\n");
  worker.child.stdout.emit(
    "data",
    [
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "rin_working_start" },
      { type: "rin_working_end" },
      { type: "compaction_start" },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  assert.equal(pool.getStatusSnapshot().workers[0]?.state, "compacting");
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "compaction_end" })}\n`,
  );
  assert.notEqual(pool.getStatusSnapshot().workers[0]?.state, "compacting");
  assert.equal(writes[0], "owner raw stdout\n");
  assert.deepEqual(JSON.parse(writes[1]), {
    type: "stderr",
    line: "owner stderr",
  });
});

test("worker creation fails closed when the isolated spawn fixture reports no pid", async () => {
  const dir = await makeTempDir("rin-worker-pool-no-pid-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  let child: any;
  ownerGlobal.__rinWorkerPoolOwnerSpawn = (...args: any[]) => {
    child = realSpawn(args[0], args[1], args[2]);
    Object.defineProperty(child, "pid", { value: undefined });
    return child;
  };
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    workerCgroupIsolation: {
      attachWorker() {
        throw new Error("must not attach without pid");
      },
    },
  });
  try {
    assert.throws(
      () =>
        pool.resolveWorkerForCommand(
          { socket: { destroyed: false, write() {} }, clientBuffer: "" },
          { type: "new_session" },
        ),
      /process id is unavailable/,
    );
    await waitForChildExit(child);
  } finally {
    delete ownerGlobal.__rinWorkerPoolOwnerSpawn;
    pool.destroyAll();
  }
});

test("cgroup cleanup failure rejects pending work without recovering the session", async () => {
  const dir = await makeTempDir("rin-worker-pool-cleanup-failure-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.once('data', () => setTimeout(() => process.exit(7), 20)); process.stdin.resume();\n",
  );
  const writes: string[] = [];
  const connection = {
    socket: { destroyed: false, write: (value: string) => writes.push(value) },
    clientBuffer: "",
  };
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 5_000,
    workerCgroupIsolation: {
      attachWorker() {
        return {
          wasOomKilled: () => false,
          async cleanup() {
            throw new Error("cleanup failed");
          },
        };
      },
    },
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.setWorkerSessionRefs(worker, {
    sessionFile: "/tmp/cleanup-failure.jsonl",
    sessionId: "cleanup-failure",
  });
  pool.forwardToWorker(connection, worker, {
    id: "cleanup-pending",
    type: "get_state",
  });
  await waitForChildExit(worker.child);
  const deadline = Date.now() + 1_000;
  while (writes.length < 2 && Date.now() <= deadline) {
    await sleep(10);
  }

  const payloads = writes.map((line) => JSON.parse(line));
  assert.equal(payloads[0]?.type, "worker_exit");
  assert.equal(payloads[1]?.error, "rin_worker_cleanup_failed");
  assert.equal(pool.getStatusSnapshot().workerCount, 0);
});

function createOwnerSyntheticWorker(options: any = {}) {
  const child = new EventEmitter() as any;
  child.exitCode = options.exitCode ?? null;
  child.signalCode = options.signalCode ?? null;
  child.stdin = {
    destroyed: Boolean(options.stdinDestroyed),
    write(_data: unknown, callback: (error?: Error | null) => void) {
      if (options.writeError) callback(new Error("owner write failed"));
      else callback(null);
      if (options.exitOnWrite) {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0, null));
      }
      return true;
    },
    end() {
      if (options.throwOnCleanup) throw new Error("stdin cleanup");
    },
  };
  child.stdout = {
    destroy() {
      if (options.throwOnCleanup) throw new Error("stdout cleanup");
    },
  };
  child.stderr = {
    destroy() {
      if (options.throwOnCleanup) throw new Error("stderr cleanup");
    },
  };
  child.kill = (signal: string) => {
    if (options.throwOnKill) throw new Error("kill failed");
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return {
    child,
    connections: new Set<any>(),
    pendingResponses: new Map<any, any>(),
    ignoredResponseIds: new Set<any>(),
    sessionFile: undefined,
    sessionId: undefined,
    sessionName: undefined,
    lastUsedAt: Date.now(),
    idleSince: null,
    gracefulShutdownRequested: false,
    recoveryStopRequested: false,
    recoveryStopTimer: undefined,
    activeLifecycleRequestTag: undefined,
    activeRequestTag: undefined,
    ...options.worker,
  } as any;
}

test("worker pool owner covers graceful exit completion, timeout, and unattached guards", async () => {
  const keepAlive = setTimeout(() => {}, 2_000);
  const dir = await makeTempDir("rin-worker-pool-graceful-owner-");
  const pool = new WorkerPool({
    workerPath: path.join(dir, "unused-worker.js"),
    cwd: dir,
    internalCommandTimeoutMs: 20,
  }) as any;
  activePools.add(pool);

  const absent = createOwnerSyntheticWorker();
  assert.equal(await pool.waitForWorkerExit(absent), true);
  await pool.requestWorkerExitGracefully(absent, { type: "shutdown_session" });

  const attached = createOwnerSyntheticWorker({ exitOnWrite: true });
  attached.connections.add({});
  pool.workers.add(attached);
  await pool.terminateWorkerGracefullyIfUnattached(attached);
  assert.equal(attached.gracefulShutdownRequested, false);
  attached.connections.clear();
  await pool.terminateWorkerGracefullyIfUnattached(attached);
  assert.equal(attached.gracefulShutdownRequested, true);

  const alreadyExited = createOwnerSyntheticWorker({ exitCode: 0 });
  pool.workers.add(alreadyExited);
  assert.equal(await pool.waitForWorkerExit(alreadyExited), true);

  const writeFailure = createOwnerSyntheticWorker({
    writeError: true,
    throwOnCleanup: true,
    throwOnKill: true,
  });
  pool.workers.add(writeFailure);
  await pool.requestWorkerExitGracefully(writeFailure, {
    type: "sleep_session",
  });
  assert.equal(pool.workers.has(writeFailure), false);

  const timeoutWorker = createOwnerSyntheticWorker({ throwOnCleanup: true });
  pool.workers.add(timeoutWorker);
  assert.equal(await pool.waitForWorkerExit(timeoutWorker), false);
  assert.equal(pool.workers.has(timeoutWorker), false);
  clearTimeout(keepAlive);
});

test("worker pool owner covers destruction fanout, pending response forms, and recovery fencing", async () => {
  const dir = await makeTempDir("rin-worker-pool-destroy-owner-");
  const pool = new WorkerPool({
    workerPath: path.join(dir, "unused-worker.js"),
    cwd: dir,
    internalCommandTimeoutMs: 20,
  }) as any;
  activePools.add(pool);
  pool.shuttingDown = true;

  const writes: any[] = [];
  const connection = {
    socket: {
      destroyed: false,
      write(line: string) {
        writes.push(JSON.parse(line));
      },
    },
    clientBuffer: "",
  } as any;
  const worker = createOwnerSyntheticWorker({ throwOnCleanup: true });
  worker.connections.add(connection);
  connection.attachedWorker = worker;
  worker.pendingResponses.set("reject", {
    id: "reject",
    commandType: "prompt",
    finalize: () => writes.push("finalized-reject"),
    reject: (error: Error) => writes.push(error.message),
  });
  worker.pendingResponses.set("connection", {
    id: "connection",
    commandType: "get_state",
    finalize: () => writes.push("finalized-connection"),
    connection,
  });
  worker.ignoredResponseIds.add("ignored");
  pool.workers.add(worker);
  assert.equal(pool.destroyWorker(worker, { signal: "SIGKILL" }), true);
  assert.equal(connection.attachedWorker, undefined);
  assert.equal(worker.pendingResponses.size, 0);
  assert.equal(worker.ignoredResponseIds.size, 0);
  assert.ok(writes.some((item) => item === "rin_worker_exit"));
  assert.equal(pool.destroyWorker(worker), true);

  const recoveryWorker = createOwnerSyntheticWorker({
    throwOnKill: true,
    worker: { activeLifecycleRequestTag: "owner-recovery" },
  });
  pool.workers.add(recoveryWorker);
  assert.equal(pool.destroyWorker(recoveryWorker), false);
  assert.equal(recoveryWorker.recoveryStopRequested, true);
  pool.stopWorkerForRecovery(recoveryWorker);
  if (recoveryWorker.recoveryStopTimer) {
    clearTimeout(recoveryWorker.recoveryStopTimer);
    recoveryWorker.recoveryStopTimer = undefined;
  }
  pool.workers.delete(recoveryWorker);
  pool.stopWorkerForRecovery(recoveryWorker);
});

test("worker pool recovery admission isolates unrelated sessions", async () => {
  const dir = await makeTempDir("rin-worker-pool-recovery-isolation-owner-");
  const pool = new WorkerPool({
    workerPath: path.join(dir, "unused-worker.js"),
    cwd: dir,
    agentDir: dir,
  }) as any;
  activePools.add(pool);
  const activeSessionFile = path.join(dir, "active.jsonl");
  const unrelatedSessionFile = path.join(dir, "unrelated.jsonl");
  turnLedger.beginDaemonTurn(dir, {
    requestTag: "owner-active-session",
    sessionFile: activeSessionFile,
    sessionId: "active-session",
  });

  assert.equal(
    pool.isSessionRecoveryConverged({
      sessionFile: unrelatedSessionFile,
      sessionId: "unrelated-session",
    }),
    true,
  );
  assert.equal(
    pool.isSessionRecoveryConverged({ sessionFile: activeSessionFile }),
    false,
  );
  assert.equal(
    pool.isSessionRecoveryConverged({
      sessionFile: activeSessionFile,
      sessionId: "stale-session-id",
    }),
    false,
  );

  let unrelatedForwarded = false;
  const unrelated = createOwnerSyntheticWorker({
    worker: {
      sessionFile: unrelatedSessionFile,
      sessionId: "unrelated-session",
    },
  });
  unrelated.child.stdin.write = (
    _data: unknown,
    callback: (error?: Error | null) => void,
  ) => {
    unrelatedForwarded = true;
    callback(null);
    return true;
  };
  pool.workers.add(unrelated);
  pool.setWorkerSessionRefs(unrelated, {
    sessionFile: unrelatedSessionFile,
    sessionId: "unrelated-session",
  });
  const unrelatedResponses: any[] = [];
  const unrelatedConnection = {
    socket: {
      destroyed: false,
      write(line: string) {
        unrelatedResponses.push(JSON.parse(line));
      },
    },
    sessionFile: unrelatedSessionFile,
    sessionId: "unrelated-session",
  } as any;
  pool.requestWorker(
    unrelated,
    unrelatedConnection,
    { id: "unrelated-command", type: "run_command" },
    false,
  );
  assert.equal(unrelatedForwarded, true);
  assert.equal(
    unrelatedResponses.some((row) => row.error === "rin_daemon_recovering"),
    false,
  );

  const recovering = createOwnerSyntheticWorker({
    worker: {
      sessionFile: activeSessionFile,
      sessionId: "active-session",
    },
  });
  pool.workers.add(recovering);
  pool.setWorkerSessionRefs(recovering, {
    sessionFile: activeSessionFile,
    sessionId: "active-session",
  });
  const activeResponses: any[] = [];
  pool.requestWorker(
    recovering,
    {
      socket: {
        destroyed: false,
        write(line: string) {
          activeResponses.push(JSON.parse(line));
        },
      },
      sessionFile: activeSessionFile,
      sessionId: "active-session",
    } as any,
    { id: "active-command", type: "run_command" },
    false,
  );
  assert.equal(
    activeResponses.some((row) => row.error === "rin_daemon_recovering"),
    true,
  );

  recovering.activeLifecycleRequestTag = "owner-active-session";
  recovering.turnActive = true;
  assert.equal(
    pool.isSessionRecoveryConverged({ sessionId: "active-session" }),
    true,
  );
});

test("worker pool owner covers recovery admission, duplicate fencing, and lifecycle request routing", async () => {
  const dir = await makeTempDir("rin-worker-pool-request-owner-");
  const pool = new WorkerPool({
    workerPath: path.join(dir, "unused-worker.js"),
    cwd: dir,
    agentDir: dir,
    internalCommandTimeoutMs: 20,
  }) as any;
  activePools.add(pool);
  const writes: any[] = [];
  const connection = {
    socket: {
      destroyed: false,
      write(line: string) {
        writes.push(JSON.parse(line));
      },
    },
    clientBuffer: "",
    selectedSession: undefined,
  } as any;
  const worker = createOwnerSyntheticWorker({ exitOnWrite: false });
  Object.assign(worker, {
    stateEpoch: 1,
    turnActive: false,
    terminalPending: false,
    isStreaming: false,
    activeLifecycleOwnerCommandId: undefined,
    activeLifecycleFrontendOwner: undefined,
  });
  pool.workers.add(worker);

  pool.isSessionRecoveryConverged = () => false;
  pool.requestWorker(
    worker,
    connection,
    { id: "recovering", type: "prompt" },
    false,
  );
  pool.requestWorker(worker, connection, { type: "run_command" }, false);
  assert.ok(writes.some((row) => row.error === "rin_daemon_recovering"));

  pool.isSessionRecoveryConverged = () => true;
  worker.pendingResponses.set("duplicate", { id: "duplicate" });
  pool.requestWorker(
    worker,
    connection,
    { id: "duplicate", type: "get_state" },
    false,
  );
  worker.pendingResponses.clear();
  worker.activeLifecycleOwnerCommandId = "active-duplicate";
  pool.requestWorker(
    worker,
    connection,
    { id: "active-duplicate", type: "get_state" },
    false,
  );
  worker.activeLifecycleOwnerCommandId = undefined;

  worker.pendingResponses.set("in-flight", {
    id: "in-flight",
    inputSubmission: { requestTag: "in-flight-tag" },
  });
  pool.requestWorker(
    worker,
    connection,
    { id: "prompt-pending", type: "prompt", requestTag: "in-flight-tag" },
    false,
  );
  worker.pendingResponses.clear();

  pool.requestWorker(
    worker,
    connection,
    { id: "missing-tag", type: "send_user_message" },
    false,
  );
  pool.requestWorker(worker, connection, { type: "send_user_message" }, false);

  worker.activeLifecycleRequestTag = "already-active";
  pool.requestWorker(
    worker,
    connection,
    { id: "active-turn", type: "send_user_message", requestTag: "active-new" },
    false,
  );
  worker.activeLifecycleRequestTag = undefined;
  worker.turnActive = true;
  pool.requestWorker(
    worker,
    connection,
    {
      id: "running-turn",
      type: "send_user_message",
      requestTag: "running-new",
    },
    false,
  );
  worker.turnActive = false;

  pool.syncRunningWorkerRecordForSelector = () => {};
  pool.syncRunningWorkerRecord = () => {};
  pool.publishWorkerWorkingState = () => {};
  pool.attachWorker = (attachedConnection: any, attachedWorker: any) => {
    attachedConnection.attachedWorker = attachedWorker;
    attachedWorker.connections.add(attachedConnection);
  };
  pool.requestWorker(
    worker,
    connection,
    {
      id: "terminal-created",
      type: "send_user_message",
      requestTag: "owner-terminal-created",
      chatDeliveryContext: {
        turnId: "turn",
        chatKey: "telegram/owner:chat",
        messageId: "message",
      },
    },
    false,
  );
  worker.pendingResponses.clear();
  worker.activeLifecycleRequestTag = undefined;
  worker.activeLifecycleOwnerCommandId = undefined;
  worker.terminalPending = false;
  pool.requestWorker(
    worker,
    connection,
    {
      id: "terminal-duplicate",
      type: "send_user_message",
      requestTag: "owner-terminal-created",
    },
    false,
  );
  pool.requestWorker(
    worker,
    connection,
    {
      id: "prompt-rejoined",
      type: "prompt",
      requestTag: "owner-terminal-created",
    },
    false,
  );
  pool.requestWorker(
    worker,
    connection,
    {
      id: "prompt-new",
      type: "prompt",
      requestTag: "owner-prompt-new",
      sessionFile: path.join(dir, "owner.jsonl"),
    },
    true,
  );
  pool.requestWorker(
    worker,
    connection,
    { id: "ordinary", type: "get_state", sessionId: "owner-session" },
    false,
  );

  assert.ok(writes.some((row) => row.error === "rin_duplicate_command_id"));
  assert.ok(writes.some((row) => row.error === "rin_turn_admission_pending"));
  assert.ok(
    writes.some((row) => row.error === "rin_turn_request_tag_required"),
  );
  assert.ok(writes.some((row) => row.data?.duplicate === true));
  assert.equal(connection.attachedWorker, worker);
});

test("worker pool owner covers state reads, selection routing, snapshots, shutdown, and restoration", async () => {
  const dir = await makeTempDir("rin-worker-pool-routing-owner-");
  const pool = new WorkerPool({
    workerPath: path.join(dir, "unused-worker.js"),
    cwd: dir,
    agentDir: dir,
    internalCommandTimeoutMs: 20,
  }) as any;
  activePools.add(pool);
  const worker = createOwnerSyntheticWorker();
  Object.assign(worker, {
    stateEpoch: 2,
    sessionFile: path.join(dir, "one.jsonl"),
    sessionId: "one",
    sessionName: "One",
    turnActive: false,
    terminalPending: false,
    isStreaming: false,
    isCompacting: false,
    lastActivityAt: Date.now(),
  });
  pool.workers.add(worker);

  pool.sendInternalCommand = async () => ({
    success: false,
    error: "owner-state",
  });
  await assert.rejects(() => pool.readWorkerState(worker), /owner-state/);
  pool.sendInternalCommand = async () => ({ success: true });
  assert.deepEqual(await pool.readWorkerState(worker), {});
  pool.sendInternalCommand = async () => ({
    success: true,
    data: { owner: true },
  });
  assert.deepEqual(await pool.readWorkerState(worker, { timeoutMs: 1 }), {
    owner: true,
  });

  const connection = {
    socket: { destroyed: false, write() {} },
    selectedSession: undefined,
  } as any;
  assert.equal(pool.hasSelectedSession(connection), false);
  connection.sessionFile = worker.sessionFile;
  assert.equal(pool.hasSelectedSession(connection), true);
  connection.attachedWorker = worker;
  worker.connections.add(connection);
  pool.isWorkerRoutable = () => true;
  pool.workerMatchesSelector = () => true;
  assert.equal(await pool.ensureSelectedWorker(connection), worker);

  connection.attachedWorker = undefined;
  pool.findWorkerBySelector = () => worker;
  pool.attachWorker = (target: any, selected: any) => {
    target.attachedWorker = selected;
  };
  assert.equal(await pool.ensureSelectedWorker(connection), worker);
  connection.attachedWorker = undefined;
  pool.findWorkerBySelector = () => undefined;
  pool.findTrackedWorkerBySelector = () => ({ recoveryStopRequested: true });
  assert.equal(await pool.ensureSelectedWorker(connection), undefined);
  pool.findTrackedWorkerBySelector = () => undefined;
  pool.isSessionRecoveryConverged = () => false;
  assert.equal(await pool.ensureSelectedWorker(connection), undefined);
  pool.isSessionRecoveryConverged = () => true;
  pool.withSessionClaim = async (_selector: any, run: () => any) => await run();
  pool.createWorkerForSession = () => worker;
  assert.equal(await pool.ensureSelectedWorker(connection), worker);

  connection.attachedWorker = worker;
  pool.resolveSelector = () => ({});
  pool.findWorkerBySelector = () => undefined;
  assert.equal(
    pool.resolveCurrentWorkerForCommand(connection, { type: "get_state" }),
    worker,
  );
  pool.isWorkerRoutable = () => false;
  assert.equal(
    pool.resolveCurrentWorkerForCommand(connection, { type: "get_state" }),
    undefined,
  );

  const created = createOwnerSyntheticWorker();
  pool.createWorker = () => created;
  assert.equal(
    pool.resolveWorkerForCommand(connection, { type: "new_session" }),
    created,
  );
  assert.equal(
    pool.resolveWorkerForCommand(connection, {
      type: "new_session",
      resourceOptions: { owner: true },
      managedSessionLeaf: " owner-leaf ",
      parentSession: "parent",
    }),
    created,
  );
  assert.equal(
    pool.resolveWorkerForCommand(connection, {
      type: "new_session",
      parentSession: "parent",
    }),
    created,
  );
  pool.resolveCurrentWorkerForCommand = () => worker;
  assert.equal(
    pool.resolveWorkerForCommand(connection, { type: "get_state" }),
    worker,
  );
  pool.resolveCurrentWorkerForCommand = () => undefined;
  assert.equal(
    pool.resolveWorkerForCommand(connection, { type: "prompt" }),
    undefined,
  );

  pool.workers.delete(worker);
  await pool.abortWorker(worker);
  pool.workers.add(worker);
  worker.gracefulShutdownRequested = true;
  await pool.abortWorker(worker);
  worker.gracefulShutdownRequested = false;
  let aborted = false;
  pool.sendInternalCommand = async () => {
    aborted = true;
    return { success: true };
  };
  await pool.abortWorker(worker);
  assert.equal(aborted, true);

  worker.turnActive = true;
  worker.isStreaming = true;
  worker.isCompacting = true;
  worker.lastActivityAt = undefined;
  worker.activeRequestTag = "active";
  worker.activeLifecycleRequestTag = "lifecycle";
  worker.sessionFile = path.join(dir, "restorable.jsonl");
  const stopping = createOwnerSyntheticWorker({
    worker: { gracefulShutdownRequested: true },
  });
  pool.workers.add(stopping);
  const snapshot = pool.getStatusSnapshot();
  assert.equal(snapshot.workerCount, 2);
  assert.ok(snapshot.activeWorkerCount >= 1);
  const restorable = pool.getRestorableSessionSelectors();
  assert.ok(
    restorable.some((item: any) => item.sessionFile === worker.sessionFile),
  );
  worker.gracefulShutdownRequested = true;
  assert.ok(
    !pool
      .getRestorableSessionSelectors()
      .some((item: any) => item.sessionFile === worker.sessionFile),
  );

  pool.isSessionRecoveryConverged = () => false;
  assert.equal(
    pool.restoreSessionWorker({ sessionFile: path.join(dir, "restore.jsonl") }),
    undefined,
  );
  pool.isSessionRecoveryConverged = () => true;
  pool.restoreWorkerForSession = () => worker;
  assert.equal(
    pool.restoreSessionWorker({ sessionFile: path.join(dir, "restore.jsonl") }),
    worker,
  );

  pool.activeTurnRecoveryScanTimer = setTimeout(() => {}, 1_000);
  pool.activeTurnRecoveryTimers.set(
    "owner",
    setTimeout(() => {}, 1_000),
  );
  pool.activeTurnRecoveryAttempts.set("owner", 2);
  pool.maybeReleaseWorker = () => {};
  pool.beginShutdown();
  assert.equal(pool.activeTurnRecoveryTimers.size, 0);
  pool.activeTurnRecoveryScanTimer = setTimeout(() => {}, 1_000);
  pool.destroyWorker = (target: any) => {
    pool.workers.delete(target);
    return true;
  };
  pool.destroyAll();
  assert.equal(pool.workers.size, 0);
});

test("worker pool owner covers recovery schedulers, shared recovery, restoration races, and empty shutdown", async () => {
  const dir = await makeTempDir("rin-worker-pool-recovery-owner-");
  const pool = new WorkerPool({
    workerPath: path.join(dir, "unused-worker.js"),
    cwd: dir,
    agentDir: dir,
    internalCommandTimeoutMs: 20,
  }) as any;
  activePools.add(pool);

  let scans = 0;
  pool.recoverActiveDaemonTurns = async () => {
    scans += 1;
    return [];
  };
  pool.scheduleActiveDaemonTurnRecoveryScan();
  const scanTimer = pool.activeTurnRecoveryScanTimer;
  assert.ok(scanTimer);
  pool.scheduleActiveDaemonTurnRecoveryScan();
  clearTimeout(scanTimer);
  pool.activeTurnRecoveryScanTimer = undefined;
  pool.shuttingDown = true;
  pool.scheduleActiveDaemonTurnRecoveryScan();
  assert.equal(pool.activeTurnRecoveryScanTimer, undefined);
  pool.shuttingDown = false;

  pool.scheduleActiveDaemonTurnRecovery("owner-retry");
  const retryTimer = pool.activeTurnRecoveryTimers.get("owner-retry");
  assert.ok(retryTimer);
  assert.equal(retryTimer._idleTimeout, 500);
  pool.scheduleActiveDaemonTurnRecovery("owner-retry");
  clearTimeout(retryTimer);
  pool.activeTurnRecoveryTimers.clear();
  pool.shuttingDown = true;
  pool.scheduleActiveDaemonTurnRecovery("owner-shutdown-retry");
  assert.equal(pool.activeTurnRecoveryTimers.size, 0);
  pool.shuttingDown = false;

  const shared = Promise.resolve(true);
  pool.activeTurnRecoveryInFlight.set("owner-shared", shared);
  assert.equal(pool.recoverActiveDaemonTurn("owner-shared"), shared);
  pool.activeTurnRecoveryInFlight.delete("owner-shared");
  pool.shuttingDown = true;
  assert.equal(await pool.recoverActiveDaemonTurnOnce("owner-shutdown"), false);
  pool.shuttingDown = false;
  assert.equal(await pool.recoverActiveDaemonTurnOnce("owner-missing"), false);

  assert.equal(pool.restoreWorkerForSession({}), undefined);
  const recoveryStopped = createOwnerSyntheticWorker({
    worker: { recoveryStopRequested: true },
  });
  pool.findTrackedWorkerBySelector = () => recoveryStopped;
  assert.equal(
    pool.restoreWorkerForSession({
      sessionFile: path.join(dir, "stopped.jsonl"),
    }),
    undefined,
  );
  const existing = createOwnerSyntheticWorker();
  pool.findTrackedWorkerBySelector = () => undefined;
  pool.findWorkerBySelector = () => existing;
  assert.equal(
    pool.restoreWorkerForSession({
      sessionFile: path.join(dir, "existing.jsonl"),
    }),
    existing,
  );
  pool.findWorkerBySelector = () => undefined;
  pool.sessionClaimKey = () => "owner-claim";
  pool.pendingSessionClaims.set("owner-claim", Promise.resolve(undefined));
  assert.equal(
    pool.restoreWorkerForSession({
      sessionFile: path.join(dir, "claimed.jsonl"),
    }),
    undefined,
  );
  pool.pendingSessionClaims.clear();

  const created = createOwnerSyntheticWorker();
  pool.createWorkerForSession = () => created;
  pool.withSessionClaim = async (_selector: any, run: () => any) => await run();
  pool.findTrackedWorkerBySelector = () => undefined;
  assert.equal(
    pool.restoreWorkerForSession({
      sessionFile: path.join(dir, "created.jsonl"),
    }),
    created,
  );
  await new Promise((resolve) => setImmediate(resolve));

  const replacement = createOwnerSyntheticWorker();
  pool.findTrackedWorkerBySelector = () => replacement;
  pool.destroyWorker = () => true;
  assert.equal(
    pool.restoreWorkerForSession({ sessionFile: path.join(dir, "race.jsonl") }),
    created,
  );
  await new Promise((resolve) => setImmediate(resolve));
  replacement.recoveryStopRequested = true;
  assert.equal(
    pool.restoreWorkerForSession({
      sessionFile: path.join(dir, "race-stop.jsonl"),
    }),
    undefined,
  );

  pool.findTrackedWorkerBySelector = () => undefined;
  pool.findWorkerBySelector = () => undefined;
  pool.isSessionRecoveryConverged = () => true;
  assert.equal(pool.restoreSessionWorker({}), undefined);
  pool.isSessionRecoveryConverged = () => false;
  assert.equal(
    pool.restoreSessionWorker({
      sessionFile: path.join(dir, "not-converged.jsonl"),
    }),
    undefined,
  );

  pool.isSessionRecoveryConverged = () => true;
  pool.workers.clear();
  pool.destroyAll();
  assert.equal(scans, 0);
});

test("worker pool owner covers recovery timer callbacks, scan failure, missing sessions, and selector merging", async () => {
  const dir = await makeTempDir("rin-worker-pool-recovery-timers-owner-");
  const pool = new WorkerPool({
    workerPath: path.join(dir, "unused-worker.js"),
    cwd: dir,
    agentDir: dir,
    internalCommandTimeoutMs: 20,
  }) as any;
  activePools.add(pool);

  const emptyConnection = { socket: { destroyed: false, write() {} } } as any;
  assert.equal(await pool.ensureSelectedWorker(emptyConnection), undefined);

  const one = createOwnerSyntheticWorker({
    worker: { sessionFile: path.join(dir, "merged.jsonl"), turnActive: false },
  });
  const two = createOwnerSyntheticWorker({
    worker: { sessionFile: path.join(dir, "merged.jsonl"), turnActive: true },
  });
  pool.workers.add(one);
  pool.workers.add(two);
  const merged = pool.getRestorableSessionSelectors();
  assert.equal(merged.length, 1);
  assert.equal(merged[0].resumeTurn, true);
  pool.workers.clear();

  let scans = 0;
  pool.recoverActiveDaemonTurns = async () => {
    scans += 1;
    return [];
  };
  pool.scheduleActiveDaemonTurnRecoveryScan();
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(scans, 1);

  pool.recoverActiveDaemonTurn = async () => {
    pool.shuttingDown = true;
    throw "owner retry failure";
  };
  pool.shuttingDown = false;
  pool.scheduleActiveDaemonTurnRecovery("owner-timer-retry");
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(pool.activeTurnRecoveryTimers.size, 0);
  pool.shuttingDown = false;

  turnLedger.beginDaemonTurn(dir, { requestTag: "owner-missing-session" });
  pool.interruptDaemonTurnByRequestTag = () => false;
  pool.scheduleActiveDaemonTurnRecovery = (requestTag: string) => {
    pool.activeTurnRecoveryAttempts.set(requestTag, 1);
  };
  assert.equal(
    await pool.recoverActiveDaemonTurnOnce("owner-missing-session"),
    false,
  );
  assert.equal(pool.activeTurnRecoveryAttempts.get("owner-missing-session"), 1);

  const brokenRoot = path.join(dir, "broken-agent");
  await fs.writeFile(brokenRoot, "not a directory", "utf8");
  const brokenPool = new WorkerPool({
    workerPath: path.join(dir, "unused-worker.js"),
    cwd: dir,
    agentDir: brokenRoot,
  }) as any;
  activePools.add(brokenPool);
  let rescheduled = false;
  brokenPool.scheduleActiveDaemonTurnRecoveryScan = () => {
    rescheduled = true;
  };
  assert.deepEqual(await brokenPool.recoverActiveDaemonTurns(), []);
  assert.equal(rescheduled, true);
});

test("worker pool owner covers remaining selector, recovery error, immediate shutdown, and prompt lifecycle branches", async () => {
  const dir = await makeTempDir("rin-worker-pool-branch-owner-");
  const pool = new WorkerPool({
    workerPath: path.join(dir, "unused-worker.js"),
    cwd: dir,
    agentDir: dir,
  }) as any;
  activePools.add(pool);
  const selected = createOwnerSyntheticWorker({
    worker: { sessionFile: path.join(dir, "selected.jsonl") },
  });
  pool.workers.add(selected);
  pool.findWorkerBySelector = () => selected;
  pool.attachWorker = (connection: any, worker: any) => {
    connection.attachedWorker = worker;
  };
  const connection = { socket: { destroyed: false, write() {} } } as any;
  assert.equal(
    await pool.ensureSelectedWorker(connection, {
      sessionFile: selected.sessionFile,
    }),
    selected,
  );

  const noSession = createOwnerSyntheticWorker();
  pool.workers.add(noSession);
  assert.ok(
    !pool
      .getRestorableSessionSelectors()
      .some((item: any) => item.sessionFile === undefined),
  );

  pool.workers.clear();
  pool.recoverActiveDaemonTurn = async () => {
    pool.shuttingDown = true;
    throw new Error("owner retry error");
  };
  pool.scheduleActiveDaemonTurnRecovery("owner-error-retry");
  await new Promise((resolve) => setTimeout(resolve, 550));
  pool.shuttingDown = false;

  const lifecycleWorker = createOwnerSyntheticWorker();
  pool.establishPiPromptLifecycle(
    lifecycleWorker,
    { id: "no-tag", commandType: "prompt" },
    {},
  );
  lifecycleWorker.activeLifecycleRequestTag = "active-owner";
  assert.throws(
    () =>
      pool.establishPiPromptLifecycle(
        lifecycleWorker,
        {
          id: "other-tag",
          commandType: "prompt",
          inputSubmission: { requestTag: "other-owner" },
        },
        {},
      ),
    /rin_turn_admission_pending/,
  );

  const shutdownPool = new WorkerPool({
    workerPath: path.join(dir, "unused-worker.js"),
    cwd: dir,
  }) as any;
  activePools.add(shutdownPool);
  shutdownPool.workers.add(createOwnerSyntheticWorker());
  shutdownPool.destroyAll();
  assert.equal(shutdownPool.shuttingDown, true);
  assert.equal(shutdownPool.workers.size, 0);
});
