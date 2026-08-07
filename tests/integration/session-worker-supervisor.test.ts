import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(import.meta.dirname, "..", "..");
const supervisorModule = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "worker-supervisor.js"),
  ).href
);
const rpcModeModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "rpc-mode.js"))
    .href
);

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) {
        return reject(new Error("condition timed out"));
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function parsedLines(chunks: string[]) {
  return chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("session worker supervisor replaces a synchronously blocked execution plane and reaches native abort without replaying the prompt", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-worker-supervisor-owner-"),
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const outputChunks: string[] = [];
  const errorChunks: string[] = [];
  output.on("data", (chunk) => outputChunks.push(String(chunk)));
  errorOutput.on("data", (chunk) => errorChunks.push(String(chunk)));
  const fixtureLogPath = path.join(root, "executor.log");
  const fixtureSessionFile = path.join(root, "session.jsonl");

  const supervisor = supervisorModule.runWorkerSupervisor(
    { fixtureLogPath, fixtureSessionFile },
    {
      input,
      output,
      errorOutput,
      executionPath: path.join(
        rootDir,
        "tests",
        "support",
        "session-worker-execution-fixture.mjs",
      ),
      abortGraceMs: 50,
      executionStartupTimeoutMs: 1_000,
    },
  );

  try {
    input.write(
      `${JSON.stringify({
        id: "turn-1",
        type: "start_blocking_turn",
        requestTag: "request-blocked",
      })}\n`,
    );
    await waitFor(() =>
      parsedLines(outputChunks).some(
        (entry) => entry.type === "rpc_turn_event" && entry.event === "start",
      ),
    );

    const abortStartedAt = Date.now();
    input.write(`${JSON.stringify({ id: "abort-1", type: "abort" })}\n`);
    await waitFor(() =>
      parsedLines(outputChunks).some(
        (entry) =>
          entry.type === "response" &&
          entry.id === "abort-1" &&
          entry.command === "abort" &&
          entry.success === true,
      ),
    );
    assert.ok(
      Date.now() - abortStartedAt < 1_000,
      "abort must not wait for the blocked execution event loop",
    );

    const entries = parsedLines(outputChunks);
    assert.ok(
      entries.some(
        (entry) =>
          entry.type === "rpc_turn_event" &&
          entry.event === "error" &&
          entry.requestTag === "request-blocked",
      ),
      "the replacement execution plane must publish Pi-observed settlement",
    );
    const log = (await fs.readFile(fixtureLogPath, "utf8")).trim().split("\n");
    assert.equal(
      log.filter((line) => line === "start-blocking").length,
      1,
      "the accepted prompt must not be replayed",
    );
    assert.ok(log.includes(`open:${fixtureSessionFile}`));
    assert.ok(log.includes("native-abort:request-blocked"));
    assert.equal(errorChunks.join(""), "");
  } finally {
    input.end();
    await supervisor;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("session worker supervisor keeps a responsive Pi execution plane after native abort starts", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-worker-supervisor-responsive-owner-"),
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const outputChunks: string[] = [];
  output.on("data", (chunk) => outputChunks.push(String(chunk)));
  const fixtureLogPath = path.join(root, "executor.log");
  const fixtureSessionFile = path.join(root, "session.jsonl");
  const supervisor = supervisorModule.runWorkerSupervisor(
    {
      fixtureLogPath,
      fixtureSessionFile,
      fixtureAbortMode: "ack-delay",
    },
    {
      input,
      output,
      errorOutput,
      executionPath: path.join(
        rootDir,
        "tests",
        "support",
        "session-worker-execution-fixture.mjs",
      ),
      abortGraceMs: 50,
      executionStartupTimeoutMs: 1_000,
    },
  );

  try {
    input.write(
      `${JSON.stringify({ id: "abort-direct", type: "abort" })}\n${JSON.stringify(
        {
          id: "abort-overlap",
          type: "abort",
        },
      )}\n`,
    );
    await waitFor(() => {
      const entries = parsedLines(outputChunks);
      return ["abort-direct", "abort-overlap"].every((id) =>
        entries.some((entry) => entry.type === "response" && entry.id === id),
      );
    });
    const entries = parsedLines(outputChunks);
    assert.equal(
      entries.some((entry) => entry.type === "rpc_control_event"),
      false,
      "the supervisor-owned control acknowledgement must stay internal",
    );
    assert.equal(
      entries.some((entry) =>
        String(entry.id || "").startsWith("rin_supervisor_state_"),
      ),
      false,
      "the supervisor startup probe must stay internal",
    );
    const log = (await fs.readFile(fixtureLogPath, "utf8")).trim().split("\n");
    assert.equal(
      log.filter((line) => line.startsWith("direct-abort:")).length,
      2,
    );
    assert.equal(log.filter((line) => line.startsWith("open:")).length, 0);
  } finally {
    input.end();
    await supervisor;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("session worker supervisor fails closed on startup rejection and unexpected execution exit", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-worker-supervisor-failure-owner-"),
  );
  const executionPath = path.join(
    rootDir,
    "tests",
    "support",
    "session-worker-execution-fixture.mjs",
  );
  try {
    const rejectedInput = new PassThrough();
    await assert.rejects(
      supervisorModule.runWorkerSupervisor(
        {
          fixtureLogPath: path.join(root, "startup.log"),
          fixtureSessionFile: path.join(root, "startup.jsonl"),
          fixtureStartupFailure: true,
        },
        {
          input: rejectedInput,
          output: new PassThrough(),
          errorOutput: new PassThrough(),
          executionPath,
          executionStartupTimeoutMs: 1_000,
        },
      ),
      /fixture startup failure/,
    );

    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const outputChunks: string[] = [];
    const errorChunks: string[] = [];
    output.on("data", (chunk) => outputChunks.push(String(chunk)));
    errorOutput.on("data", (chunk) => errorChunks.push(String(chunk)));
    const crashed = supervisorModule.runWorkerSupervisor(
      {
        fixtureLogPath: path.join(root, "crash.log"),
        fixtureSessionFile: path.join(root, "crash.jsonl"),
      },
      { input, output, errorOutput, executionPath },
    );
    input.write(`${JSON.stringify({ id: "crash", type: "crash" })}\n`);
    await assert.rejects(crashed, /rin_execution_plane_exit/);
    assert.match(outputChunks.join(""), /fixture raw stdout/);
    assert.match(errorChunks.join(""), /fixture execution stderr/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("session worker supervisor fails a blocked abort without durable session identity", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-worker-supervisor-no-session-owner-"),
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks: string[] = [];
  output.on("data", (chunk) => outputChunks.push(String(chunk)));
  const supervisor = supervisorModule.runWorkerSupervisor(
    {
      fixtureLogPath: path.join(root, "executor.log"),
      fixtureSessionFile: path.join(root, "session.jsonl"),
      fixtureOmitSessionFile: true,
      fixtureIgnoreSigterm: true,
    },
    {
      input,
      output,
      errorOutput: new PassThrough(),
      executionPath: path.join(
        rootDir,
        "tests",
        "support",
        "session-worker-execution-fixture.mjs",
      ),
      abortGraceMs: 30,
    },
  );
  try {
    input.write(
      `${JSON.stringify({
        id: "turn-no-session",
        type: "start_blocking_turn",
        requestTag: "request-no-session",
      })}\n`,
    );
    await waitFor(() =>
      parsedLines(outputChunks).some((entry) => entry.id === "turn-no-session"),
    );
    input.write(
      `${JSON.stringify({ id: "abort-no-session", type: "abort" })}\n`,
    );
    await waitFor(() =>
      parsedLines(outputChunks).some(
        (entry) =>
          entry.id === "abort-no-session" &&
          entry.success === false &&
          String(entry.error).includes("rin_execution_plane_session_unknown"),
      ),
    );
  } finally {
    input.end();
    await supervisor;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("session worker supervisor drains commands received while an idle blocked plane is replaced", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-worker-supervisor-queued-owner-"),
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks: string[] = [];
  output.on("data", (chunk) => outputChunks.push(String(chunk)));
  const supervisor = supervisorModule.runWorkerSupervisor(
    {
      fixtureLogPath: path.join(root, "executor.log"),
      fixtureSessionFile: path.join(root, "session.jsonl"),
      fixtureBlockWithoutTurn: true,
      fixtureRecoveryStartupDelayMs: 120,
    },
    {
      input,
      output,
      errorOutput: new PassThrough(),
      executionPath: path.join(
        rootDir,
        "tests",
        "support",
        "session-worker-execution-fixture.mjs",
      ),
      abortGraceMs: 30,
    },
  );
  try {
    input.write(
      `${JSON.stringify({
        id: "idle-block",
        type: "start_blocking_turn",
        requestTag: "unused-request",
      })}\n`,
    );
    await waitFor(() =>
      parsedLines(outputChunks).some((entry) => entry.id === "idle-block"),
    );
    input.write(`${JSON.stringify({ id: "abort-idle", type: "abort" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    input.write(
      `${JSON.stringify({ id: "queued-state", type: "get_state" })}\n`,
    );
    await waitFor(() => {
      const entries = parsedLines(outputChunks);
      return ["abort-idle", "queued-state"].every((id) =>
        entries.some((entry) => entry.type === "response" && entry.id === id),
      );
    });
    const log = (await fs.readFile(path.join(root, "executor.log"), "utf8"))
      .trim()
      .split("\n");
    assert.ok(log.includes("direct-abort:abort-idle"));
    assert.equal(log.filter((line) => line === "start-blocking").length, 1);
  } finally {
    input.end();
    await supervisor;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("session worker supervisor rejects private and malformed input and obeys its control signal", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-worker-supervisor-input-owner-"),
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks: string[] = [];
  output.on("data", (chunk) => outputChunks.push(String(chunk)));
  const shutdown = new AbortController();
  const supervisor = supervisorModule.runWorkerSupervisor(
    {
      fixtureLogPath: path.join(root, "executor.log"),
      fixtureSessionFile: path.join(root, "session.jsonl"),
    },
    {
      input,
      output,
      errorOutput: new PassThrough(),
      executionPath: path.join(
        rootDir,
        "tests",
        "support",
        "session-worker-execution-fixture.mjs",
      ),
      signal: shutdown.signal,
    },
  );
  try {
    input.write(`not-json\n`);
    input.write(
      `${JSON.stringify({ id: "private", type: "abort_interrupted_turn" })}\n`,
    );
    input.write(`${JSON.stringify({ id: "direct", type: "abort" })}\n`);
    await waitFor(() => {
      const entries = parsedLines(outputChunks);
      return [undefined, "private", "direct"].every((id) =>
        entries.some((entry) => entry.type === "response" && entry.id === id),
      );
    });
    shutdown.abort();
    await supervisor;
  } finally {
    input.end();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("session worker supervisor honors a control signal already aborted at startup", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-worker-supervisor-pre-abort-owner-"),
  );
  const shutdown = new AbortController();
  shutdown.abort();
  try {
    await supervisorModule.runWorkerSupervisor(
      {
        fixtureLogPath: path.join(root, "executor.log"),
        fixtureSessionFile: path.join(root, "session.jsonl"),
      },
      {
        input: new PassThrough(),
        output: new PassThrough(),
        errorOutput: new PassThrough(),
        executionPath: path.join(
          rootDir,
          "tests",
          "support",
          "session-worker-execution-fixture.mjs",
        ),
        signal: shutdown.signal,
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("crash-equivalent interruption starts Pi continuation before calling AgentSession.abort", async () => {
  const calls: string[] = [];
  let finishContinuation!: () => void;
  const continuationFinished = new Promise<void>((resolve) => {
    finishContinuation = resolve;
  });
  const persisted: any[] = [];
  const session: any = {
    agent: {
      signal: undefined,
      state: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "blocking-tool-call",
                name: "blocking_tool",
                arguments: {},
              },
            ],
          },
        ],
      },
    },
    sessionManager: {
      getEntries: () => persisted,
      appendMessage(message) {
        persisted.push({ type: "message", message });
      },
    },
    _runAgentPrompt(messages) {
      calls.push(`continue:${messages.length}`);
      assert.equal(
        this.agent.state.messages.at(-1)?.role,
        "toolResult",
        "the crash-equivalent interrupted tool result must precede continuation",
      );
      this.agent.signal = new AbortController().signal;
      return continuationFinished;
    },
    async abort() {
      calls.push("native-abort");
      assert.ok(
        this.agent.signal,
        "Pi continuation must be active before abort",
      );
      finishContinuation();
      this.agent.signal = undefined;
    },
  };

  await rpcModeModule.abortInterruptedTurnAfterExecutionLoss(session);

  assert.deepEqual(calls, ["continue:0", "native-abort"]);
  assert.equal(session.agent.state.messages.at(-1)?.role, "toolResult");
  assert.equal(persisted.at(-1)?.message?.role, "toolResult");
});
