import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
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
const backgroundExtensions = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "extensions.js"),
  ).href
);
const chatRuntime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js"))
    .href
);
const bundledExtensions = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-bundled-extensions.js"))
    .href
);
const builtInExtensionControls = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-builtin-extension-controls.js"),
  ).href
);
const todoModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "todo.js")).href
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
  bundledExtensions.applyBundledRinExtensionAliases(settingsManager);
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
      assert.equal(
        todoTool.description,
        "Maintain the current branch execution checklist: planned, active, and completed work.",
      );
      assert.match(
        todoTool.promptSnippet,
        /Maintain the current branch checklist/,
      );
      assert.deepEqual(todoTool.promptGuidelines, [
        "Use todo for current-branch work with multiple concrete execution steps that benefit from a visible checklist.",
      ]);

      const added = await todoTool.execute(
        "tool-call-1",
        { action: "add", text: "Wire core todo" },
        undefined,
        undefined,
        { cwd: agentDir },
      );
      const toggled = await todoTool.execute(
        "tool-call-2",
        { action: "toggle", id: 1 },
        undefined,
        undefined,
        { cwd: agentDir },
      );
      const toggledFromStringId = await todoTool.execute(
        "tool-call-3",
        { action: "toggle", id: "1" },
        undefined,
        undefined,
        { cwd: agentDir },
      );
      const listed = await todoTool.execute(
        "tool-call-4",
        { action: "list" },
        undefined,
        undefined,
        { cwd: agentDir },
      );
      const cleared = await todoTool.execute(
        "tool-call-5",
        { action: "clear" },
        undefined,
        undefined,
        { cwd: agentDir },
      );

      assert.equal(added.content[0].text, "○ Wire core todo");
      assert.equal(toggled.content[0].text, "✓ Wire core todo");
      assert.deepEqual(toggled.details.todos, [
        { id: 1, text: "Wire core todo", done: true },
      ]);
      assert.equal(toggledFromStringId.content[0].text, "○ Wire core todo");
      assert.deepEqual(toggledFromStringId.details.todos, [
        { id: 1, text: "Wire core todo", done: false },
      ]);
      assert.equal(listed.content[0].text, "○ Wire core todo");
      assert.equal(cleared.content[0].text, "○ No todos");
    } finally {
      await configured.runtime?.dispose?.().catch?.(() => {});
    }
  } finally {
    process.chdir(originalCwd);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("core todo reconstructs around interrupted todo tool results", async () => {
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
          type: "message",
          message: {
            role: "toolResult",
            toolName: "todo",
            details: {
              action: "add",
              todos: [{ id: 1, text: "Preserve todo state", done: false }],
              nextId: 2,
            },
          },
        },
        interruptedTodoResult,
      ],
    },
  } as any);

  const listed = await todoTool.execute(
    "tool-call-list",
    { action: "list" },
    undefined,
    undefined,
    {},
  );

  assert.equal(listed.content[0].text, "○ Preserve todo state");
});

