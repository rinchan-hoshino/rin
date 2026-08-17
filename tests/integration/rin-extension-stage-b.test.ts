import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const runtime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);
const capabilitySession = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "capability-session.js"),
  ).href
);
const todoModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "todo.js")).href
);
const tuiRenderers = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "tool-renderers", "index.js"),
  ).href
);

function createCapabilities(agentDir: string) {
  return capabilitySession.createRinCapabilitySet({
    cwd: agentDir,
    agentDir,
    definitions: runtime.createRinCapabilityDefinitions({
      cwd: agentDir,
      agentDir,
      getThinkingLevel: () => "medium",
      sendMessage: () => {},
    }),
  });
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeProviderPackage(
  dir: string,
  packageName: string,
  source: string,
  packageJson: Record<string, unknown> = {},
) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: "0.0.0",
        type: "module",
        main: "index.js",
        ...packageJson,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(dir, "index.js"), source, "utf8");
}

async function createExtensionLoader(agentDir: string) {
  const settingsManager = SettingsManager.create(agentDir, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager,
  });
  await loader.reload();
  return loader;
}

function extensionToolNames(loader: DefaultResourceLoader) {
  return loader
    .getExtensions()
    .extensions.flatMap((extension: any) =>
      Array.from(extension.tools.values()).map(
        (tool: any) => tool.definition.name,
      ),
    );
}

test("removed browser and computer use tools stay absent by default", async () => {
  for (const settings of [{}, { extensions: [] }]) {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-stage-b-"));
    try {
      await writeJson(path.join(agentDir, "settings.json"), settings);
      const capabilities = createCapabilities(agentDir);
      const toolNames = capabilities
        .getToolDefinitions()
        .map((tool: any) => tool.name);
      const loader = await createExtensionLoader(agentDir);

      assert.equal(toolNames.includes("browser_use"), false);
      assert.equal(toolNames.includes("computer_use"), false);
      assert.equal(extensionToolNames(loader).includes("browser_use"), false);
      assert.equal(extensionToolNames(loader).includes("computer_use"), false);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }
});

test("core todo loads from configured runtime without extension paths", async () => {
  const originalCwd = process.cwd();
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-builtin-todo-"),
  );
  try {
    await writeJson(path.join(agentDir, "settings.json"), {});
    const configured = await runtime.createConfiguredAgentSession({
      cwd: agentDir,
      agentDir,
    });
    try {
      const todoTool = configured.session.getToolDefinition("todo");
      assert.ok(todoTool);
      const commandNames = configured.session.extensionRunner
        .getRegisteredCommands()
        .map((command: any) => command.invocationName);
      assert.equal(commandNames.includes("todos"), false);
      assert.equal(commandNames.includes("notes"), false);
      assert.equal(typeof todoTool.execute, "function");
      assert.equal(todoTool.renderCall, undefined);
      assert.equal(todoTool.renderResult, undefined);
      const todoRenderer = tuiRenderers.getCoreToolRenderer("todo");
      assert.equal(typeof todoRenderer.renderCall, "function");
      assert.equal(typeof todoRenderer.renderResult, "function");
      assert.match(
        todoTool.parameters.properties.id.description,
        /Current 1-based item number/,
      );
      assert.equal(
        todoTool.promptSnippet,
        "Current-branch execution checklist.",
      );
      assert.deepEqual(todoTool.promptGuidelines, [
        "Use todo when current-branch work has multiple concrete execution steps that benefit from a visible checklist.",
      ]);

      const added = await todoTool.execute(
        "tool-call-1",
        {
          action: "add",
          items: [{ text: "Wire core todo" }, { text: "Ship item writer" }],
        },
        undefined,
        undefined,
        { cwd: agentDir },
      );
      const edited = await todoTool.execute(
        "tool-call-2",
        { action: "toggle", ids: [1] },
        undefined,
        undefined,
        { cwd: agentDir },
      );
      const read = await todoTool.execute(
        "tool-call-3",
        { action: "read" },
        undefined,
        undefined,
        { cwd: agentDir },
      );
      const cleared = await todoTool.execute(
        "tool-call-4",
        { action: "clear" },
        undefined,
        undefined,
        { cwd: agentDir },
      );

      assert.equal(
        added.content[0].text,
        "[ ] #1 Wire core todo\n[ ] #2 Ship item writer",
      );
      assert.equal(
        edited.content[0].text,
        "[x] #1 Wire core todo\n[ ] #2 Ship item writer",
      );
      assert.deepEqual(edited.details.items, [
        { id: 1, text: "Wire core todo", done: true },
        { id: 2, text: "Ship item writer", done: false },
      ]);
      assert.equal(read.details.action, "read");
      assert.deepEqual(read.details.items, edited.details.items);
      assert.equal(cleared.details.action, "clear");
      assert.equal(cleared.content[0].text, "");
      assert.deepEqual(cleared.details.items, []);
    } finally {
      await configured.runtime?.dispose?.().catch?.(() => {});
    }
  } finally {
    process.chdir(originalCwd);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("core todo reconstructs from custom entries around interrupted tool results", async () => {
  const capability = todoModule.default();
  const todoTool = capability.tools[0];
  const interruptedTodoResult = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todo",
      details: {
        interrupted: true,
        reason: "daemon_exit",
      },
      content: [
        {
          type: "text",
          text: "The tool was interrupted because the daemon exited.",
        },
      ],
    },
  };

  await capability.hooks?.session_start?.[0]?.({}, {
    sessionManager: {
      getBranch: () => [
        interruptedTodoResult,
        {
          type: "custom",
          customType: "rin.todo",
          data: {
            todos: [{ id: 1, text: "Preserve todo state", done: false }],
            nextId: 2,
          },
        },
        interruptedTodoResult,
      ],
    },
  } as any);

  const invalidAdd = await todoTool.execute(
    "tool-call-invalid-add",
    { action: "add", items: [{ text: "" }] },
    undefined,
    undefined,
    {},
  );

  assert.match(invalidAdd.content[0].text, /Error:/);
  assert.deepEqual(invalidAdd.details.items, [
    { id: 1, text: "Preserve todo state", done: false },
  ]);
});

test("core todo remains enabled when optional extensions are disabled", async () => {
  const originalCwd = process.cwd();
  for (const scenario of [
    { settings: {}, options: { noExtensions: true } },
    { settings: { extensions: [] }, options: {} },
  ]) {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rin-builtin-todo-on-"),
    );
    try {
      await writeJson(path.join(agentDir, "settings.json"), scenario.settings);
      const configured = await runtime.createConfiguredAgentSession({
        cwd: agentDir,
        agentDir,
        ...scenario.options,
      });
      try {
        assert.ok(configured.session.getToolDefinition("todo"));
      } finally {
        await configured.runtime?.dispose?.().catch?.(() => {});
      }
    } finally {
      process.chdir(originalCwd);
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }
});

test("Rin core capabilities remain independent of the extension loader", async () => {
  const extensionsDir = path.join(rootDir, "extensions");
  const entries = await fs
    .readdir(extensionsDir, { withFileTypes: true })
    .catch((error: any) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entrypoint = path.join(extensionsDir, entry.name, "index.ts");
    const source = await fs.readFile(entrypoint, "utf8").catch(() => "");
    assert.equal(
      /from\s+["']\.\.\/\.\.\/(?:src|dist)\//.test(source),
      false,
      `${entry.name} must not import Rin core implementation from src/ or dist/`,
    );
  }
});
