import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const workerHelpers = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "worker-helpers.js"),
  ).href
);
function createAuthStorageFixture() {
  return {
    list: () => ["gemini"],
    get: () => ({ type: "api_key", key: "secret" }),
    getOAuthProviders: () => [
      { id: "gemini", name: "Gemini", usesCallbackServer: 0 },
    ],
  };
}

function createSessionFixture() {
  return {
    extensionRunner: {
      getRegisteredCommands: () => [
        {
          invocationName: "  resume  ",
          description: "  Resume a session.  ",
        },
        {
          name: "resume",
          description: "duplicate entry should be ignored",
        },
      ],
    },
    promptTemplates: [
      {
        name: "  polish  ",
        description: "  Rewrite the final reply.  ",
        sourceInfo: { file: "prompt-a" },
      },
    ],
    resourceLoader: {
      getSkills: () => ({
        skills: [
          {
            name: "  cleanup  ",
            description: "  Remove stale files.  ",
            sourceInfo: { file: "skill-a" },
          },
        ],
      }),
    },
    modelRegistry: {
      authStorage: createAuthStorageFixture(),
    },
  };
}

test("worker helpers split command args and format stats", () => {
  assert.deepEqual(
    workerHelpers.splitCommandArgs(`model openai/gpt-5 "high detail"`),
    ["model", "openai/gpt-5", "high detail"],
  );
  assert.deepEqual(
    workerHelpers.splitCommandArgs(`  resume   'session one'  ""  `),
    ["resume", "session one", ""],
  );
  const text = workerHelpers.formatSessionStats({
    sessionId: "s1",
    sessionFile: "",
    totalMessages: 3,
    userMessages: 1,
    assistantMessages: 1,
    toolResults: 1,
    toolCalls: 2,
  });
  assert.ok(text.includes("Session ID: s1"));
  assert.ok(text.includes("Tool Calls: 2"));
  assert.equal(text.includes("Tokens:"), false);
  assert.equal(text.includes("Cost:"), false);
});