test("core todo remains enabled when optional extensions are disabled", async () => {
  const originalCwd = process.cwd();
  for (const scenario of [
    { settings: {}, options: { noExtensions: true } },
    { settings: { extensions: ["!rin:web-search"] }, options: {} },
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

test("stage B built-in extension controls update web search settings alias", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-stage-b-"));
  try {
    await writeJson(path.join(agentDir, "settings.json"), {
      extensions: ["rin:web-search"],
    });
    const settingsManager = SettingsManager.create(agentDir, agentDir);

    assert.deepEqual(
      builtInExtensionControls
        .listBuiltInRinExtensionStates(settingsManager)
        .map((entry: any) => [entry.id, entry.enabled]),
      [["rin:web-search", true]],
    );

    await builtInExtensionControls.disableBuiltInRinExtension(
      settingsManager,
      "rin:web-search",
    );
    await settingsManager.flush();

    const saved = JSON.parse(
      await fs.readFile(path.join(agentDir, "settings.json"), "utf8"),
    );
    assert.deepEqual(saved.extensions ?? [], []);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

for (const removedAlias of ["rin:browser-use", "rin:computer-use"]) {
  test(`stage B removed built-in extension alias is not expanded: ${removedAlias}`, () => {
    assert.equal(
      bundledExtensions.resolveBundledRinExtensionPath(removedAlias),
      "",
    );
    assert.equal(
      bundledExtensions.expandBundledRinExtensionEntry(removedAlias),
      removedAlias,
    );
  });
}

test("stage B built-in extension entrypoints stay self-contained", async () => {
  const extensionsDir = path.join(rootDir, "extensions");
  const entries = await fs.readdir(extensionsDir, { withFileTypes: true });
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

test("stage B web search loads as an external built-in extension", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-web-search-ext-"),
  );
  try {
    await writeJson(path.join(agentDir, "settings.json"), {
      extensions: ["rin:web-search"],
    });
    const loader = await createExtensionLoader(agentDir);
    const toolNames = extensionToolNames(loader);

    assert.equal(toolNames.includes("web_search"), true);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("stage B background extension manager stays lightweight without configured background extensions", () => {
  const script = `
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RinBackgroundExtensionManager } from ${JSON.stringify(
    pathToFileURL(
      path.join(rootDir, "dist", "core", "rin-daemon", "extensions.js"),
    ).href,
  )};
function mb(value) { return value / 1024 / 1024; }
const tmp = mkdtempSync(path.join(os.tmpdir(), "rin-bg-ext-light-"));
const agentDir = path.join(tmp, "rin");
mkdirSync(agentDir, { recursive: true });
try {
  const manager = new RinBackgroundExtensionManager({
    cwd: tmp,
    agentDir,
    logger: { warn() {}, info() {}, error() {} },
  });
  const started = await manager.start();
  if (started.length !== 0) throw new Error("unexpected_background_extension_start");
  if (global.gc) global.gc();
  const rssMb = mb(process.memoryUsage().rss);
  console.log(JSON.stringify({ rssMb }));
  if (rssMb > 110) throw new Error("background_extension_start_loaded_heavy_runtime:" + rssMb.toFixed(1));
  await manager.stop();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
`;
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--input-type=module", "-e", script],
    { cwd: rootDir, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("stage B background extension manager contributes chat runtime adapters", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-chat-adapter-"),
  );
  const packageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-chat-adapter-pkg-"),
  );
  const markerPath = path.join(agentDir, "chat-adapter.log");
  try {
    await writeProviderPackage(
      packageDir,
      "rin-background-chat-adapter-test",
      `import fs from "node:fs";
const markerPath = ${JSON.stringify(markerPath)};
export default function extension(rin) {
  rin.registerChatAdapter(({ app }) => ({
      adapter: {
        async start() {
          fs.appendFileSync(markerPath, "chat-start\\n");
          app.emit("message", {
            platform: "extension-test",
            selfId: "bot-1",
            messageId: "msg-1",
            channelId: "room-1",
            userId: "owner-1",
            content: "hello from extension",
            elements: [{ type: "text", attrs: { content: "hello from extension" } }],
          });
        },
        async stop() {
          fs.appendFileSync(markerPath, "chat-stop\\n");
        },
      },
      bot: {
        platform: "extension-test",
        selfId: "bot-1",
        status: 1,
        async sendMessage(chatId, content) {
          fs.appendFileSync(markerPath, "send:" + chatId + ":" + String(content) + "\\n");
          return ["sent-1"];
        },
      },
    }), { key: "extension-test" });
}
`,
    );
    await writeJson(path.join(agentDir, "settings.json"), {
      extensions: [packageDir],
    });

    const warnings: string[] = [];
    const manager = new backgroundExtensions.RinBackgroundExtensionManager({
      cwd: agentDir,
      agentDir,
      logger: { warn: (message: string) => warnings.push(String(message)) },
    });
    const started = await manager.start();
    assert.deepEqual(started, [
      {
        name: "rin-background-chat-adapter-test",
        packageName: "rin-background-chat-adapter-test",
      },
    ]);
    assert.deepEqual(warnings, []);
    const app = chatRuntime.createChatRuntimeApp(agentDir);
    const messages: any[] = [];
    app.on("message", (session: any) => messages.push(session));
    const created = await chatRuntime.instantiateExternalChatRuntimeAdapters(
      app,
      {
        agentDir,
        dataDir: path.join(agentDir, "data"),
        runtimeRoot: path.join(agentDir, "data", "chat-runtime"),
        adapterEntries: manager.getChatAdapterProviders(),
        logger: { warn: () => {} },
      },
    );

    assert.deepEqual(created, [
      { key: "extension-test", name: "extension-test" },
    ]);
    assert.equal(app.bots[0]?.platform, "extension-test");
    await app.start();
    await app.stop();
    await manager.stop();

    assert.equal(messages[0]?.content, "hello from extension");
    assert.equal(
      await fs.readFile(markerPath, "utf8"),
      "chat-start\nchat-stop\n",
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(packageDir, { recursive: true, force: true });
  }
});

test("stage B background extension manager loads local pi packages from settings.packages", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-package-"),
  );
  const packageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-package-pkg-"),
  );
  const markerPath = path.join(agentDir, "package-adapter.log");
  try {
    await writeProviderPackage(
      packageDir,
      "rin-background-package-test",
      `throw new Error("package main should not be imported for pi manifest extensions");\n`,
      { pi: { extensions: ["bridge.js"] } },
    );
    await fs.writeFile(
      path.join(packageDir, "bridge.js"),
      `import fs from "node:fs";
const markerPath = ${JSON.stringify(markerPath)};
export default function extension(rin) {
  rin.registerChatAdapter(() => ({
    adapter: { async start() { fs.appendFileSync(markerPath, "package-start\\n"); }, async stop() {} },
    bot: { platform: "package-test", selfId: "bot-1", status: 1, async sendMessage() { return []; } },
  }), { key: "package-test" });
}
`,
      "utf8",
    );
    await writeJson(path.join(agentDir, "settings.json"), {
      packages: [packageDir],
    });

    const warnings: string[] = [];
    const manager = new backgroundExtensions.RinBackgroundExtensionManager({
      cwd: agentDir,
      agentDir,
      logger: { warn: (message: string) => warnings.push(String(message)) },
    });
    const started = await manager.start();

    assert.deepEqual(started, [
      {
        name: "rin-background-package-test",
        packageName: "rin-background-package-test",
      },
    ]);
    assert.deepEqual(warnings, []);
    assert.equal(manager.getChatAdapterProviders()[0]?.key, "package-test");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(packageDir, { recursive: true, force: true });
  }
});

test("stage B background extension manager honors pi package extension filters", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-package-filter-"),
  );
  const packageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-package-filter-pkg-"),
  );
  try {
    await writeProviderPackage(
      packageDir,
      "rin-background-package-filter-test",
      `export default function extension(rin) { rin.registerChatAdapter(() => ({ adapter: { start() {}, stop() {} }, bot: { platform: "filtered", selfId: "bot", status: 1, async sendMessage() { return []; } } }), { key: "filtered" }); }\n`,
      { pi: { extensions: ["index.js"] } },
    );
    await writeJson(path.join(agentDir, "settings.json"), {
      packages: [{ source: packageDir, extensions: [] }],
    });

    const manager = new backgroundExtensions.RinBackgroundExtensionManager({
      cwd: agentDir,
      agentDir,
      logger: { warn: () => {} },
    });

    assert.deepEqual(await manager.start(), []);
    assert.deepEqual(manager.getChatAdapterProviders(), []);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(packageDir, { recursive: true, force: true });
  }
});

test("stage B background extension manager loads auto-discovered pi extensions", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-auto-"),
  );
  try {
    const extensionDir = path.join(agentDir, "extensions", "auto-bg");
    await fs.mkdir(extensionDir, { recursive: true });
    await fs.writeFile(
      path.join(extensionDir, "index.js"),
      `export default function extension(rin) { rin.registerBackgroundService({ start() {} }); }\n`,
      "utf8",
    );

    const manager = new backgroundExtensions.RinBackgroundExtensionManager({
      cwd: agentDir,
      agentDir,
      logger: { warn: () => {} },
    });

    assert.deepEqual(await manager.start(), [
      {
        name: "index.js",
        packageName: path.join(extensionDir, "index.js"),
      },
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("stage B background extension manager exposes memory provider API for non-local originals", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-memory-provider-"),
  );
  const packageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-memory-provider-pkg-"),
  );
  const markerPath = path.join(agentDir, "memory-provider.log");
  try {
    await writeProviderPackage(
      packageDir,
      "rin-background-memory-provider-test",
      `import fs from "node:fs";
export default function extension(rin) {
  rin.registerMemoryProvider({
    async search(request, ctx) {
      fs.appendFileSync(ctx.config.markerPath, "search:" + request.query + ":" + request.limit + "\\n");
      return [{
        id: "remote-hit-1",
        name: "Remote memory hit",
        summary: "Remote summary from a memory system that owns original text elsewhere.",
        reference: "mem://remote-hit-1",
        score: 77,
        messages: [{ line: 1, role: "memory", timestamp: "2026-05-11T06:00:00.000Z", text: "remote snippet only" }],
      }];
    },
    async listRecent(request, ctx) {
      fs.appendFileSync(ctx.config.markerPath, "recent:" + request.limit + "\\n");
      return [{ id: "remote-recent-1", name: "Remote recent", summary: "Recent remote memory", reference: "mem://remote-recent-1" }];
    },
    async write(entry, ctx) {
      fs.appendFileSync(ctx.config.markerPath, "write:" + entry.role + ":" + entry.text + "\\n");
    },
  }, { key: "remote-memory", name: "Remote Memory" });
}
`,
    );
    await writeJson(path.join(agentDir, "settings.json"), {
      rinExtensions: {
        backgroundServices: [
          {
            name: "memory-provider",
            packageName: "rin-background-memory-provider-test",
            version: `file:${packageDir}`,
            config: { markerPath },
          },
        ],
      },
    });

    const manager = new backgroundExtensions.RinBackgroundExtensionManager({
      cwd: agentDir,
      agentDir,
      logger: { warn: () => {} },
    });
    await manager.start();

    const searchResults = await manager.searchMemoryProviders({
      query: "remote originals",
      limit: 3,
    });
    const recentResults = await manager.searchMemoryProviders({ limit: 2 });
    const writeResult = await manager.writeMemoryProviders({
      id: "entry-1",
      timestamp: "2026-05-11T06:00:00.000Z",
      sessionId: "session-remote",
      sessionFile: "/tmp/session-remote.jsonl",
      role: "assistant",
      text: "raw text delivered to the external provider",
    });
    await manager.stop();

    assert.deepEqual(searchResults, [
      {
        sourceType: "external",
        provider: "remote-memory",
        id: "remote-hit-1",
        name: "Remote memory hit",
        summary:
          "Remote summary from a memory system that owns original text elsewhere.",
        reference: "mem://remote-hit-1",
        score: 77,
        messages: [
          {
            line: 1,
            role: "memory",
            timestamp: "2026-05-11T06:00:00.000Z",
            text: "remote snippet only",
          },
        ],
      },
    ]);
    assert.equal(recentResults[0]?.reference, "mem://remote-recent-1");
    assert.deepEqual(writeResult, {
      written: 1,
      providerCount: 1,
    });
    assert.equal(
      await fs.readFile(markerPath, "utf8"),
      "search:remote originals:3\nrecent:2\nwrite:assistant:raw text delivered to the external provider\n",
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(packageDir, { recursive: true, force: true });
  }
});

test("stage B background extension manager ignores direct extensions without background parts", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-ignore-"),
  );
  const packageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-backgroundless-extension-pkg-"),
  );
  try {
    await writeProviderPackage(
      packageDir,
      "rin-backgroundless-extension-test",
      `export default function activate(rin) { rin.registerTool({ name: "noop" }); }\n`,
    );
    await writeJson(path.join(agentDir, "settings.json"), {
      extensions: [packageDir],
    });

    const warnings: string[] = [];
    const manager = new backgroundExtensions.RinBackgroundExtensionManager({
      cwd: agentDir,
      agentDir,
      logger: { warn: (message: string) => warnings.push(String(message)) },
    });

    assert.deepEqual(await manager.start(), []);
    assert.deepEqual(manager.getChatAdapterProviders(), []);
    assert.deepEqual(warnings, []);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(packageDir, { recursive: true, force: true });
  }
});

test("stage B background extension manager starts async services and stops them", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-stage-b-"));
  const packageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-background-service-pkg-"),
  );
  const markerPath = path.join(agentDir, "worker.log");
  try {
    await writeProviderPackage(
      packageDir,
      "rin-background-service-test",
      `import fs from "node:fs";
export default function extension(rin) {
  rin.registerBackgroundService({
    start(ctx) {
      fs.appendFileSync(ctx.config.markerPath, "start:" + ctx.name + "\\n");
      ctx.runAsync("tick", async () => {
        fs.appendFileSync(ctx.config.markerPath, "async\\n");
      });
      return {
        stop() {
          fs.appendFileSync(ctx.config.markerPath, "stop\\n");
        },
      };
    },
  });
}
`,
    );
    await writeJson(path.join(agentDir, "settings.json"), {
      rinExtensions: {
        backgroundServices: [
          {
            name: "worker-a",
            packageName: "rin-background-service-test",
            version: `file:${packageDir}`,
            config: { markerPath },
          },
        ],
      },
    });

    const manager = new backgroundExtensions.RinBackgroundExtensionManager({
      cwd: agentDir,
      agentDir,
      logger: { warn: () => {} },
    });
    const started = await manager.start();
    await manager.stop();

    assert.deepEqual(started, [
      { name: "worker-a", packageName: "rin-background-service-test" },
    ]);
    assert.equal(
      await fs.readFile(markerPath, "utf8"),
      "start:worker-a\nasync\nstop\n",
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(packageDir, { recursive: true, force: true });
  }
});
