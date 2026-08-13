import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const helpers = await import(
  pathToFileURL(path.resolve("dist/core/rin-daemon/worker-helpers.js")).href
);
const commandPresentation = await import(
  pathToFileURL(
    path.resolve("dist/core/rin-frontend-sdk/command-result-presentation.js"),
  ).href
);
function present(result: unknown) {
  return commandPresentation.presentBuiltinCommandResult(result);
}

function createRuntime(agentDir: string) {
  const calls: unknown[][] = [];
  const models = [
    { provider: "owner", id: "small" },
    { provider: "owner", id: "large" },
  ];
  const session = {
    model: models[0],
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    sessionFile: "/tmp/owner-session.jsonl",
    sessionId: "owner-session",
    sessionName: "Owner",
    autoCompactionEnabled: true,
    messages: [{ role: "user" }],
    pendingMessageCount: 2,
    sessionManager: {
      getCwd: () => "/tmp/owner-project",
      getSessionDir: () => path.join(agentDir, "sessions"),
    },
    modelRegistry: { getAvailable: async () => models },
    abortCompaction: () => calls.push(["abort-compaction"]),
    abort: async () => calls.push(["abort"]),
    compact: async (value?: string) => calls.push(["compact", value]),
    reload: async () => calls.push(["reload"]),
    setModel: async (value: unknown) => calls.push(["model", value]),
    setThinkingLevel: async (value: string) => calls.push(["thinking", value]),
    getSessionStats: () => ({
      sessionId: "owner-session",
      sessionFile: "",
      totalMessages: 4,
      userMessages: 2,
      assistantMessages: 1,
      toolResults: 1,
      toolCalls: 3,
    }),
  };
  return {
    calls,
    session,
    runtime: {
      session,
      services: { agentDir },
      newSession: async () => calls.push(["new"]),
      switchSession: async (value: string) => calls.push(["resume", value]),
    },
  };
}

