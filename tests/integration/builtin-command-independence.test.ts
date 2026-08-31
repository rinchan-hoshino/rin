import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const rootDir = process.cwd();
const catalog = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "catalog-helpers.js"),
  ).href
);
const dispatcher = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-frontend-sdk",
      "command-dispatcher.js",
    ),
  ).href
);
const worker = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "worker-helpers.js"),
  ).href
);
const commandPresentation = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-frontend-sdk",
      "command-result-presentation.js",
    ),
  ).href
);

test("builtin command discovery does not require an ExtensionRunner", () => {
  const commands = catalog.getSessionSlashCommands({
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
  });

  for (const name of ["help", "abort", "new", "compact", "model"]) {
    const command = commands.find((item) => item.name === name);
    assert.equal(command?.source, "builtin", name);
  }
  assert.equal(
    commands.some((command) => command.source === "extension"),
    false,
  );
});

test("builtin command execution does not call the extension API", async () => {
  const calls = [];
  const session = {
    abortCompaction() {
      calls.push("abortCompaction");
    },
    clearQueue() {
      calls.push("clearQueue");
      return { steering: [], followUp: [] };
    },
    async abort() {
      calls.push("abort");
    },
    async compact(instructions) {
      calls.push(`compact:${instructions}`);
    },
    async reload() {
      calls.push("reload");
    },
    getSessionStats() {
      return { sessionId: "session-1", totalMessages: 0 };
    },
  };
  const runtime = {
    session,
    async newSession() {
      calls.push("newSession");
    },
  };

  assert.equal(
    (await worker.runBuiltinCommand(runtime, "/abort", {})).handled,
    true,
  );
  assert.equal(
    (await worker.runBuiltinCommand(runtime, "/new", {})).handled,
    true,
  );
  assert.equal(
    (await worker.runBuiltinCommand(runtime, "/compact keep names", {}))
      .handled,
    true,
  );
  assert.equal(
    (await worker.runBuiltinCommand(runtime, "/reload", {})).handled,
    true,
  );
  const sessionResult = commandPresentation.presentBuiltinCommandResult(
    await worker.runBuiltinCommand(runtime, "/session", {}),
  );
  assert.equal(sessionResult.handled, true);
  assert.match(sessionResult.text, /session-1/);
  assert.deepEqual(calls, [
    "abortCompaction",
    "clearQueue",
    "abort",
    "abortCompaction",
    "abort",
    "newSession",
    "compact:keep names",
    "reload",
  ]);
});

test("frontend builtin routing remains independent from extension catalog rows", () => {
  assert.deepEqual(dispatcher.classifyRinFrontendCommand("/new", []), {
    kind: "frontend",
    name: "new",
  });
  assert.deepEqual(dispatcher.classifyRinFrontendCommand("/usage", []), {
    kind: "none",
    name: "usage",
  });
  assert.deepEqual(dispatcher.classifyRinFrontendCommand("/custom", []), {
    kind: "none",
    name: "custom",
  });
});