test("worker helpers expose resource diagnostics from the active session", () => {
  const skillPath = "/tmp/rin-test/self_improve/skills/broken/SKILL.md";
  const diagnostics = workerHelpers.getResourceDiagnostics({
    resourceLoader: {
      getSkills: () => ({
        skills: [
          {
            name: "demo",
            description: "demo skill",
            filePath: skillPath,
            baseDir: "/tmp/rin-test/self_improve/skills/broken",
            sourceInfo: {
              path: skillPath,
              source: "local",
              scope: "user",
              origin: "top-level",
              baseDir: "/tmp/rin-test",
            },
          },
        ],
        diagnostics: [
          {
            type: "warning",
            message: "Nested mappings are not allowed",
            path: skillPath,
          },
        ],
      }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getExtensions: () => ({ extensions: [], errors: [] }),
    },
  });

  assert.deepEqual(diagnostics.skills.diagnostics, [
    {
      type: "warning",
      message: "Nested mappings are not allowed",
      path: skillPath,
    },
  ]);
  assert.deepEqual(diagnostics.skills.skills[0].sourceInfo, {
    path: skillPath,
    source: "local",
    scope: "user",
    origin: "top-level",
    baseDir: "/tmp/rin-test",
  });
});

test("worker helpers expose extension runner diagnostics", () => {
  const diagnostics = workerHelpers.getResourceDiagnostics({
    resourceLoader: {
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getExtensions: () => ({ extensions: [], errors: [] }),
    },
    extensionRunner: {
      getRegisteredCommands: () => [
        {
          name: "reload",
          invocationName: "extension:reload",
          sourceInfo: { path: "/tmp/ext.ts" },
        },
      ],
      getCommandDiagnostics: () => [
        { type: "warning", message: "duplicate command", path: "/tmp/ext.ts" },
      ],
      getShortcutDiagnostics: () => [
        { type: "warning", message: "duplicate shortcut", path: "/tmp/ext.ts" },
      ],
    },
  });

  assert.deepEqual(diagnostics.extensions.commandDiagnostics, [
    { type: "warning", message: "duplicate command", path: "/tmp/ext.ts" },
  ]);
  assert.deepEqual(diagnostics.extensions.shortcutDiagnostics, [
    { type: "warning", message: "duplicate shortcut", path: "/tmp/ext.ts" },
  ]);
  assert.deepEqual(diagnostics.extensions.diagnostics, [
    { type: "warning", message: "duplicate command", path: "/tmp/ext.ts" },
    {
      type: "warning",
      message:
        "Extension command '/reload' conflicts with built-in interactive command. Available as '/extension:reload'.",
      path: "/tmp/ext.ts",
    },
    { type: "warning", message: "duplicate shortcut", path: "/tmp/ext.ts" },
  ]);
});

test("worker helpers expose extension command argument completions", async () => {
  const completions = await workerHelpers.getCommandArgumentCompletions(
    {
      extensionRunner: {
        getCommand: (name) =>
          name === "deploy"
            ? {
                getArgumentCompletions: async (prefix) => [
                  { value: `${prefix}-prod`, label: "production" },
                ],
              }
            : undefined,
      },
    },
    "deploy",
    "app",
  );

  assert.deepEqual(completions, {
    items: [{ id: "app-prod", value: "app-prod", label: "production" }],
  });
});

test("worker helpers expose normalized slash commands and oauth state", async () => {
  const session = createSessionFixture();
  const commands = workerHelpers.getSlashCommands(session);

  assert.equal(
    commands.filter((command) => command.name === "resume").length,
    1,
  );
  assert.ok(
    commands.some(
      (command) =>
        command.name === "polish" &&
        command.description === "Rewrite the final reply." &&
        command.source === "prompt",
    ),
  );
  assert.ok(
    commands.some(
      (command) =>
        command.name === "skill:cleanup" &&
        command.description === "Remove stale files." &&
        command.source === "skill",
    ),
  );
  assert.equal(
    commands.some(
      (command) => command.name === "todos" && command.source === "builtin",
    ),
    false,
  );
  assert.equal(
    commands.some(
      (command) => command.name === "usage" && command.source === "builtin",
    ),
    false,
  );
  assert.equal(
    commands.some((command) => command.name === "model"),
    true,
  );
  assert.deepEqual(await workerHelpers.getOAuthState(session), {
    credentials: {
      gemini: { type: "api_key" },
    },
    providers: [
      {
        id: "gemini",
        name: "Gemini",
        usesCallbackServer: false,
      },
    ],
  });
});

test("getSessionState leaves platform Working judgment to the daemon", () => {
  const state = workerHelpers.getSessionState(
    {
      model: null,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile: "/tmp/demo.jsonl",
      sessionId: "session-1",
      sessionName: "demo",
      autoCompactionEnabled: true,
      messages: [],
      pendingMessageCount: 0,
    },
    { turnActive: true },
  );

  assert.equal(state.turnActive, true);
  assert.equal(state.isStreaming, false);
  assert.equal("working" in state, false);
});

test("runBuiltinCommand lists available sessions and reports missing session ids", async () => {
  const runtime = {
    session: {
      sessionManager: {
        getCwd: () => "/tmp/project",
        getSessionDir: () => "/tmp/sessions",
      },
    },
  };

  const listed = await workerHelpers.runBuiltinCommand(runtime, "/resume", {
    listSessions: async () => [{ id: "abc", path: "/tmp/sessions/abc.jsonl" }],
  });
  assert.equal(listed.handled, true);
  assert.match(String(listed.text || ""), /Available sessions:/);
  assert.match(String(listed.text || ""), /abc — abc/);

  const empty = await workerHelpers.runBuiltinCommand(runtime, "/resume", {
    listSessions: async () => [],
  });
  assert.equal(empty.text, "No sessions available.");

  await assert.rejects(
    () =>
      workerHelpers.runBuiltinCommand(runtime, "/resume missing", {
        listSessions: async () => [
          { id: "abc", path: "/tmp/sessions/abc.jsonl" },
        ],
      }),
    /session not found: missing/,
  );
});

test("runBuiltinCommand lists available models before selection", async () => {
  const runtime = {
    session: {
      modelRegistry: {
        getAvailable: async () => [
          { provider: "openai", id: "gpt-5" },
          { provider: "anthropic", id: "claude-sonnet" },
        ],
      },
    },
  };

  const listed = await workerHelpers.runBuiltinCommand(runtime, "/model", {
    SessionManager: { list: async () => [] },
  });
  assert.equal(listed.handled, true);
  assert.match(String(listed.text || ""), /Available models:/);
  assert.match(String(listed.text || ""), /openai\/gpt-5/);
  assert.match(String(listed.text || ""), /anthropic\/claude-sonnet/);

  runtime.session.modelRegistry.getAvailable = async () => [];
  const empty = await workerHelpers.runBuiltinCommand(runtime, "/model", {
    SessionManager: { list: async () => [] },
  });
  assert.equal(empty.text, "No models available.");
});

test("runBuiltinCommand reports command errors by throwing", async () => {
  const removedUsage = await workerHelpers.runBuiltinCommand(
    { session: {} },
    "/usage",
    { SessionManager: { list: async () => [] } },
  );
  assert.equal(removedUsage.handled, false);

  const runtime = {
    session: {
      modelRegistry: {
        getAvailable: async () => [{ provider: "openai", id: "gpt-5" }],
      },
    },
  };
  await assert.rejects(
    () =>
      workerHelpers.runBuiltinCommand(runtime, "/model openai/missing", {
        SessionManager: { list: async () => [] },
      }),
    /model not found: openai\/missing/,
  );
  await assert.rejects(
    () =>
      workerHelpers.runBuiltinCommand(runtime, "/model missing", {
        SessionManager: { list: async () => [] },
      }),
    /usage: \/model <provider\/model> \[thinking-level\]/,
  );
});

test("runBuiltinCommand no longer handles the removed todos slash command", async () => {
  const result = await workerHelpers.runBuiltinCommand(
    { session: {} },
    "/todos",
    { SessionManager: { list: async () => [] } },
  );

  assert.deepEqual(result, { handled: false });
});

test("runBuiltinCommand uses runtime for session replacement commands", async () => {
  const calls = [];
  const runtime = {
    session: {
      isStreaming: true,
      abort: async () => {
        calls.push(["abort"]);
      },
      compact: async () => {
        calls.push(["compact"]);
      },
      reload: async () => {
        calls.push(["reload"]);
      },
      getSessionStats: () => ({ sessionId: "s" }),
      sessionManager: {
        getCwd: () => "/tmp/project",
        getSessionDir: () => "/tmp/sessions",
      },
      modelRegistry: {
        getAvailable: async () => [
          { provider: "openai", id: "gpt-5" },
          { provider: "anthropic", id: "claude-sonnet" },
        ],
      },
      setModel: async (model) => {
        calls.push(["setModel", `${model.provider}/${model.id}`]);
      },
      setThinkingLevel: async (level) => {
        calls.push(["setThinkingLevel", level]);
      },
    },
    newSession: async () => {
      calls.push(["newSession"]);
      return { cancelled: false };
    },
    switchSession: async (sessionPath) => {
      calls.push(["switchSession", sessionPath]);
      return { cancelled: false };
    },
  };

  const resultAbort = await workerHelpers.runBuiltinCommand(runtime, "/abort", {
    SessionManager: { list: async () => [] },
  });
  assert.equal(resultAbort.handled, true);

  const resultNew = await workerHelpers.runBuiltinCommand(runtime, "/new", {
    SessionManager: { list: async () => [] },
  });
  assert.equal(resultNew.handled, true);

  const resultResume = await workerHelpers.runBuiltinCommand(
    runtime,
    "/resume abc",
    {
      listSessions: async () => [
        { id: "abc", path: "/tmp/sessions/abc.jsonl" },
      ],
    },
  );
  assert.equal(resultResume.handled, true);
  assert.match(String(resultResume.text || ""), /Resumed session: abc/);

  const resultListModels = await workerHelpers.runBuiltinCommand(
    runtime,
    "/model",
    { SessionManager: { list: async () => [] } },
  );
  assert.match(String(resultListModels.text || ""), /Available models:/);
  assert.match(String(resultListModels.text || ""), /openai\/gpt-5/);

  const resultSetModel = await workerHelpers.runBuiltinCommand(
    runtime,
    "/model openai/gpt-5 high",
    { SessionManager: { list: async () => [] } },
  );
  assert.match(
    String(resultSetModel.text || ""),
    /Model set to: openai\/gpt-5 \(high\)/,
  );

  await assert.rejects(
    () =>
      workerHelpers.runBuiltinCommand(runtime, "/model missing", {
        SessionManager: { list: async () => [] },
      }),
    /usage: \/model/,
  );

  assert.deepEqual(calls, [
    ["abort"],
    ["abort"],
    ["newSession"],
    ["switchSession", "/tmp/sessions/abc.jsonl"],
    ["setModel", "openai/gpt-5"],
    ["setThinkingLevel", "high"],
  ]);
});
