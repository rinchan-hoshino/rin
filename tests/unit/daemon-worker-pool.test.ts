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

function terminalTurnResult(payload: any, sessionFile: string) {
  if (payload?.event === "error") {
    throw new Error(String(payload.error || "rin_turn_failed"));
  }
  return {
    finalText: String(payload?.finalText || ""),
    result: payload?.result,
    sessionFile: String(payload?.sessionFile || sessionFile),
    sessionId: String(payload?.sessionId || ""),
  };
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

test("daemon workers mark cross-platform update ownership", () => {
  const source = fsSync.readFileSync(
    path.join(rootDir, "src", "core", "rin-daemon", "worker-pool.ts"),
    "utf8",
  );
  assert.match(
    source,
    /\[RIN_DAEMON_WORKER_OWNER_ENV\]: os\.userInfo\(\)\.username/,
  );
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

test("replacement worker working events supersede stale get_state visibility snapshots", async () => {
  const dir = await makeTempDir("rin-worker-pool-working-epoch-");
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
    const eventVisible = command.scenario === "event-visible";
    process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "extension_ui_request",
      method: "setWorkingVisible",
      visible: eventVisible,
    }) + "\\n");
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: {
          sessionFile,
          sessionId: "working-epoch",
          turnActive: true,
          isStreaming: true,
          workingVisible: !eventVisible,
          interruptedTurnResumable: true,
        },
      }) + "\\n");
    }, 20);
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
  const worker = await pool.selectSession(connection, { sessionFile });
  assert.ok(worker);
  worker.activeLifecycleRequestTag = "chat-inbox-working-epoch";
  worker.activeLifecycleSelector = { sessionFile };
  worker.activeLifecycleFrontendOwner = true;

  const visibleState = await pool.sendInternalCommand(worker, {
    type: "get_state",
    scenario: "event-visible",
  });
  const persistedVisible = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(visibleState.data?.workingVisible, true);
  assert.deepEqual(persistedVisible.workingVisibilities, {
    [sessionFile]: true,
  });

  const hiddenState = await pool.sendInternalCommand(worker, {
    type: "get_state",
    scenario: "event-hidden",
  });
  const persistedHidden = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(hiddenState.data?.workingVisible, false);
  assert.equal(persistedHidden.workingVisibilities, undefined);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("unowned active snapshots cannot create working visibility", async () => {
  const dir = await makeTempDir("rin-worker-pool-working-unowned-snapshot-");
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
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: {
        sessionFile,
        sessionId: "working-unowned-snapshot",
        requestTag: "unowned",
        turnGeneration: 1,
        turnActive: true,
        isStreaming: true,
        workingVisible: true,
        interruptedTurnResumable: true,
      },
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
  const pool = new WorkerPool({
    workerPath,
    cwd: dir,
    agentDir: dir,
    gcIdleMs: 5000,
  });
  const worker = await pool.selectSession(connection, { sessionFile });
  assert.ok(worker);
  const state = await pool.sendInternalCommand(worker, { type: "get_state" });
  const persistedState = JSON.parse(await fs.readFile(statePath, "utf8"));

  assert.equal(state.data?.workingVisible, false);
  assert.equal(persistedState.workingVisibilities, undefined);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
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
  assert.equal(worker.terminalPending, false);
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

test("exact terminal wait survives command detach with the same durable terminal event", async () => {
  const dir = await makeTempDir("rin-worker-pool-session-events-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
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
  const pool = new WorkerPool({ workerPath, cwd: dir, agentDir: dir });
  pool.registerConnection(connection);
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.attachWorkerToConnection(connection, worker);
  pool.forwardToWorker(connection, worker, {
    id: "prompt-1",
    type: "prompt",
    message: "run",
    requestTag: "run-request",
    sessionFile,
    chatDeliveryContext: {
      turnId: "session-event-turn",
      chatKey: "discord/1:2",
      messageId: "message-event",
    },
  });
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "rpc_turn_event", event: "start", requestTag: "run-request", turnGeneration: 1, sessionFile, sessionId: "run-session" })}\n`,
  );
  writes.length = 0;
  pool.detachWorker(connection, { release: false });
  const terminal = pool.awaitTerminalTurnEvent(
    connection,
    { sessionFile },
    "run-request",
  );
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "rpc_turn_event", event: "complete", requestTag: "run-request", turnGeneration: 1, sessionFile, sessionId: "run-session", finalText: "durable final" })}\n`,
  );
  const result = await terminal;
  assert.equal(result.finalText, "durable final");
  assert.equal(result.terminalRecord.state, "complete");
  assert.equal(
    writes.some((line) => line.includes("durable final")),
    true,
  );
  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("terminal wait resolves independently of pushed frontend event delivery", async () => {
  const dir = await makeTempDir("rin-worker-pool-terminal-wait-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, agentDir: dir });
  pool.registerConnection(connection);
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.attachWorkerToConnection(connection, worker);
  pool.forwardToWorker(connection, worker, {
    id: "wait-prompt",
    type: "prompt",
    message: "run",
    requestTag: "wait-request",
    sessionFile,
  });
  const terminal = pool.awaitTerminalTurnEvent(
    connection,
    { sessionFile },
    "wait-request",
  );
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rpc_turn_event",
      event: "start",
      requestTag: "wait-request",
      turnGeneration: 1,
      sessionFile,
      sessionId: "wait-session",
    })}\n`,
  );
  pool.detachWorker(connection, { release: false });

  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "wait-request",
      turnGeneration: 1,
      sessionFile,
      sessionId: "wait-session",
      finalText: "wait final",
    })}\n`,
  );
  const result = await Promise.race([
    terminal,
    sleep(1000).then(() => {
      throw new Error("terminal wait did not resolve");
    }),
  ]);
  assert.equal(result.finalText, "wait final");
  assert.equal(pool.terminalTurnWaiters.size, 0);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("disconnect rejects and removes terminal waits", async () => {
  const dir = await makeTempDir("rin-worker-pool-terminal-disconnect-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, agentDir: dir });
  pool.registerConnection(connection);
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.attachWorkerToConnection(connection, worker);
  await assert.rejects(
    pool.awaitTerminalTurnEvent(connection, { sessionFile }),
    /await_turn_terminal requires requestTag/,
  );
  pool.forwardToWorker(connection, worker, {
    id: "disconnect-prompt",
    type: "prompt",
    message: "run",
    requestTag: "disconnect-request",
    sessionFile,
  });
  const terminal = pool.awaitTerminalTurnEvent(
    connection,
    { sessionFile },
    "disconnect-request",
  );
  pool.unregisterConnection(connection);

  await assert.rejects(terminal, /Frontend connection closed/);
  assert.equal(pool.terminalTurnWaiters.size, 0);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker exit durably interrupts the exact turn before resolving its waiter", async () => {
  const dir = await makeTempDir("rin-worker-pool-interrupted-exit-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, agentDir: dir });
  pool.registerConnection(connection);
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.attachWorkerToConnection(connection, worker);
  pool.forwardToWorker(connection, worker, {
    id: "interrupted-prompt",
    type: "prompt",
    message: "run",
    requestTag: "interrupted-request",
    sessionFile,
    chatDeliveryContext: {
      turnId: "interrupted-turn",
      chatKey: "discord/1:2",
      messageId: "interrupted-message",
    },
  });
  const terminal = pool.awaitTerminalTurnEvent(
    connection,
    { sessionFile },
    "interrupted-request",
  );
  worker.child.kill("SIGKILL");
  const result = await Promise.race([
    terminal,
    sleep(1000).then(() => {
      throw new Error("interrupted terminal did not resolve");
    }),
  ]);
  assert.equal(result.event, "error");
  assert.equal(result.terminalRecord.state, "interrupted");
  assert.match(result.error, /worker[ _]exit|signal/i);
  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("worker exit reaches selected and transient command audiences", async () => {
  const dir = await makeTempDir("rin-worker-pool-exit-audience-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const selectedWrites: string[] = [];
  const transientWrites: string[] = [];
  const selected = {
    socket: {
      destroyed: false,
      write(value: string) {
        selectedWrites.push(String(value));
      },
    },
    clientBuffer: "",
  };
  const transient = {
    socket: {
      destroyed: false,
      write(value: string) {
        transientWrites.push(String(value));
      },
    },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, agentDir: dir });
  pool.registerConnection(selected);
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.attachWorkerToConnection(selected, worker);
  pool.detachWorker(selected, { release: false });
  pool.attachWorkerToConnection(transient, worker);
  transient.sessionFile = undefined;
  transient.sessionId = undefined;

  pool.destroyWorker(worker);

  assert.equal(JSON.parse(selectedWrites[0]).type, "worker_exit");
  assert.equal(JSON.parse(transientWrites[0]).type, "worker_exit");
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

  await sleep(60);
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
      turnGeneration: 1,
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

  const beforeHeartbeat = await fs.stat(statePath, { bigint: true });
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rpc_turn_event",
      event: "heartbeat",
      requestTag: "rpc-running",
      turnGeneration: 1,
      sessionFile,
      sessionId: "active",
    })}\n`,
  );
  await sleep(20);
  const afterHeartbeat = await fs.stat(statePath, { bigint: true });
  assert.equal(afterHeartbeat.ino, beforeHeartbeat.ino);
  assert.equal(afterHeartbeat.mtimeNs, beforeHeartbeat.mtimeNs);

  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "rpc-running",
      turnGeneration: 1,
      sessionFile,
      sessionId: "active",
    })}\n`,
  );
  await sleep(20);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [],
  });
  assert.equal(pool.getStatusSnapshot().workers[0]?.turnActive, false);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("a started Pi steer does not transfer transport terminal ownership", async () => {
  const dir = await makeTempDir("rin-worker-pool-steered-terminal-owner-");
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
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.requestWorker(
    worker,
    connection,
    {
      id: "original-prompt",
      type: "prompt",
      message: "original",
      requestTag: "tag-original",
      sessionFile,
    },
    true,
  );
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      id: "original-prompt",
      type: "response",
      command: "prompt",
      success: true,
      data: {},
    })}\n`,
  );
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rpc_turn_event",
      event: "start",
      requestTag: "tag-original",
      turnGeneration: 1,
      sessionFile,
      sessionId: "active",
    })}\n`,
  );
  const terminalResultPromise = (pool as any).waitForTerminalTurnEvent(
    worker,
    { sessionFile },
    "tag-original",
  ).promise;
  const lifecycleEpochBeforeSteer = worker.activeLifecycleEpoch;
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "message_start",
      requestTag: "tag-steered",
      message: { role: "user", content: [{ type: "text", text: "steer" }] },
    })}\n`,
  );
  await sleep(0);

  assert.equal(worker.activeLifecycleRequestTag, "tag-original");
  assert.equal(worker.activeRequestTag, "tag-original");
  assert.equal(worker.activeLifecycleOwnerCommandId, "original-prompt");
  assert.equal(worker.activeLifecycleEpoch, lifecycleEpochBeforeSteer);
  assert.equal(worker.activeTurnGeneration, 1);
  assert.equal(worker.turnActive, true);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
    schemaVersion: 1,
    sessionFiles: [sessionFile],
    requestTags: { [sessionFile]: "tag-original" },
    frontendOwners: { [sessionFile]: true },
  });

  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "tag-original",
      turnGeneration: 1,
      sessionFile,
      sessionId: "active",
      finalText: "Pi-owned final",
    })}\n`,
  );
  await sleep(0);

  const terminalResult = await Promise.race([
    terminalResultPromise,
    sleep(100).then(() => {
      throw new Error("Pi terminal waiter did not settle");
    }),
  ]);
  assert.equal(terminalResult.requestTag, "tag-original");
  assert.equal(terminalResult.finalText, "Pi-owned final");
  assert.equal(worker.turnActive, false);
  assert.equal(worker.rpcTurnActive, false);
  assert.equal(
    writes.some(
      (value) =>
        value.includes('"event":"complete"') &&
        value.includes('"requestTag":"tag-original"') &&
        value.includes('"finalText":"Pi-owned final"'),
    ),
    true,
  );

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
    turnGeneration: 2,
    sessionFile,
    sessionId: "active",
  });
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "tag-current",
    turnGeneration: 2,
    sessionFile,
    sessionId: "different-session-id",
    finalText: "cross-session",
  });
  assert.equal(worker.turnActive, true);
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "start",
    requestTag: "tag-stale",
    turnGeneration: 1,
    sessionFile,
    sessionId: "active",
  });
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "tag-stale",
    turnGeneration: 1,
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
    turnGeneration: 2,
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
    turnGeneration: 2,
    sessionFile,
    sessionId: "active",
  });
  (pool as any).updateWorkerMetadata(worker, {
    type: "rpc_turn_event",
    event: "heartbeat",
    requestTag: "tag-current",
    turnGeneration: 2,
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
    ["sleep_session"],
  );

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

test("terminal ledger replays an exact result after socket delivery is missed", async () => {
  const dir = await makeTempDir("rin-worker-pool-ledger-replay-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const first = { socket: { destroyed: false, write() {} }, clientBuffer: "" };
  const pool = new WorkerPool({ workerPath, cwd: dir, agentDir: dir });
  pool.registerConnection(first);
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.attachWorkerToConnection(first, worker);
  pool.forwardToWorker(first, worker, {
    id: "replay-prompt",
    type: "prompt",
    message: "run",
    requestTag: "replay-request",
    sessionFile,
    chatDeliveryContext: {
      turnId: "replay-turn",
      chatKey: "discord/1:2",
      messageId: "replay-message",
    },
  });
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rpc_turn_event",
      event: "start",
      requestTag: "replay-request",
      turnGeneration: 1,
      sessionFile,
      sessionId: "replay-session",
    })}\n`,
  );
  first.socket.destroyed = true;
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "replay-request",
      turnGeneration: 1,
      sessionFile,
      sessionId: "replay-session",
      finalText: "replayed durable final",
    })}\n`,
  );

  const second = { socket: { destroyed: false, write() {} }, clientBuffer: "" };
  pool.registerConnection(second);
  const recovered = await pool.awaitTerminalTurnEvent(
    second,
    { sessionFile },
    "replay-request",
  );
  assert.equal(recovered.finalText, "replayed durable final");
  assert.equal(recovered.terminalRecord.state, "complete");
  assert.equal(recovered.chatDeliveryContext.turnId, "replay-turn");

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("duplicate request admission returns the existing lifecycle without resending prompt", async () => {
  const dir = await makeTempDir("rin-worker-pool-idempotent-admission-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const responses = [];
  const connection = {
    socket: {
      destroyed: false,
      write(value) {
        responses.push(JSON.parse(String(value)));
      },
    },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, agentDir: dir });
  pool.registerConnection(connection);
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.attachWorkerToConnection(connection, worker);
  const commands = [];
  pool.writeWorkerStdin = (_worker, command, callback) => {
    commands.push(command);
    callback?.();
  };
  const prompt = {
    type: "prompt",
    message: "run exactly once",
    requestTag: "idempotent-request",
    sessionFile,
    chatDeliveryContext: {
      turnId: "idempotent-turn",
      chatKey: "discord/1:2",
      messageId: "idempotent-message",
    },
  };
  pool.forwardToWorker(connection, worker, { id: "prompt-first", ...prompt });
  pool.forwardToWorker(connection, worker, { id: "prompt-retry", ...prompt });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].chatDeliveryContext, undefined);
  assert.equal(
    responses.some(
      (response) =>
        response.id === "prompt-retry" &&
        response.success === true &&
        response.data?.duplicate === true,
    ),
    true,
  );
  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("rejected prompt admission durably interrupts the ledger and resolves terminal wait", async () => {
  const dir = await makeTempDir("rin-worker-pool-rejected-admission-");
  const workerPath = path.join(dir, "worker-source");
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const connection = {
    socket: { destroyed: false, write() {} },
    clientBuffer: "",
  };
  const pool = new WorkerPool({ workerPath, cwd: dir, agentDir: dir });
  pool.registerConnection(connection);
  const worker = pool.restoreSessionWorker({ sessionFile });
  assert.ok(worker);
  pool.attachWorkerToConnection(connection, worker);
  pool.writeWorkerStdin = () => {};
  pool.forwardToWorker(connection, worker, {
    id: "rejected-prompt",
    type: "prompt",
    message: "reject",
    requestTag: "rejected-request",
    sessionFile,
  });
  const terminal = pool.awaitTerminalTurnEvent(
    connection,
    { sessionFile },
    "rejected-request",
  );
  worker.child.stdout.emit(
    "data",
    `${JSON.stringify({
      id: "rejected-prompt",
      type: "response",
      command: "prompt",
      success: false,
      error: "rpc_prompt_rejected",
    })}\n`,
  );
  const result = await terminal;
  assert.equal(result.event, "error");
  assert.equal(result.error, "rpc_prompt_rejected");
  assert.equal(result.terminalRecord.state, "interrupted");

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});
