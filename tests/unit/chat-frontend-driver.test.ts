import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { ChatFrontendDriver } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "chat-frontend-driver.js"),
  ).href
);

function createDriver() {
  const driver = new ChatFrontendDriver();
  driver.connect = async () => {};
  driver.session = {
    isStreaming: false,
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/chat-driver.jsonl",
      sessionId: "session-driver",
    }),
    switchSession: async () => {},
    sessionManager: {
      getSessionFile: () => "/tmp/chat-driver.jsonl",
      getSessionId: () => "session-driver",
    },
  };
  return driver;
}

async function emitDriverEvent(driver: any, payload: any) {
  await driver.handleClientEvent({ type: "ui", payload });
}

async function emitRpcTurnComplete(
  driver: any,
  requestTag: string,
  finalText: string,
  sessionFile = "/tmp/chat-driver.jsonl",
) {
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText,
    result: {
      messages: finalText ? [{ type: "text", text: finalText }] : [],
    },
    sessionId: "session-driver",
    sessionFile,
  });
}

test("chat frontend driver does not leak growing final-answer prefixes as interim", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  driver.session.prompt = async (_text: string, options: any = {}) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    for (const text of ["I", "I will", "I will check", "I will check this"]) {
      await emitDriverEvent(driver, {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      });
    }
    await emitRpcTurnComplete(
      driver,
      options.requestTag,
      "I will check this; here are the results",
    );
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "I will check this; here are the results");
  assert.deepEqual(interimTexts, []);
});

test("chat frontend driver does not treat a preview as interim when a tool boundary follows", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  driver.session.prompt = async (_text: string, options: any = {}) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I will check this" }],
      },
    });
    await emitDriverEvent(driver, {
      type: "tool_execution_start",
      toolName: "read",
    });
    await emitRpcTurnComplete(driver, options.requestTag, "Final answer");
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(interimTexts, []);
});

test("chat frontend driver starts managed leaf sessions even after connect reports a default session", async () => {
  const driver = createDriver();
  const calls: string[] = [];
  let sessionFile = "/tmp/root-session.jsonl";
  driver.session.sessionManager.getSessionFile = () => sessionFile;
  driver.session.newSession = async (options: any = {}) => {
    calls.push(`newSession:${options.managedSessionLeaf}`);
    sessionFile = "/tmp/rin/sessions/managed/task/created.jsonl";
    return true;
  };
  driver.session.ensureSessionReady = async () => {
    calls.push("ensureSessionReady");
    return { sessionFile, sessionId: "session-driver" };
  };
  driver.session.prompt = async (_text: string, options: any = {}) => {
    calls.push("prompt");
    await emitRpcTurnComplete(driver, options.requestTag, "done", sessionFile);
  };

  const result = await driver.runTurn({
    text: "hello",
    managedSessionLeaf: "task",
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(calls, ["newSession:task", "ensureSessionReady", "prompt"]);
  assert.equal(
    result.sessionFile,
    "/tmp/rin/sessions/managed/task/created.jsonl",
  );
});

test("chat frontend driver emits a completed assistant segment as interim before a later distinct final", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  driver.session.prompt = async (_text: string, options: any = {}) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I will check this" }],
      },
    });
    await emitRpcTurnComplete(driver, options.requestTag, "Final answer");
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(interimTexts, ["I will check this"]);
});
