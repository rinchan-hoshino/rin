import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
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

test("worker cgroup attachment completes before the worker is returned", async () => {
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

test("worker creation fails closed when cgroup attachment fails", async () => {
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

test("new session workers receive rpc resource options through a private file", async () => {
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

test("getRestorableSessionSelectors keeps live session workers and remembers turn state", async () => {
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

test("getRestorableSessionSelectors normalizes duplicate session files and preserves resume intent", async () => {
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

test("restoreSessionWorker only attaches the session worker", async () => {
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

test("continueInterruptedTurnSessionWorker attaches then continues the turn", async () => {
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
    fs.appendFileSync(logPath, command.type + ":" + (command.source || "") + "\\n");
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  pool.continueInterruptedTurnSessionWorker({
    sessionFile: "/tmp/session.jsonl",
    source: "daemon-restart",
  });
  await sleep(150);

  assert.deepEqual(await readCommandLog(logPath), [
    "get_state:",
    "resume_interrupted_turn:daemon-restart",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("restart recovery follows a live Pi run without issuing another resume", async () => {
  const dir = await makeTempDir("rin-worker-pool-live-pi-run-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
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
    `
import fs from "node:fs";
import process from "node:process";
const logPath = ${JSON.stringify(logPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
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
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: {
        sessionFile,
        sessionId: "live-pi-run",
        turnActive: false,
        isStreaming: false,
        piActiveRun: true,
        interruptedTurnResumable: true,
      },
    }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5000,
  });
  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
    requestTag: "tag-live",
  });
  await sleep(100);

  assert.deepEqual(await readCommandLog(logPath), ["get_state"]);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
    requestTags: { [sessionFile]: "tag-live" },
  });

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("restart recovery waits for an unowned Pi run before resuming", async () => {
  const dir = await makeTempDir("rin-worker-pool-pi-run-wait-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import process from "node:process";
const logPath = ${JSON.stringify(logPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
let buffer = "";
let stateReads = 0;
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
    if (command.type === "get_state") stateReads += 1;
    const responseLine = JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: command.type === "get_state" ? {
        sessionFile,
        sessionId: "pi-run-wait",
        turnActive: false,
        isStreaming: false,
        piActiveRun: stateReads === 1,
        interruptedTurnResumable: true,
      } : {},
    }) + "\\n";
    process.stdout.write(
      responseLine +
      (command.type === "get_state" && stateReads === 2
        ? JSON.stringify({ type: "agent_start" }) + "\\n"
        : ""),
    );
    if (command.type === "get_state" && stateReads === 1) {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
      }, 10);
    }
  }
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5000,
  });
  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
    requestTag: "owned-recovery",
  });

  const deadline = Date.now() + 2000;
  let commands: string[] = [];
  while (Date.now() < deadline) {
    commands = await readCommandLog(logPath);
    if (commands.includes("resume_interrupted_turn")) break;
    await sleep(20);
  }
  assert.deepEqual(commands.slice(0, 4), [
    "get_state",
    "get_state",
    "get_state",
    "resume_interrupted_turn",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("restart recovery does not resume after a terminal settles its probe", async () => {
  const dir = await makeTempDir("rin-worker-pool-probe-terminal-race-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import process from "node:process";
const logPath = ${JSON.stringify(logPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
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
    const response = JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: command.type === "get_state" ? {
        sessionFile,
        sessionId: "probe-terminal-race",
        turnActive: false,
        isStreaming: false,
        interruptedTurnResumable: true,
      } : {},
    }) + "\\n";
    const terminal = command.type === "get_state"
      ? JSON.stringify({
          type: "rpc_turn_event",
          event: "complete",
          turnGeneration: 1,
          requestTag: "race-turn",
          sessionFile,
          sessionId: "probe-terminal-race",
          finalText: "already settled",
        }) + "\\n"
      : "";
    process.stdout.write(response + terminal);
  }
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5000,
  });
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
    requestTag: "race-turn",
  });
  await sleep(200);

  assert.deepEqual(await readCommandLog(logPath), ["get_state"]);
  assert.equal(worker.turnRecoveryPending, false);
  assert.equal(worker.activeLifecycleRequestTag, undefined);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("restart preflight failure preserves recovery ownership for a late terminal", async () => {
  const dir = await makeTempDir("rin-worker-pool-preflight-failure-");
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
    `
import process from "node:process";
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
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: false,
      error: "state unavailable",
    }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5000,
  });
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
    requestTag: "tag-recovery",
  });
  await sleep(50);

  assert.equal(worker.turnRecoveryPending, true);
  assert.equal(worker.activeRequestTag, "tag-recovery");
  assert.equal(worker.activeLifecycleRequestTag, "tag-recovery");
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
    requestTags: { [sessionFile]: "tag-recovery" },
  });

  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rpc_turn_event",
      event: "complete",
      turnGeneration: 1,
      requestTag: "tag-recovery",
      sessionFile,
      sessionId: "recovered-session",
      finalText: "late recovered final",
    })}\n`,
  );
  let durableState: any;
  for (let index = 0; index < 100; index += 1) {
    durableState = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (durableState.sessionFiles.length === 0) break;
    await sleep(10);
  }

  assert.equal(worker.turnActive, false);
  assert.equal(worker.turnRecoveryPending, false);
  assert.deepEqual(durableState, {
    schemaVersion: 1,
    sessionFiles: [],
  });

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("a new prompt is not forwarded without ownership during restart preflight", async () => {
  const dir = await makeTempDir("rin-worker-pool-preflight-prompt-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
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
    fs.appendFileSync(${JSON.stringify(logPath)}, command.type + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
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
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5000,
  });
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
    requestTag: "old-turn",
  });
  while ((await readCommandLog(logPath)).length === 0) await sleep(5);

  pool.requestWorker(
    worker,
    connection,
    {
      id: "new-prompt",
      type: "prompt",
      message: "new turn",
      requestTag: "new-turn",
      sessionFile,
    },
    true,
  );
  worker.turnActive = true;
  pool.requestWorker(
    worker,
    connection,
    {
      id: "same-recovery-tag",
      type: "prompt",
      message: "old turn",
      requestTag: "old-turn",
      sessionFile,
    },
    true,
  );
  worker.turnActive = false;
  pool.requestWorker(
    worker,
    connection,
    {
      id: "untagged-prompt",
      type: "prompt",
      message: "untagged turn",
      sessionFile,
    },
    true,
  );
  pool.requestWorker(
    worker,
    connection,
    {
      id: "new-user-message",
      type: "send_user_message",
      content: "new turn",
      requestTag: "new-user-turn",
      sessionFile,
    },
    true,
  );
  await sleep(20);

  assert.deepEqual(await readCommandLog(logPath), ["get_state"]);
  assert.equal(
    writes.some(
      (value) =>
        value.includes('"id":"new-prompt"') &&
        value.includes('"error":"rin_turn_recovery_in_progress"'),
    ),
    true,
  );
  assert.equal(
    writes.some(
      (value) =>
        value.includes('"id":"same-recovery-tag"') &&
        value.includes('"error":"rin_turn_recovery_in_progress"'),
    ),
    true,
  );
  assert.equal(
    writes.some(
      (value) =>
        value.includes('"id":"untagged-prompt"') &&
        value.includes('"error":"rin_turn_request_tag_required"'),
    ),
    true,
  );
  assert.equal(
    writes.some(
      (value) =>
        value.includes('"id":"new-user-message"') &&
        value.includes('"error":"rin_turn_recovery_in_progress"'),
    ),
    true,
  );
  assert.equal(worker.activeLifecycleRequestTag, "old-turn");

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("restart recovery restores frontend ownership for the same inbox prompt", async () => {
  const dir = await makeTempDir("rin-worker-pool-frontend-recovery-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
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
    fs.appendFileSync(${JSON.stringify(logPath)}, command.type + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
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
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5000,
  });
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
    requestTag: "chat-inbox-stable",
    frontendOwner: true,
  });
  while ((await readCommandLog(logPath)).length === 0) await sleep(5);

  worker.turnActive = true;
  pool.requestWorker(
    worker,
    connection,
    {
      id: "same-inbox-rejoin",
      type: "prompt",
      message: "original inbox prompt",
      requestTag: "chat-inbox-stable",
      sessionFile,
    },
    true,
  );
  pool.requestWorker(
    worker,
    connection,
    {
      id: "different-inbox-prompt",
      type: "prompt",
      message: "different prompt",
      requestTag: "chat-inbox-different",
      sessionFile,
    },
    true,
  );
  await sleep(20);

  assert.deepEqual(await readCommandLog(logPath), [
    "get_state",
    "prompt",
    "prompt",
  ]);
  assert.equal(
    writes.some(
      (value) =>
        value.includes('"id":"same-inbox-rejoin"') &&
        value.includes('"error":"rin_turn_recovery_in_progress"'),
    ),
    false,
  );
  assert.equal(
    writes.some(
      (value) =>
        value.includes('"id":"different-inbox-prompt"') &&
        value.includes('"error":"rin_turn_recovery_in_progress"'),
    ),
    false,
  );
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      id: "different-inbox-prompt",
      type: "response",
      command: "prompt",
      success: true,
      data: { acceptedAs: "steer", turnActive: true },
      sessionFile,
    })}\n`,
  );
  await sleep(0);
  assert.equal(worker.activeLifecycleRequestTag, "chat-inbox-stable");
  assert.equal(worker.activeLifecycleFrontendOwner, true);

  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
    requestTag: "chat-inbox-stable",
    frontendOwner: false,
  });
  await sleep(5);
  assert.equal(worker.activeLifecycleFrontendOwner, false);
  pool.requestWorker(
    worker,
    connection,
    {
      id: "same-inbox-after-owner-clear",
      type: "prompt",
      message: "original inbox prompt",
      requestTag: "chat-inbox-stable",
      sessionFile,
    },
    true,
  );
  await sleep(10);
  assert.deepEqual(await readCommandLog(logPath), [
    "get_state",
    "prompt",
    "prompt",
  ]);
  assert.equal(
    writes.some(
      (value) =>
        value.includes('"id":"same-inbox-after-owner-clear"') &&
        value.includes('"error":"rin_turn_recovery_in_progress"'),
    ),
    true,
  );

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("a same-tag prompt can rejoin a frontend-owned turn before start", async () => {
  const dir = await makeTempDir("rin-worker-pool-prompt-rejoin-gap-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
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
    fs.appendFileSync(${JSON.stringify(logPath)}, command.id + ":" + command.type + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
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
  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 5000 });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.requestWorker(
    worker,
    connection,
    {
      id: "first-prompt",
      type: "prompt",
      message: "first",
      requestTag: "shared-turn",
    },
    true,
  );
  pool.requestWorker(
    worker,
    connection,
    {
      id: "same-tag-rejoin",
      type: "prompt",
      message: "first",
      requestTag: "shared-turn",
    },
    true,
  );
  pool.requestWorker(
    worker,
    connection,
    {
      id: "different-tag",
      type: "prompt",
      message: "second",
      requestTag: "different-turn",
    },
    true,
  );
  const commands = await waitForCommandLogPrefix(logPath, [
    "first-prompt:prompt",
    "same-tag-rejoin:prompt",
  ]);

  assert.deepEqual(commands, ["first-prompt:prompt", "same-tag-rejoin:prompt"]);
  assert.equal(
    writes.some(
      (value) =>
        value.includes('"id":"different-tag"') &&
        value.includes('"error":"rin_turn_recovery_in_progress"'),
    ),
    true,
  );

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("restart recovery retries a transient preflight failure before resuming", async () => {
  const dir = await makeTempDir("rin-worker-pool-preflight-retry-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import process from "node:process";
const logPath = ${JSON.stringify(logPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
let buffer = "";
let stateReads = 0;
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
    if (command.type === "get_state") {
      stateReads += 1;
      if (stateReads === 1) {
        process.stdout.write(JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: "transient state failure",
        }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: {
            sessionFile,
            sessionId: "retry-session",
            turnActive: false,
            isStreaming: false,
            interruptedTurnResumable: true,
          },
        }) + "\\n");
      }
      continue;
    }
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: {},
    }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5000,
  });
  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
    requestTag: "tag-retry",
  });

  const deadline = Date.now() + 2000;
  let commands: string[] = [];
  while (Date.now() < deadline) {
    commands = await readCommandLog(logPath);
    if (commands.includes("resume_interrupted_turn")) break;
    await sleep(20);
  }

  assert.deepEqual(commands.slice(0, 3), [
    "get_state",
    "get_state",
    "resume_interrupted_turn",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("legacy lifecycle accepts consecutive command-owned turns without admitting late terminals", async () => {
  const dir = await makeTempDir("rin-worker-pool-legacy-consecutive-");
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
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 1000,
  });
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);

  const emit = (payload: Record<string, unknown>) => {
    worker.child.stdout.emit("data", `${JSON.stringify(payload)}\n`);
  };
  const runLegacyTurn = async (id: string, requestTag: string) => {
    pool.forwardToWorker(connection, worker, {
      id,
      type: "prompt",
      message: requestTag,
      requestTag,
    });
    emit({ id, type: "response", command: "prompt", success: true, data: {} });
    emit({
      type: "rpc_turn_event",
      event: "start",
      requestTag,
      sessionFile,
    });
    await sleep(0);
  };

  await runLegacyTurn("turn-1", "legacy-1");
  emit({
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "legacy-1",
    sessionFile,
    finalText: "first final",
  });
  await sleep(0);
  assert.equal(worker.turnActive, false);

  await runLegacyTurn("turn-2", "legacy-2");
  assert.equal(worker.turnActive, true);
  const forwardedBeforeLateTerminal = writes.length;
  emit({
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "legacy-1",
    sessionFile,
    finalText: "late first final",
  });
  await sleep(0);
  assert.equal(worker.turnActive, true);
  assert.equal(writes.length, forwardedBeforeLateTerminal);

  emit({
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "legacy-2",
    sessionFile,
    finalText: "second final",
  });
  await sleep(0);
  assert.equal(worker.turnActive, false);
  const completions = writes
    .flatMap((value) => value.trim().split("\n"))
    .filter(Boolean)
    .map((value) => JSON.parse(value))
    .filter(
      (payload) =>
        payload.type === "rpc_turn_event" && payload.event === "complete",
    );
  assert.deepEqual(
    completions.map((payload) => [payload.requestTag, payload.finalText]),
    [
      ["legacy-1", "first final"],
      ["legacy-2", "second final"],
    ],
  );
});

test("a failed owner command with a spaced id clears only its installed lifecycle", async () => {
  const dir = await makeTempDir("rin-worker-pool-spaced-owner-id-");
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
  pool.requestWorker(
    worker,
    connection,
    {
      id: " owner-command ",
      type: "prompt",
      message: "hello",
      requestTag: "owner-tag",
      sessionFile,
    },
    true,
  );
  assert.equal(worker.activeLifecycleOwnerCommandId, " owner-command ");
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      id: " owner-command ",
      type: "response",
      command: "prompt",
      success: false,
      error: "prompt_admission_failed",
    })}\n`,
  );
  await sleep(0);

  assert.equal(worker.pendingResponses.size, 0);
  assert.equal(worker.turnRecoveryPending, false);
  assert.equal(worker.activeRequestTag, undefined);
  assert.equal(worker.activeLifecycleRequestTag, undefined);
  assert.equal(worker.activeLifecycleSelector, undefined);
  assert.equal(worker.activeLifecycleOwnerCommandId, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [],
  });
  assert.equal(
    writes.some((value) => value.includes('"id":" owner-command "')),
    true,
  );
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

test("selectSession shares daemon-restart recovery without owning the resume", async () => {
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
    fs.appendFileSync(logPath, command.type + ":" + (command.source || "") + "\\n");
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");
    }, command.type === "switch_session" ? 100 : 0);
  }
});
setInterval(() => {}, 1000);
`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 5000 });
  pool.continueInterruptedTurnSessionWorker({
    sessionFile: "/tmp/session.jsonl",
    source: "daemon-restart",
  });

  const selected = await pool.selectSession(connection, {
    sessionFile: "/tmp/session.jsonl",
  });

  assert.ok(selected);
  assert.equal(pool.getStatusSnapshot().workerCount, 1);
  assert.equal(connection.attachedWorker, selected);
  const commands = await waitForCommandLogPrefix(
    logPath,
    ["get_state:", "resume_interrupted_turn:daemon-restart"],
    1000,
  );
  assert.deepEqual(commands, [
    "get_state:",
    "resume_interrupted_turn:daemon-restart",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("frontend session selection does not wait for restart resume completion", async () => {
  const dir = await makeTempDir("rin-worker-pool-resume-decoupled-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  const sessionFile = "/tmp/session.jsonl";
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import process from "node:process";
const logPath = ${JSON.stringify(logPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
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
    fs.appendFileSync(logPath, command.type + ":" + (command.source || "") + "\\n");
    if (command.type === "get_state") {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: { sessionFile, sessionId: "resume-decoupled", interruptedTurnResumable: true },
      }) + "\\n");
      continue;
    }
    if (command.type === "switch_session") {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: { sessionFile, sessionId: "resume-decoupled" },
        }) + "\\n");
      }, 20);
    }
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
    gcIdleMs: 5000,
    internalCommandTimeoutMs: 500,
  });
  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
  });

  const startedAt = Date.now();
  const selected = await pool.selectSession(connection, { sessionFile });
  const elapsedMs = Date.now() - startedAt;
  const commands = await waitForCommandLogPrefix(
    logPath,
    ["get_state:", "resume_interrupted_turn:daemon-restart"],
    1000,
  );

  assert.ok(selected);
  assert.equal(connection.attachedWorker, selected);
  assert.ok(elapsedMs < 300, `selection waited for resume: ${elapsedMs}ms`);
  assert.deepEqual(commands, [
    "get_state:",
    "resume_interrupted_turn:daemon-restart",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("backend restart recovery intent survives a concurrent session selection claim", async () => {
  const dir = await makeTempDir("rin-worker-pool-recovery-intent-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  const sessionFile = "/tmp/session.jsonl";
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
    fs.appendFileSync(logPath, command.type + ":" + (command.source || "") + "\\n");
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: { sessionFile: ${JSON.stringify(sessionFile)}, sessionId: "backend-recovery-intent" },
      }) + "\\n");
    }, command.type === "switch_session" ? 100 : 0);
  }
});
setInterval(() => {}, 1000);
`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 5000 });
  const selectedPromise = pool.selectSession(connection, { sessionFile });

  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
  });

  const selected = await selectedPromise;
  const commands = await waitForCommandLogPrefix(
    logPath,
    ["get_state:", "resume_interrupted_turn:daemon-restart"],
    1000,
  );

  assert.ok(selected);
  assert.equal(connection.attachedWorker, selected);
  assert.deepEqual(commands, [
    "get_state:",
    "resume_interrupted_turn:daemon-restart",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("backend restart recovery intent survives unrelated active worker work", async () => {
  const dir = await makeTempDir("rin-worker-pool-recovery-active-");
  const workerPath = path.join(dir, "worker-source");
  const logPath = path.join(dir, "commands.log");
  const sessionFile = "/tmp/session.jsonl";
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import process from "node:process";
const logPath = ${JSON.stringify(logPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
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
    fs.appendFileSync(logPath, command.type + ":" + (command.source || "") + "\\n");
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: { sessionFile, sessionId: "active-worker-recovery" },
    }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
  );

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 5000 });
  const worker = await pool.selectSession(connection, { sessionFile });
  assert.ok(worker);
  worker.turnActive = true;

  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
  });
  await sleep(20);
  assert.deepEqual(await readCommandLog(logPath), []);

  worker.turnActive = false;
  pool.evictDetachedWorkers();
  const commands = await waitForCommandLogPrefix(
    logPath,
    ["get_state:", "resume_interrupted_turn:daemon-restart"],
    1000,
  );

  assert.deepEqual(commands, [
    "get_state:",
    "resume_interrupted_turn:daemon-restart",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon-restart recovery replays an undelivered canonical terminal turn event only after the frontend asks", async () => {
  const dir = await makeTempDir("rin-worker-pool-pending-turn-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  const pendingEventsPath = path.join(
    dir,
    "data",
    "core",
    "workers",
    "pending-turn-events.json",
  );
  await fs.writeFile(
    workerPath,
    String.raw`const sessionFile = ${JSON.stringify(sessionFile)};
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
    if (command.type === 'switch_session' || command.type === 'get_state') {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: {
          sessionFile,
          sessionId: 'pending-turn-session',
          interruptedTurnResumable: true,
        },
      }) + '\n');
      continue;
    }
    if (command.type === 'resume_interrupted_turn') {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: {},
      }) + '\n');
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          type: 'rpc_turn_event',
          event: 'complete',
          requestTag: command.requestTag,
          sessionFile,
          sessionId: 'pending-turn-session',
          finalText: 'replayed durable final',
          result: { messages: [{ type: 'text', text: 'replayed durable final' }] },
        }) + '\n');
      }, 10);
      continue;
    }
  }
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 10_000,
  });
  pool.continueInterruptedTurnSessionWorker({
    sessionFile,
    source: "daemon-restart",
  });

  for (let i = 0; i < 50; i += 1) {
    try {
      const pending = JSON.parse(await fs.readFile(pendingEventsPath, "utf8"));
      if (pending.eventsBySessionFile?.[sessionFile]) break;
    } catch {}
    await sleep(10);
  }

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
  const selected = await pool.selectSession(connection, { sessionFile });

  assert.ok(selected);
  assert.equal(
    writes
      .map((value) => JSON.parse(value))
      .some(
        (payload) =>
          payload.type === "rpc_turn_event" && payload.event === "complete",
      ),
    false,
  );
  assert.ok(
    JSON.parse(await fs.readFile(pendingEventsPath, "utf8"))
      .eventsBySessionFile?.[sessionFile],
  );

  assert.equal(
    pool.replayPendingTerminalTurnEvent(connection, { sessionFile }),
    true,
  );
  const replayed = writes
    .map((value) => JSON.parse(value))
    .find(
      (payload) =>
        payload.type === "rpc_turn_event" && payload.event === "complete",
    );
  assert.equal(replayed?.finalText, "replayed durable final");
  assert.equal(replayed?.sessionFile, sessionFile);

  const pendingAfter = JSON.parse(await fs.readFile(pendingEventsPath, "utf8"));
  assert.equal(pendingAfter.eventsBySessionFile?.[sessionFile], undefined);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("non-turn resumable worker commands persist a running record until they finish", async () => {
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

test("prompt turns persist running-worker recovery from command session until terminal turn event", async () => {
  const dir = await makeTempDir("rin-worker-pool-command-running-");
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
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: { sessionFile: command.sessionFile, sessionId: 'command-running' },
    }) + '\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'rpc_turn_event',
        event: 'start',
        requestTag: command.requestTag,
        sessionFile: command.sessionFile,
        sessionId: 'command-running',
      }) + '\n');
    }, 80);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'rpc_turn_event',
        event: 'complete',
        requestTag: command.requestTag,
        sessionFile: command.sessionFile,
        sessionId: 'command-running',
        finalText: 'done',
      }) + '\n');
    }, 160);
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
    gcIdleMs: 5000,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.requestWorker(
    worker,
    connection,
    { id: "prompt-1", type: "prompt", sessionFile, requestTag: "tag-1" },
    true,
  );

  assert.equal(worker.sessionFile, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
    requestTags: { [sessionFile]: "tag-1" },
    frontendOwners: { [sessionFile]: true },
  });

  await sleep(40);

  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
    requestTags: { [sessionFile]: "tag-1" },
    frontendOwners: { [sessionFile]: true },
  });

  let terminalState: any;
  for (let index = 0; index < 100; index += 1) {
    terminalState = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (terminalState.sessionFiles.length === 0) break;
    await sleep(10);
  }

  assert.deepEqual(terminalState, {
    schemaVersion: 1,
    sessionFiles: [],
  });

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("prompt running record survives shutdown after submission response before turn event", async () => {
  const dir = await makeTempDir("rin-worker-pool-command-shutdown-");
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
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: { sessionFile: command.sessionFile, sessionId: 'command-shutdown' },
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
    agentDir: dir,
    gcIdleMs: 5000,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.requestWorker(
    worker,
    connection,
    { id: "prompt-1", type: "prompt", sessionFile, requestTag: "tag-1" },
    true,
  );

  for (let index = 0; index < 100; index += 1) {
    if (worker.pendingResponses.size === 0) break;
    await sleep(10);
  }
  assert.equal(worker.pendingResponses.size, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
    requestTags: { [sessionFile]: "tag-1" },
    frontendOwners: { [sessionFile]: true },
  });

  pool.beginShutdown();
  pool.destroyAll();

  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
    requestTags: { [sessionFile]: "tag-1" },
    frontendOwners: { [sessionFile]: true },
  });

  await fs.rm(dir, { recursive: true, force: true });
});