test("worker helpers own RPC-safe state, diagnostics, completion, and built-in command behavior", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-worker-helpers-owner-"),
  );
  try {
    const { runtime, session, calls } = createRuntime(root);

    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((value: string | Uint8Array) => {
      writes.push(String(value));
      return true;
    }) as typeof process.stdout.write;
    try {
      helpers.writeJsonLine({ owner: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.deepEqual(writes, ['{"owner":true}\n']);

    assert.deepEqual(helpers.getSessionState(session, { turnActive: true }), {
      model: session.model,
      thinkingLevel: "medium",
      turnActive: true,
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile: "/tmp/owner-session.jsonl",
      sessionId: "owner-session",
      sessionName: "Owner",
      autoCompactionEnabled: true,
      messageCount: 1,
      pendingMessageCount: 2,
    });

    assert.deepEqual(helpers.getResourceDiagnostics({}), {
      skills: { skills: [], diagnostics: [] },
      prompts: { prompts: [], diagnostics: [] },
      themes: { themes: [], diagnostics: [] },
      extensions: {
        extensions: [],
        errors: [],
        diagnostics: [],
        commandDiagnostics: [],
        shortcutDiagnostics: [],
      },
    });

    const diagnostics = helpers.getResourceDiagnostics({
      resourceLoader: {
        getSkills: () => ({
          skills: [
            null,
            {
              name: "owner-skill",
              description: "Owner skill",
              filePath: "/skills/owner/SKILL.md",
              baseDir: "/skills/owner",
              disableModelInvocation: 1,
              sourceInfo: {
                path: "/skills/owner/SKILL.md",
                source: "owner",
                scope: "user",
                origin: "local",
                baseDir: "/skills",
                packageName: "owner-package",
                packageRoot: "/package",
                sourcePath: "/source",
                ignored: "secret",
              },
            },
          ],
          diagnostics: [
            null,
            {
              type: "error",
              message: "owner collision",
              path: "/skills/owner/SKILL.md",
              collision: {
                name: "owner-skill",
                winnerPath: "/winner",
                loserPath: "/loser",
              },
            },
            { collision: {} },
          ],
        }),
        getPrompts: () => ({
          prompts: [
            null,
            {
              name: "owner-prompt",
              description: "Prompt",
              filePath: "/prompts/owner.md",
              sourceInfo: {},
            },
          ],
          diagnostics: [{ message: "prompt warning" }],
        }),
        getThemes: () => ({
          themes: [
            {
              name: "owner-theme",
              sourcePath: "/themes/owner.json",
              sourceInfo: { source: "owner" },
            },
            null,
          ],
          diagnostics: [],
        }),
        getExtensions: () => ({
          extensions: [
            null,
            { path: "/extensions/owner.ts", sourceInfo: { origin: "owner" } },
          ],
          errors: [
            null,
            { path: "/extensions/broken.ts", message: "broken extension" },
            { error: "explicit extension error" },
          ],
        }),
      },
      extensionRunner: {
        getRegisteredCommands: () => [
          {
            name: "reload",
            invocationName: "reload",
            sourceInfo: { path: "/extensions/a.ts" },
          },
          {
            name: "resume",
            invocationName: "owner:resume",
            sourceInfo: { path: "/extensions/b.ts" },
          },
          { name: "owner-only", invocationName: "owner-only" },
        ],
        getCommandDiagnostics: () => [
          { type: "warning", message: "command warning" },
        ],
        getShortcutDiagnostics: () => ["shortcut warning"],
      },
    });
    assert.deepEqual(diagnostics.skills.skills[0], {
      name: "",
      description: "",
      filePath: "",
      baseDir: "",
      disableModelInvocation: false,
      sourceInfo: undefined,
    });
    assert.equal(diagnostics.skills.skills[1].sourceInfo.ignored, undefined);
    assert.deepEqual(diagnostics.skills.diagnostics[0], {
      type: "warning",
      message: "",
    });
    assert.deepEqual(diagnostics.skills.diagnostics[1].collision, {
      name: "owner-skill",
      winnerPath: "/winner",
      loserPath: "/loser",
    });
    assert.deepEqual(diagnostics.skills.diagnostics[2].collision, {
      name: "",
      winnerPath: "",
      loserPath: "",
    });
    assert.equal(diagnostics.prompts.prompts[0].name, "");
    assert.equal(diagnostics.prompts.prompts[1].sourceInfo, undefined);
    assert.equal(diagnostics.themes.themes[1].name, undefined);
    assert.equal(diagnostics.extensions.extensions[0].path, "");
    assert.equal(diagnostics.extensions.errors[1].error, "broken extension");
    assert.equal(
      diagnostics.extensions.errors[2].error,
      "explicit extension error",
    );
    assert.match(
      diagnostics.extensions.diagnostics[1].message,
      /Skipping in autocomplete/,
    );
    assert.match(diagnostics.extensions.diagnostics[2].message, /owner:resume/);

    assert.deepEqual(
      await helpers.getCommandArgumentCompletions({}, "missing", "x"),
      { items: [] },
    );
    const completions = await helpers.getCommandArgumentCompletions(
      {
        extensionRunner: {
          getCommand: () => ({
            getArgumentCompletions: async (prefix: string) => {
              assert.equal(prefix, "");
              return [
                "alpha",
                { label: "Beta", description: "second" },
                { id: "gamma" },
                null,
              ];
            },
          }),
        },
      },
      "owner",
      "",
    );
    assert.deepEqual(completions.items, [
      { id: "alpha", value: "alpha", label: "alpha" },
      { id: "Beta", value: "Beta", label: "Beta", description: "second" },
      { id: "gamma", value: "gamma", label: "gamma" },
      { id: "3", value: "", label: "" },
    ]);

    assert.deepEqual(
      helpers.splitCommandArgs(
        "  model 'owner/small' \"high detail\" empty\tend ",
      ),
      ["model", "owner/small", "high detail", "empty", "end"],
    );
    assert.deepEqual(helpers.splitCommandArgs('"" \'open'), ["", "open"]);
    assert.match(
      commandPresentation.formatSessionStats(session.getSessionStats()),
      /Session File: In-memory/,
    );
    const emptyStats = commandPresentation.formatSessionStats({});
    assert.match(emptyStats, /Tool Calls: 0/);
    assert.doesNotMatch(emptyStats, /Tokens:|Cost:/);

    assert.deepEqual(
      await helpers.runBuiltinCommand(runtime, "hello", { SessionManager: {} }),
      {
        handled: false,
      },
    );
    assert.deepEqual(
      await helpers.runBuiltinCommand(runtime, "/", { SessionManager: {} }),
      {
        handled: false,
      },
    );
    assert.equal(
      (
        await helpers.runBuiltinCommand(runtime, "/abort", {
          SessionManager: {},
        })
      ).handled,
      true,
    );
    assert.equal(
      (await helpers.runBuiltinCommand(runtime, "/new", { SessionManager: {} }))
        .handled,
      true,
    );
    assert.equal(
      (
        await helpers.runBuiltinCommand(runtime, "/compact", {
          SessionManager: {},
        })
      ).handled,
      true,
    );
    await helpers.runBuiltinCommand(runtime, "/compact focus owner", {
      SessionManager: {},
    });
    const reloadPromptContext = {
      source: "chat-bridge",
      chatKey: "discord/owner:room",
      chatName: "Owner room",
    };
    await helpers.runBuiltinCommand(runtime, "/reload", {
      SessionManager: {},
      promptContext: reloadPromptContext,
    });
    assert.deepEqual(
      runtime.session.sessionManager.__rinLastPromptContext,
      reloadPromptContext,
    );
    assert.match(
      String(
        present(
          await helpers.runBuiltinCommand(runtime, "/session", {
            SessionManager: {},
          }),
        ).text,
      ),
      /Tool Calls: 3/,
    );

    const listed = present(
      await helpers.runBuiltinCommand(runtime, "/resume", {
        listSessions: async () => [
          { id: "s1", name: "First", path: "/sessions/s1.jsonl" },
          { id: "s2", path: "/sessions/s2.jsonl" },
        ],
      }),
    );
    assert.match(String(listed.text), /s1 — First/);
    assert.match(String(listed.text), /s2 — s2/);
    assert.equal(
      present(
        await helpers.runBuiltinCommand(runtime, "/resume", {
          listSessions: async () => [],
        }),
      ).text,
      "No sessions available.",
    );
    await assert.rejects(
      () =>
        helpers.runBuiltinCommand(runtime, "/resume missing", {
          listSessions: async () => [{ id: "s1" }],
        }),
      /command_session_not_found:missing/,
    );
    assert.equal(
      present(
        await helpers.runBuiltinCommand(runtime, "/resume s1", {
          listSessions: async () => [{ id: "s1", path: "/sessions/s1.jsonl" }],
        }),
      ).text,
      "Resumed session: s1",
    );

    assert.match(
      String(
        present(
          await helpers.runBuiltinCommand(runtime, "/model", {
            SessionManager: {},
          }),
        ).text,
      ),
      /owner\/small/,
    );
    const oldModels = session.modelRegistry;
    session.modelRegistry = {
      getAvailable: async () => [null, { provider: "owner" }, { id: "small" }],
    };
    assert.equal(
      present(
        await helpers.runBuiltinCommand(runtime, "/model", {
          SessionManager: {},
        }),
      ).text,
      "No models available.",
    );
    session.modelRegistry = { getAvailable: async () => [] };
    assert.equal(
      present(
        await helpers.runBuiltinCommand(runtime, "/model", {
          SessionManager: {},
        }),
      ).text,
      "No models available.",
    );
    session.modelRegistry = oldModels;
    await assert.rejects(
      () =>
        helpers.runBuiltinCommand(runtime, "/model owner", {
          SessionManager: {},
        }),
      /command_model_usage/,
    );
    await assert.rejects(
      () =>
        helpers.runBuiltinCommand(runtime, "/model owner/missing", {
          SessionManager: {},
        }),
      /command_model_not_found/,
    );
    assert.match(
      String(
        present(
          await helpers.runBuiltinCommand(runtime, "/model owner/large high", {
            SessionManager: {},
          }),
        ).text,
      ),
      /owner\/large \(high\)/,
    );
    await helpers.runBuiltinCommand(runtime, "/model owner/small", {
      SessionManager: {},
    });

    const changelog = present(
      await helpers.runBuiltinCommand(runtime, "/changelog", {
        SessionManager: {},
      }),
    );
    assert.equal(changelog.handled, true);
    assert.equal(String(changelog.text).length > 0, true);
    assert.deepEqual(
      await helpers.runBuiltinCommand(runtime, "/usage", {
        SessionManager: {},
      }),
      { handled: false },
    );
    assert.deepEqual(
      await helpers.runBuiltinCommand(runtime, "/owner-unknown", {
        SessionManager: {},
      }),
      { handled: false },
    );

    assert.equal(
      calls.some(([name]) => name === "new"),
      true,
    );
    assert.equal(
      calls.some(([name, value]) => name === "compact" && value === undefined),
      true,
    );
    assert.equal(
      calls.some(
        ([name, value]) => name === "compact" && value === "focus owner",
      ),
      true,
    );
    assert.equal(
      calls.some(([name]) => name === "reload"),
      true,
    );
    assert.equal(
      calls.some(
        ([name, value]) => name === "resume" && value === "/sessions/s1.jsonl",
      ),
      true,
    );
    assert.equal(
      calls.some(([name]) => name === "thinking"),
      true,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
