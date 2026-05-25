import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { WorkerPool } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "worker-pool.js"),
  ).href
);

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

async function makeTempDir(prefix) {
  const root = process.env.RIN_TEST_TMPDIR || "/home/rin/tmp";
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, prefix));
  activeDirs.add(dir);
  return dir;
}

test("new session workers receive rpc resource options through a private file", async () => {
  const dir = await makeTempDir("rin-worker-pool-resources-");
  const outputPath = path.join(dir, "resource-options.json");
  const workerPath = path.join(dir, "worker.mjs");
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
  pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    {
      type: "new_session",
      resourceOptions: {
        additionalExtensionPaths: ["/ext"],
        noExtensions: true,
        extensionFlagValues: [["flag", true]],
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
        additionalSkillPaths: ["/skill"],
        noSkills: true,
        additionalPromptTemplatePaths: ["/prompt"],
        noPromptTemplates: true,
        additionalThemePaths: ["/theme"],
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "system",
        appendSystemPrompt: ["append"],
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
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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

  assert.deepEqual((await fs.readFile(logPath, "utf8")).trim().split("\n"), [
    "switch_session",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("continueInterruptedTurnSessionWorker attaches then continues the turn", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
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

  assert.deepEqual((await fs.readFile(logPath, "utf8")).trim().split("\n"), [
    "switch_session:",
    "resume_interrupted_turn:daemon-restart",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("selectSession waits for daemon-restart recovery instead of spawning a duplicate worker", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
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
  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
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
  assert.deepEqual((await fs.readFile(logPath, "utf8")).trim().split("\n"), [
    "switch_session:",
    "resume_interrupted_turn:daemon-restart",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("resumable worker commands persist a running record until they finish", async () => {
  const dir = await makeTempDir("rin-worker-pool-running-");
  const workerPath = path.join(dir, "worker.mjs");
  const sessionFile = path.join(dir, "session.jsonl");
  const statePath = path.join(dir, "data", "running-workers.json");
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
    { id: "prompt-1", type: "prompt", sessionFile },
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

test("detached worker survives eviction while response is pending", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
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

test("attached worker stays alive across detached-worker sweeps", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
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
    gcIdleMs: 10,
    sweepIntervalMs: 10,
  });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.requestWorker(worker, connection, { type: "get_state" }, true);

  await sleep(80);

  assert.equal(pool.getStatusSnapshot().workerCount, 1);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("detached idle worker sleeps instead of terminating the session", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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
  assert.deepEqual(
    (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean),
    ["switch_session", "switch_session"],
  );

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("selectSession lazily restores the chosen session worker", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
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

test("restoreSessionWorker indexes the session only after switch_session succeeds", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
  const startedPath = path.join(dir, "switch-started");
  const releasePath = path.join(dir, "switch-release");
  const sessionFile = "/tmp/restored-after-switch.jsonl";
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
process.stdin.setEncoding('utf8');
let buffer='';
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  void (async () => {
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const command = JSON.parse(line);
      if (command.type === 'switch_session') {
        fs.writeFileSync(${JSON.stringify(startedPath)}, 'started');
        while (!fs.existsSync(${JSON.stringify(releasePath)})) await sleep(10);
      }
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { cancelled: false, sessionFile: command.sessionPath, sessionId: 'restored-session' },
      }) + '\n');
    }
  })();
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  pool.restoreSessionWorker({ sessionFile });

  for (let i = 0; i < 50; i += 1) {
    try {
      await fs.access(startedPath);
      break;
    } catch {
      await sleep(10);
    }
  }
  assert.equal(
    pool
      .getStatusSnapshot()
      .workers.some((worker) => worker.sessionFile === sessionFile),
    false,
  );

  await fs.writeFile(releasePath, "release");
  for (let i = 0; i < 50; i += 1) {
    if (
      pool
        .getStatusSnapshot()
        .workers.some((worker) => worker.sessionFile === sessionFile)
    ) {
      break;
    }
    await sleep(10);
  }
  assert.equal(
    pool
      .getStatusSnapshot()
      .workers.some((worker) => worker.sessionFile === sessionFile),
    true,
  );

  pool.destroyAll();
});

test("attached session worker auto-recovers without dropping the daemon connection", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
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

test("worker events are forwarded only to matching selected session", async () => {
  const dir = await makeTempDir("rin-worker-pool-session-filter-");
  const workerPath = path.join(dir, "worker.mjs");
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
    `${JSON.stringify({ type: "rpc_turn_event", event: "complete", sessionFile: sessionA })}\n`,
  );
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "rpc_turn_event", event: "complete", sessionFile: sessionB })}\n`,
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
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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

  pool.forwardToWorker(connection, worker, { id: "1", type: "prompt" });

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

test("graceful worker commands destroy workers with closed stdin", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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
  const workerPath = path.join(dir, "worker.mjs");
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