test("rpc turn start keeps a running record after an agent segment ends", async () => {
  const dir = await makeTempDir("rin-worker-pool-rpc-running-");
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
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: {},
    }) + '\n');
    process.stdout.write(JSON.stringify({
      type: 'rpc_turn_event',
      event: 'start',
      requestTag: command.requestTag,
      sessionFile: command.sessionFile,
      sessionId: 'active',
    }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\n');
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
  pool.requestWorker(
    worker,
    connection,
    {
      id: "prompt-1",
      type: "prompt",
      requestTag: "rpc-running",
      sessionFile,
    },
    true,
  );

  await sleep(100);

  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
    requestTags: { [sessionFile]: "rpc-running" },
    frontendOwners: { [sessionFile]: true },
  });
  assert.equal(pool.getStatusSnapshot().workers[0]?.turnActive, true);
  assert.equal(pool.getStatusSnapshot().workers[0]?.isStreaming, false);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("stale terminal events do not clear a newer tagged active turn", async () => {
  const dir = await makeTempDir("rin-worker-pool-stale-terminal-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  const statePath = path.join(
    dir,
    "data",
    "core",
    "workers",
    "running-workers.json",
  );
  await fs.writeFile(workerPath, "setInterval(() => {}, 1000);\n");

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5000,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.requestWorker(
    worker,
    connection,
    {
      id: "current-command",
      type: "prompt",
      message: "current",
      requestTag: "tag-current",
      sessionFile,
    },
    true,
  );
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      id: "current-command",
      type: "response",
      command: "prompt",
      success: true,
      data: {},
    })}\n`,
  );

  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "start",
    requestTag: "tag-current",
    sessionFile,
    sessionId: "active",
  });
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "tag-current",
    sessionFile,
    sessionId: "different-session-id",
    finalText: "cross-session",
  });
  assert.equal(worker.turnActive, true);
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "start",
    requestTag: "tag-stale",
    sessionFile,
    sessionId: "active",
  });
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "tag-stale",
    sessionFile,
    sessionId: "active",
    finalText: "stale",
  });

  assert.equal(worker.turnActive, true);
  assert.equal(worker.rpcTurnActive, true);
  assert.equal(worker.activeRequestTag, "tag-current");
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
    requestTags: { [sessionFile]: "tag-current" },
    frontendOwners: { [sessionFile]: true },
  });

  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "tag-current",
    sessionFile,
    sessionId: "active",
    finalText: "current",
  });
  assert.equal(worker.turnActive, false);
  assert.equal(worker.rpcTurnActive, false);
  assert.equal(worker.activeRequestTag, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [],
  });

  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "start",
    requestTag: "tag-current",
    sessionFile,
    sessionId: "active",
  });
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "heartbeat",
    requestTag: "tag-current",
    sessionFile,
    sessionId: "active",
  });
  assert.equal(worker.turnActive, false);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [],
  });

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("older turn events cannot overwrite or reactivate a newer generation", async () => {
  const dir = await makeTempDir("rin-worker-pool-turn-generation-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  const statePath = path.join(
    dir,
    "data",
    "core",
    "workers",
    "running-workers.json",
  );
  await fs.writeFile(workerPath, "setInterval(() => {}, 1000);\n");

  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5000,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.requestWorker(
    worker,
    connection,
    {
      id: "current-versioned-command",
      type: "prompt",
      message: "current",
      requestTag: "tag-current",
      sessionFile,
    },
    true,
  );
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      id: "current-versioned-command",
      type: "response",
      command: "prompt",
      success: true,
      data: {},
    })}\n`,
  );

  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "start",
    turnGeneration: 2,
    requestTag: "tag-current",
    sessionFile,
    sessionId: "active",
  });
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "start",
    turnGeneration: 2,
    requestTag: "tag-stale",
    sessionFile,
    sessionId: "active",
  });
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "heartbeat",
    turnGeneration: 2,
    requestTag: "tag-stale",
    sessionFile,
    sessionId: "active",
  });
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "heartbeat",
    turnGeneration: 1,
    requestTag: "tag-stale",
    sessionFile,
    sessionId: "active",
  });

  assert.equal(worker.turnActive, true);
  assert.equal(worker.activeRequestTag, "tag-current");

  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "complete",
    turnGeneration: 2,
    requestTag: "tag-stale",
    sessionFile,
    sessionId: "active",
    finalText: "stale",
  });
  assert.equal(worker.turnActive, true);
  assert.equal(worker.activeRequestTag, "tag-current");

  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "complete",
    turnGeneration: 2,
    requestTag: "tag-current",
    sessionFile,
    sessionId: "active",
    finalText: "current",
  });
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "heartbeat",
    turnGeneration: 1,
    requestTag: "tag-stale",
    sessionFile,
    sessionId: "active",
  });

  assert.equal(worker.turnActive, false);
  assert.equal(worker.rpcTurnActive, false);
  assert.equal(worker.activeRequestTag, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [],
  });

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("detached worker survives eviction while response is pending", async () => {
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
  assert.equal(pool.getStatusSnapshot().workerCount, 0);
});

