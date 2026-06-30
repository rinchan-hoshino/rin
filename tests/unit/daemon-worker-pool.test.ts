import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
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

async function readCommandLog(logPath: string) {
  return (await fs.readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean);
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

test("daemon workers hide Windows console windows", () => {
  const source = fsSync.readFileSync(
    path.join(rootDir, "src", "core", "rin-daemon", "worker-pool.ts"),
    "utf8",
  );
  assert.match(
    source,
    /spawn\(process\.execPath, workerArgs, \{[\s\S]*windowsHide: true/,
  );
});

async function makeTempDir(prefix) {
  const root = process.env.RIN_TEST_TMPDIR || "/home/rin/tmp";
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

  assert.deepEqual((await fs.readFile(logPath, "utf8")).trim().split("\n"), [
    "switch_session",
  ]);

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

  assert.deepEqual((await fs.readFile(logPath, "utf8")).trim().split("\n"), [
    "switch_session:",
    "resume_interrupted_turn:daemon-restart",
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("resumeInterruptedTurnSession resumes selected session and returns terminal result", async () => {
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
    fs.appendFileSync(logPath, command.type + ":" + (command.source || "") + ":" + (command.requestTag || "") + "\\n");
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");
    if (command.type === "resume_interrupted_turn") {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          type: "rpc_turn_event",
          event: "complete",
          requestTag: command.requestTag,
          sessionFile: "/tmp/session.jsonl",
          sessionId: "session-1",
          finalText: "continued final",
          result: { messages: [{ type: "text", text: "continued final" }] }
        }) + "\\n");
      }, 0);
    }
  }
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const result = await pool.resumeInterruptedTurnSession({
    sessionFile: "/tmp/session.jsonl",
    source: "scheduled-task",
    requestTag: "run-1",
  });

  assert.deepEqual((await fs.readFile(logPath, "utf8")).trim().split("\n"), [
    "switch_session::",
    "resume_interrupted_turn:scheduled-task:run-1",
  ]);
  assert.equal(result.finalText, "continued final");
  assert.equal(result.sessionFile, "/tmp/session.jsonl");
  assert.equal(result.sessionId, "session-1");

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("resumeInterruptedTurnSession follows an active turn without sending another resume", async () => {
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
    if (command.type === "switch_session") {
      process.stdout.write(JSON.stringify({
        type: "rpc_turn_event",
        event: "start",
        requestTag: "active-1",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1"
      }) + "\\n");
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          type: "rpc_turn_event",
          event: "complete",
          requestTag: "active-1",
          sessionFile: "/tmp/session.jsonl",
          sessionId: "session-1",
          finalText: "active final"
        }) + "\\n");
      }, 100);
    }
  }
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 1000 });
  const worker = pool.restoreSessionWorker({
    sessionFile: "/tmp/session.jsonl",
  });
  await waitForCommandLogPrefix(logPath, ["switch_session:"], 500);
  assert.ok(worker);
  worker.turnActive = true;
  worker.rpcTurnActive = true;

  const result = await pool.resumeInterruptedTurnSession({
    sessionFile: "/tmp/session.jsonl",
    source: "scheduled-task",
    requestTag: "run-1",
  });

  assert.deepEqual((await fs.readFile(logPath, "utf8")).trim().split("\n"), [
    "switch_session:",
  ]);
  assert.equal(result.finalText, "active final");
  assert.equal(result.sessionFile, "/tmp/session.jsonl");

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("selectSession waits for daemon-restart recovery instead of spawning a duplicate worker", async () => {
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
    if (command.type === 'switch_session') {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { sessionFile, sessionId: 'pending-turn-session' },
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

test("resumable worker commands persist a running record until they finish", async () => {
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
    { id: "prompt-1", type: "prompt", sessionFile },
    true,
  );

  await sleep(100);

  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
  });
  assert.equal(pool.getStatusSnapshot().workers[0]?.turnActive, true);
  assert.equal(pool.getStatusSnapshot().workers[0]?.isStreaming, false);

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

  for (let i = 0; i < 50; i += 1) {
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
    ["sleep_session", "switch_session"],
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
    "switch_session",
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
  assert.deepEqual(
    (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean),
    ["switch_session", "switch_session"],
  );

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
  assert.deepEqual(
    (
      await waitForCommandLogPrefix(logPath, [
        "shutdown_session",
        "switch_session",
      ])
    ).slice(0, 2),
    ["shutdown_session", "switch_session"],
  );

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
  assert.deepEqual(
    (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean),
    ["switch_session"],
  );

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
  const startedPath = path.join(dir, "switch-started.log");
  const releasePath = path.join(dir, "switch-release");
  const sessionFile = "/tmp/concurrent-selected.jsonl";
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
process.stdin.setEncoding('utf8');
let buffer='';
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
        fs.appendFileSync(${JSON.stringify(startedPath)}, String(process.pid) + '\n');
        while (!fs.existsSync(${JSON.stringify(releasePath)})) await sleep(10);
      }
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { cancelled: false, sessionFile: command.sessionPath, sessionId: 'concurrent-selected' },
      }) + '\n');
    }
  })();
});
setInterval(() => {}, 1000);
`,
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
  const firstSelection = pool.selectSession(firstConnection, { sessionFile });
  const secondSelection = pool.selectSession(secondConnection, { sessionFile });

  for (let i = 0; i < 50; i += 1) {
    try {
      const started = (await fs.readFile(startedPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      if (started.length >= 1) break;
    } catch {}
    await sleep(10);
  }

  await fs.writeFile(releasePath, "release");
  const [firstWorker, secondWorker] = await Promise.all([
    firstSelection,
    secondSelection,
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
  const startedPath = path.join(dir, "restore-started.log");
  const releasePath = path.join(dir, "restore-release");
  const sessionFile = "/tmp/restore-dedupe.jsonl";
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
process.stdin.setEncoding('utf8');
let buffer='';
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
        fs.appendFileSync(${JSON.stringify(startedPath)}, String(process.pid) + '\n');
        while (!fs.existsSync(${JSON.stringify(releasePath)})) await sleep(10);
      }
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { cancelled: false, sessionFile: command.sessionPath, sessionId: 'restore-dedupe' },
      }) + '\n');
    }
  })();
});
setInterval(() => {}, 1000);
`,
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  pool.restoreSessionWorker({ sessionFile });
  pool.restoreSessionWorker({ sessionFile });

  for (let i = 0; i < 50; i += 1) {
    try {
      const started = (await fs.readFile(startedPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      if (started.length >= 1) break;
    } catch {}
    await sleep(10);
  }

  await fs.writeFile(releasePath, "release");
  for (let i = 0; i < 50; i += 1) {
    const status = pool.getStatusSnapshot();
    if (
      status.workerCount === 1 &&
      status.workers[0]?.sessionFile === sessionFile
    ) {
      break;
    }
    await sleep(10);
  }

  const status = pool.getStatusSnapshot();
  assert.equal(status.workerCount, 1);
  assert.equal(status.workers[0]?.sessionFile, sessionFile);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("restoreSessionWorker indexes the session only after switch_session succeeds", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker-source");
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

test("worker crash recovery shares the session claim with concurrent selection", async () => {
  const dir = await makeTempDir("rin-worker-pool-recover-claim-");
  const workerPath = path.join(dir, "worker-source");
  const firstRunMarker = path.join(dir, "first-run.txt");
  const startedPath = path.join(dir, "switch-started.log");
  const releasePath = path.join(dir, "switch-release");
  const sessionFile = "/tmp/recover-claim.jsonl";
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
const marker = ${JSON.stringify(firstRunMarker)};
const firstRun = !fs.existsSync(marker);
if (firstRun) fs.writeFileSync(marker, 'done');
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
process.stdin.setEncoding('utf8');
let buffer='';
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
      if (command.type === 'get_state' && firstRun) {
        process.exit(9);
      }
      if (command.type === 'switch_session') {
        fs.appendFileSync(${JSON.stringify(startedPath)}, String(process.pid) + '\n');
        while (!fs.existsSync(${JSON.stringify(releasePath)})) await sleep(10);
      }
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { sessionFile: command.sessionPath || ${JSON.stringify(sessionFile)}, sessionId: 'recover-claim', isStreaming: false, isCompacting: false },
      }) + '\n');
    }
  })();
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
    try {
      const started = (await fs.readFile(startedPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      if (started.length >= 1) break;
    } catch {}
    await sleep(10);
  }

  const selectedPromise = pool.selectSession(secondConnection, { sessionFile });
  await sleep(50);
  await fs.writeFile(releasePath, "release");
  const selected = await selectedPromise;

  for (let i = 0; i < 50; i += 1) {
    if (writes.some((value) => JSON.parse(value).type === "session_recovered"))
      break;
    await sleep(10);
  }

  const status = pool.getStatusSnapshot();
  const started = (await fs.readFile(startedPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean);

  assert.equal(Boolean(selected), true);
  assert.equal(status.workerCount, 1);
  assert.equal(status.workers[0]?.sessionFile, sessionFile);
  assert.equal(status.workers[0]?.attachedConnections, 2);
  assert.equal(started.length, 1);

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