test("attached idle worker sleeps while preserving the selected session", async () => {
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

test("detached idle worker sleeps instead of terminating the session", async () => {
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

test("detached worker stays alive while turnActive is true even if streaming is false", async () => {
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

test("remembered session selection can pull a replacement worker without an explicit switch", async () => {
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

test("selectSession shuts down the previous session before resuming another session", async () => {
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

test("selectSession keeps a previous session alive while another connection is still attached", async () => {
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

test("selectSession lazily restores the chosen session worker", async () => {
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

test("concurrent selectSession calls reuse one worker for the same session", async () => {
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

test("duplicate restoreSessionWorker calls converge to one session worker", async () => {
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

test("restoreSessionWorker indexes the session when creating an initial-session worker", async () => {
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

test("attached session worker auto-recovers without dropping the daemon connection", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  const firstRunMarker = path.join(dir, "first-run.txt");
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
import path from 'node:path';
const marker = ${JSON.stringify(firstRunMarker)};
const firstRun = !fs.existsSync(marker);
if (firstRun) fs.writeFileSync(marker, 'done');
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
    if (command.type === 'get_state' && firstRun) {
      process.exit(9);
    }
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: command.type === 'switch_session'
        ? { cancelled: false }
        : { sessionFile: '/tmp/recovered.jsonl', sessionId: 'recovered-session', isStreaming: false, isCompacting: false },
    }) + '\n');
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
  worker.sessionFile = "/tmp/recovered.jsonl";
  worker.sessionId = "recovered-session";
  pool.forwardToWorker(connection, worker, { id: "req_1", type: "get_state" });

  for (let i = 0; i < 20; i += 1) {
    if (writes.some((value) => JSON.parse(value).type === "session_recovered"))
      break;
    await sleep(50);
  }

  const payloads = writes.map((value) => JSON.parse(value));
  assert.deepEqual(
    payloads.map((payload) => payload.type),
    ["session_recovering", "response", "session_recovered"],
  );
  assert.equal(payloads[0].resumeTurn, false);
  assert.equal(payloads[1].error, "rin_session_recovering");
  assert.equal(payloads[2].sessionFile, "/tmp/recovered.jsonl");
  assert.equal(pool.getStatusSnapshot().workerCount, 1);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker crash recovery preserves missing and explicit empty request tags", async () => {
  for (const scenario of [
    {
      name: "missing",
      requestTag: undefined,
      hasRequestTag: false,
      frontendOwner: false,
    },
    {
      name: "empty",
      requestTag: "",
      hasRequestTag: true,
      frontendOwner: true,
    },
  ]) {
    const dir = await makeTempDir(
      `rin-worker-pool-crash-${scenario.name}-tag-`,
    );
    const workerPath = path.join(dir, "worker-source");
    const firstRunMarker = path.join(dir, "first-run.txt");
    const commandLogPath = path.join(dir, "commands.log");
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      workerPath,
      String.raw`import fs from 'node:fs';
const marker = ${JSON.stringify(firstRunMarker)};
const logPath = ${JSON.stringify(commandLogPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
const firstRun = !fs.existsSync(marker);
if (firstRun) fs.writeFileSync(marker, 'done');
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
    fs.appendFileSync(logPath, JSON.stringify({
      type: command.type,
      hasRequestTag: Object.prototype.hasOwnProperty.call(command, 'requestTag'),
      requestTag: command.requestTag,
    }) + '\n');
    if (firstRun) {
      process.exit(9);
    }
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: { sessionFile, sessionId: 'crash-tag-session' },
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
      agentDir: dir,
      gcIdleMs: 1000,
    });
    const worker = pool.resolveWorkerForCommand(connection, {
      type: "new_session",
    });
    pool.setWorkerSessionRefs(worker, {
      sessionFile,
      sessionId: "crash-tag-session",
    });
    worker.turnActive = true;
    worker.rpcTurnActive = true;
    if (scenario.requestTag !== undefined) {
      worker.activeLifecycleRequestTag = scenario.requestTag;
      worker.activeLifecycleSelector = { sessionFile };
      worker.activeLifecycleFrontendOwner = scenario.frontendOwner;
    } else {
      worker.activeRequestTag = "unrelated-active-tag";
    }
    pool.forwardToWorker(connection, worker, {
      id: "crash-trigger",
      type: "get_state",
      sessionFile,
    });

    let commands: any[] = [];
    for (let index = 0; index < 100; index += 1) {
      commands = (await readCommandLog(commandLogPath)).map((value) =>
        JSON.parse(value),
      );
      if (commands.length >= 2) break;
      await sleep(20);
    }
    assert.deepEqual(
      commands.map((command) => command.type),
      ["get_state", "resume_interrupted_turn"],
      scenario.name,
    );
    assert.equal(commands[1]?.hasRequestTag, scenario.hasRequestTag);
    assert.equal(commands[1]?.requestTag, scenario.requestTag);
    const recoveredWorker = (pool as any).findWorkerBySelector({ sessionFile });
    assert.ok(recoveredWorker);
    assert.equal(
      recoveredWorker.activeLifecycleRequestTag,
      scenario.requestTag,
    );
    assert.equal(
      recoveredWorker.activeLifecycleFrontendOwner,
      scenario.frontendOwner,
    );

    pool.destroyAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("worker crash recovery preserves the active lifecycle request tag", async () => {
  const dir = await makeTempDir("rin-worker-pool-crash-turn-owner-");
  const workerPath = path.join(dir, "worker-source");
  const firstRunMarker = path.join(dir, "first-run.txt");
  const commandLogPath = path.join(dir, "commands.log");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
const marker = ${JSON.stringify(firstRunMarker)};
const logPath = ${JSON.stringify(commandLogPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
const firstRun = !fs.existsSync(marker);
if (firstRun) fs.writeFileSync(marker, 'done');
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
    fs.appendFileSync(logPath, JSON.stringify({ type: command.type, requestTag: command.requestTag }) + '\n');
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: { sessionFile, sessionId: 'crash-turn-session' },
    }) + '\n');
    if (firstRun && command.type === 'prompt') {
      process.stdout.write(JSON.stringify({
        type: 'rpc_turn_event',
        event: 'start',
        requestTag: command.requestTag,
        sessionFile,
        sessionId: 'crash-turn-session',
      }) + '\n');
      setTimeout(() => process.exit(9), 20);
    }
    if (!firstRun && command.type === 'resume_interrupted_turn') {
      process.stdout.write(JSON.stringify({
        type: 'rpc_turn_event',
        event: 'start',
        requestTag: command.requestTag,
        sessionFile,
        sessionId: 'crash-turn-session',
      }) + '\n');
      process.stdout.write(JSON.stringify({
        type: 'rpc_turn_event',
        event: 'complete',
        requestTag: command.requestTag,
        sessionFile,
        sessionId: 'crash-turn-session',
        finalText: 'recovered crash final',
      }) + '\n');
    }
  }
});
setInterval(() => {}, 1000);
`,
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
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 1000,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.setWorkerSessionRefs(worker, {
    sessionFile,
    sessionId: "crash-turn-session",
  });
  pool.requestWorker(
    worker,
    connection,
    {
      id: "crashing-prompt",
      type: "prompt",
      message: "crash",
      requestTag: " crash-owner ",
      sessionFile,
      sessionId: "crash-turn-session",
    },
    true,
  );

  let recoveredFinal: any;
  for (let index = 0; index < 100; index += 1) {
    recoveredFinal = writes
      .flatMap((value) => value.trim().split("\n"))
      .filter(Boolean)
      .map((value) => JSON.parse(value))
      .find(
        (payload) =>
          payload.type === "rpc_turn_event" &&
          payload.event === "complete" &&
          payload.finalText === "recovered crash final",
      );
    if (recoveredFinal) break;
    await sleep(20);
  }

  assert.equal(recoveredFinal?.requestTag, " crash-owner ");
  const commands = (await readCommandLog(commandLogPath)).map((value) =>
    JSON.parse(value),
  );
  assert.deepEqual(
    commands.map((command) => [command.type, command.requestTag]),
    [
      ["prompt", " crash-owner "],
      ["resume_interrupted_turn", " crash-owner "],
    ],
  );
  const recoveredWorker = pool
    .getStatusSnapshot()
    .workers.find((item) => item.sessionFile === sessionFile);
  assert.ok(recoveredWorker);
  const liveWorker = (pool as any).findWorkerBySelector({ sessionFile });
  assert.equal(liveWorker.activeLifecycleRequestTag, undefined);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker crash recovery restores one selected session worker", async () => {
  const dir = await makeTempDir("rin-worker-pool-recover-claim-");
  const workerPath = path.join(dir, "worker-source");
  const firstRunMarker = path.join(dir, "first-run.txt");
  const sessionFile = "/tmp/recover-claim.jsonl";
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
const marker = ${JSON.stringify(firstRunMarker)};
const firstRun = !fs.existsSync(marker);
if (firstRun) fs.writeFileSync(marker, 'done');
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
    if (command.type === 'get_state' && firstRun) {
      process.exit(9);
    }
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: { sessionFile: command.sessionPath || ${JSON.stringify(sessionFile)}, sessionId: 'recover-claim', isStreaming: false, isCompacting: false },
    }) + '\n');
  }
});
setInterval(() => {}, 1000);
`,
  );

  const writes: string[] = [];
  const firstConnection = {
    socket: {
      destroyed: false,
      write(value: string) {
        writes.push(String(value));
      },
    },
    clientBuffer: "",
  };
  const secondConnection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.resolveWorkerForCommand(firstConnection, {
    type: "new_session",
  });
  worker.sessionFile = sessionFile;
  worker.sessionId = "recover-claim";
  pool.forwardToWorker(firstConnection, worker, {
    id: "req_1",
    type: "get_state",
  });

  for (let i = 0; i < 50; i += 1) {
    if (writes.some((value) => JSON.parse(value).type === "session_recovering"))
      break;
    await sleep(10);
  }

  const selected = await pool.selectSession(secondConnection, { sessionFile });

  for (let i = 0; i < 50; i += 1) {
    if (writes.some((value) => JSON.parse(value).type === "session_recovered"))
      break;
    await sleep(10);
  }

  const status = pool.getStatusSnapshot();
  assert.equal(Boolean(selected), true);
  assert.equal(status.workerCount, 1);
  assert.equal(status.workers[0]?.sessionFile, sessionFile);
  assert.equal(status.workers[0]?.attachedConnections, 2);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker events are forwarded only to matching selected session", async () => {
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

test("selectSession with only sessionId ignores stale remembered sessionFile", async () => {
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

test("worker session ref updates clear stale attached connection selectors", async () => {
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

test("client worker commands fail closed stdin without daemon stream errors", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const writes: string[] = [];
  const connection = {
    socket: { destroyed: false, write: (line: string) => writes.push(line) },
    clientBuffer: "",
  };
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 50,
    internalCommandTimeoutMs: 200,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });

  worker.child.stdin.end();
  await new Promise((resolve) => worker.child.stdin.once("finish", resolve));

  pool.forwardToWorker(connection, worker, {
    id: "1",
    type: "prompt",
    requestTag: "closed-stdin-turn",
  });

  assert.equal(worker.pendingResponses.size, 0);
  assert.equal(pool.getStatusSnapshot().workerCount, 0);
  assert.ok(
    writes.some((line) => {
      return (
        JSON.stringify(JSON.parse(line)) ===
        JSON.stringify({
          id: "1",
          type: "response",
          command: "prompt",
          success: false,
          error: "rin_worker_exit",
        })
      );
    }),
  );

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker OOM is reported without turning it into an ordinary exit", async () => {
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

test("OOM worker recovery resumes only the affected session with an OOM source", async () => {
  const dir = await makeTempDir("rin-worker-pool-oom-recovery-");
  const workerPath = path.join(dir, "worker-source");
  const firstRunMarker = path.join(dir, "first-run.txt");
  const resumeSourcePath = path.join(dir, "resume-source.txt");
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
const marker = ${JSON.stringify(firstRunMarker)};
const sourcePath = ${JSON.stringify(resumeSourcePath)};
const firstRun = !fs.existsSync(marker);
if (firstRun) fs.writeFileSync(marker, 'done');
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
    if (firstRun && command.type === 'prompt') process.exit(9);
    if (command.type === 'resume_interrupted_turn') {
      fs.writeFileSync(sourcePath, String(command.source || ''));
    }
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: { sessionFile: '/tmp/oom-recovered.jsonl', sessionId: 'oom-recovered', isStreaming: false, isCompacting: false },
    }) + '\n');
  }
});
setInterval(() => {}, 1000);
`,
  );

  const writes: string[] = [];
  let attachedWorkers = 0;
  const connection = {
    socket: { destroyed: false, write: (line: string) => writes.push(line) },
    clientBuffer: "",
  };
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 5000,
    workerCgroupIsolation: {
      attachWorker() {
        attachedWorkers += 1;
        const oomKilled = attachedWorkers === 1;
        return {
          wasOomKilled: () => oomKilled,
          cleanup: async () => true,
        };
      },
    },
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.setWorkerSessionRefs(worker, {
    sessionFile: "/tmp/oom-recovered.jsonl",
    sessionId: "oom-recovered",
  });
  pool.attachWorker(connection, worker);
  pool.forwardToWorker(connection, worker, {
    id: "oom_prompt",
    type: "prompt",
    requestTag: "oom-turn",
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (writes.some((line) => JSON.parse(line).type === "session_recovered")) {
      break;
    }
    await sleep(25);
  }

  const payloads = writes.map((line) => JSON.parse(line));
  assert.deepEqual(
    payloads.map((payload) => payload.type),
    ["worker_oom", "session_recovering", "response", "session_recovered"],
  );
  assert.equal(payloads[1].resumeTurn, true);
  assert.equal(payloads[2].error, "rin_session_recovering");
  assert.equal(await fs.readFile(resumeSourcePath, "utf8"), "worker-oom");
  assert.equal(pool.getStatusSnapshot().workerCount, 1);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("graceful worker commands destroy workers with closed stdin", async () => {
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

test("internal worker commands time out cleanly without leaking late responses", async () => {
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

test("internal worker commands reject closed stdin without unhandled stream errors", async () => {
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

test("internal worker commands handle async stdin write errors", async () => {
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

test("switch_session internal commands can outlive the generic internal timeout", async () => {
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

test("worker status snapshot treats Rin pre-compaction work as working", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    `process.stdout.write(JSON.stringify({ type: "rin_working_start", reason: "session_before_compact" }) + "\\n");
process.stdin.resume();
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = pool.getStatusSnapshot();
    if (status.workers[0]?.rinWorking) break;
    await sleep(25);
  }

  const status = pool.getStatusSnapshot();
  assert.equal(status.activeWorkerCount, 1);
  assert.equal(status.workers[0]?.rinWorking, true);
  assert.equal(status.workers[0]?.state, "working");

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker status snapshot exposes graceful shutdown state", async () => {
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

test("public selection, routing, state, abort, detach, and shutdown share one real worker lifecycle", async () => {
  const dir = await makeTempDir("rin-worker-pool-public-contract-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    String.raw`process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: command.type === 'get_state'
        ? { sessionFile: '/tmp/public-owner.jsonl', sessionId: 'public-owner' }
        : { aborted: command.type === 'abort' },
    }) + '\n');
  }
});
setInterval(() => {}, 1000);
`,
  );
  const spawned: any[] = [];
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    gcIdleMs: 5_000,
    onWorkerSpawn(requester, worker) {
      spawned.push([requester, worker]);
    },
  });
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

  assert.equal(pool.hasSelectedSession(connection), false);
  assert.equal(await pool.ensureSelectedWorker(connection), undefined);
  assert.equal(pool.resolveCurrentWorkerForCommand(connection, {}), undefined);
  assert.equal(
    await pool.selectSession(connection, { sessionId: "id-only" }),
    undefined,
  );

  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
    managedSessionLeaf: " owner-leaf ",
    parentSession: { sessionId: "parent" },
  });
  await new Promise<void>((resolve) => worker.child.once("spawn", resolve));
  assert.equal(spawned.length, 1);
  pool.setWorkerSessionRefs(worker, {
    sessionFile: "/tmp/public-owner.jsonl",
    sessionId: "public-owner",
  });
  pool.attachWorkerToConnection(connection, worker);

  assert.equal(pool.hasSelectedSession(connection), true);
  assert.equal(await pool.ensureSelectedWorker(connection), worker);
  await pool.terminateWorkerGracefullyIfUnattached(worker);
  assert.equal(worker.gracefulShutdownRequested, false);
  assert.equal(
    pool.resolveCurrentWorkerForCommand(connection, {
      sessionId: "public-owner",
    }),
    worker,
  );
  assert.equal(
    pool.resolveWorkerForCommand(connection, { type: "get_state" }),
    worker,
  );
  assert.deepEqual(await pool.readWorkerState(worker), {
    sessionFile: "/tmp/public-owner.jsonl",
    sessionId: "public-owner",
  });
  await pool.abortWorker(worker);

  assert.equal(
    pool.detachWorker(connection, { clearSelection: true, release: false }),
    worker,
  );
  assert.equal(pool.hasSelectedSession(connection), false);
  pool.attachWorkerToConnection(connection, worker);
  await pool.shutdown(0);
  assert.equal(pool.getStatusSnapshot().workerCount, 0);
  assert.equal(connection.attachedWorker, undefined);
  assert.equal(pool.detachWorker(connection), undefined);
  assert.equal(pool.restoreSessionWorker({}), undefined);
  assert.equal(pool.continueInterruptedTurnSessionWorker({}), undefined);
  assert.equal(pool.replayPendingTerminalTurnEvent(connection), false);
  connection.socket.destroyed = true;
  assert.equal(
    pool.replayPendingTerminalTurnEvent(connection, {
      sessionFile: "/tmp/public-owner.jsonl",
    }),
    false,
  );
  await pool.abortWorker(worker);
  assert.equal(
    pool.resolveWorkerForCommand(connection, { type: "prompt" }),
    undefined,
  );
  assert.throws(
    () => pool.resolveWorkerForCommand(connection, { type: "new_session" }),
    /rin_daemon_shutting_down/,
  );
  assert.deepEqual(writes, []);
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

test("interrupted-turn exhaustion persists one terminal and releases only its owned lifecycle", async () => {
  const dir = await makeTempDir("rin-worker-pool-exhaustion-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5_000,
  });
  const internals = pool as any;

  const absentSelector = { sessionFile: path.join(dir, "absent.jsonl") };
  const absentKey = `file:${absentSelector.sessionFile}`;
  const absentIntent: any = {
    selector: absentSelector,
    source: "owner-exhaustion",
    retryTimer: setTimeout(() => {}, 10_000),
  };
  internals.interruptedTurnRecoveryIntents.set(absentKey, absentIntent);
  internals.exhaustInterruptedTurnRecovery(absentKey, absentIntent);
  assert.equal(internals.interruptedTurnRecoveryIntents.has(absentKey), false);
  const absentWrites: string[] = [];
  const absentConnection = {
    socket: {
      destroyed: false,
      write: (value: string) => absentWrites.push(value),
    },
    clientBuffer: "",
  };
  assert.equal(
    pool.replayPendingTerminalTurnEvent(absentConnection, absentSelector),
    true,
  );
  assert.equal(
    JSON.parse(absentWrites[0]).error,
    "rin_turn_result_recovery_timeout",
  );

  const ownedSelector = { sessionFile: path.join(dir, "owned.jsonl") };
  const worker = pool.restoreSessionWorker(ownedSelector);
  assert.ok(worker);
  worker.turnRecoveryPending = true;
  worker.activeRequestTag = "owned-tag";
  worker.activeLifecycleRequestTag = "owned-tag";
  worker.activeLifecycleSelector = ownedSelector;
  worker.activeLifecycleFrontendOwner = false;
  const ownedKey = `file:${ownedSelector.sessionFile}`;
  const ownedIntent = {
    selector: ownedSelector,
    source: "owner-exhaustion",
    requestTag: "owned-tag",
  };
  internals.interruptedTurnRecoveryIntents.set(ownedKey, ownedIntent);
  internals.exhaustInterruptedTurnRecovery(ownedKey, ownedIntent);
  assert.equal(worker.turnRecoveryPending, false);
  assert.equal(worker.activeRequestTag, undefined);
  assert.equal(worker.activeLifecycleRequestTag, undefined);

  internals.exhaustInterruptedTurnRecovery("missing", ownedIntent);
  worker.activeLifecycleRequestTag = "frontend-tag";
  worker.activeLifecycleSelector = ownedSelector;
  worker.activeLifecycleFrontendOwner = true;
  const frontendIntent = {
    selector: ownedSelector,
    source: "owner-exhaustion",
    requestTag: "frontend-tag",
  };
  internals.interruptedTurnRecoveryIntents.set(ownedKey, frontendIntent);
  internals.exhaustInterruptedTurnRecovery(ownedKey, frontendIntent);
  assert.equal(worker.activeLifecycleRequestTag, "frontend-tag");
});

test("cgroup cleanup failure rejects pending work without recovering the session", async () => {
  const dir = await makeTempDir("rin-worker-pool-cleanup-failure-");
  const workerPath = path.join(dir, "worker-source");
  await fs.writeFile(
    workerPath,
    "setTimeout(() => process.exit(7), 40); process.stdin.resume();\n",
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
  await sleep(20);

  const payloads = writes.map((line) => JSON.parse(line));
  assert.equal(payloads[0]?.type, "worker_exit");
  assert.equal(payloads[1]?.error, "rin_worker_cleanup_failed");
  assert.equal(pool.getStatusSnapshot().workerCount, 0);
});
