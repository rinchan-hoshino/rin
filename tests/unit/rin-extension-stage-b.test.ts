import test from "node:test";
import assert from "node:assert/strict";
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
const daemonExtensions = await import(
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

function findExtensionTool(loader: DefaultResourceLoader, name: string) {
  for (const extension of loader.getExtensions().extensions as any[]) {
    const tool = extension.tools.get(name);
    if (tool) return tool.definition;
  }
  return undefined;
}

test("stage B browser and computer use extensions stay disabled by default", async () => {
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

test("built-in todo loads from configured runtime without extension paths", async () => {
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

      const added = await todoTool.execute(
        "tool-call-1",
        { action: "add", text: "Wire todo extension" },
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

      assert.match(added.content[0].text, /Added todo #1/);
      assert.match(toggled.content[0].text, /completed/);
      assert.deepEqual(toggled.details.todos, [
        { id: 1, text: "Wire todo extension", done: true },
      ]);
    } finally {
      await configured.runtime?.dispose?.().catch?.(() => {});
    }
  } finally {
    process.chdir(originalCwd);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("built-in todo honors no-extensions and native filters", async () => {
  const originalCwd = process.cwd();
  for (const scenario of [
    { settings: {}, options: { noExtensions: true } },
    { settings: { extensions: ["!rin:todo"] }, options: {} },
  ]) {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rin-builtin-todo-off-"),
    );
    try {
      await writeJson(path.join(agentDir, "settings.json"), scenario.settings);
      const configured = await runtime.createConfiguredAgentSession({
        cwd: agentDir,
        agentDir,
        ...scenario.options,
      });
      try {
        assert.equal(configured.session.getToolDefinition("todo"), undefined);
      } finally {
        await configured.runtime?.dispose?.().catch?.(() => {});
      }
    } finally {
      process.chdir(originalCwd);
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }
});

test("stage B browser and computer use load as external Pi extensions and honor native filters", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-stage-b-"));
  try {
    await writeJson(path.join(agentDir, "settings.json"), {
      extensions: ["rin:browser-use", "rin:computer-use", "!rin:browser-use"],
    });
    const loader = await createExtensionLoader(agentDir);
    const toolNames = extensionToolNames(loader);

    assert.equal(toolNames.includes("browser_use"), false);
    assert.equal(toolNames.includes("computer_use"), true);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("stage B external browser and computer use tools execute through adapters", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-stage-b-"));
  const browserAdapterPath = path.join(agentDir, "agent-browser-adapter.js");
  const computerAdapterPath = path.join(agentDir, "computer-adapter.js");
  const previousRinDir = process.env.RIN_DIR;
  try {
    await fs.writeFile(
      browserAdapterPath,
      `process.stdout.write(JSON.stringify({ agentBrowser: true, args: process.argv.slice(2) }));\n`,
      "utf8",
    );
    await fs.writeFile(
      computerAdapterPath,
      `process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(input || "{}");
  process.stdout.write(JSON.stringify({ ok: true, action: payload.action }));
});
`,
      "utf8",
    );
    await writeJson(path.join(agentDir, "settings.json"), {
      extensions: ["rin:browser-use", "rin:computer-use"],
    });
    await writeJson(path.join(agentDir, "extensions", "rin-browser-use.json"), {
      command: process.execPath,
      args: [browserAdapterPath],
    });
    await writeJson(
      path.join(agentDir, "extensions", "rin-computer-use.json"),
      {
        adapter: {
          command: process.execPath,
          args: [computerAdapterPath],
        },
      },
    );
    process.env.RIN_DIR = agentDir;
    const loader = await createExtensionLoader(agentDir);
    const browserTool = findExtensionTool(loader, "browser_use");
    const computerTool = findExtensionTool(loader, "computer_use");
    assert.ok(browserTool);
    assert.ok(computerTool);

    const browserResult = await browserTool.execute(
      "tool-call-1",
      { action: "status" },
      undefined,
      undefined,
      { cwd: agentDir },
    );
    const computerResult = await computerTool.execute(
      "tool-call-2",
      { action: "key", key: "Return" },
      undefined,
      undefined,
      { cwd: agentDir },
    );

    assert.match(browserResult.content[0].text, /browser_use status/);
    assert.match(browserResult.content[0].text, /agentBrowser/);
    assert.match(browserResult.content[0].text, /cdp-url/);
    assert.match(computerResult.content[0].text, /computer_use key/);
    assert.match(computerResult.content[0].text, /ok/);
  } finally {
    restoreEnv("RIN_DIR", previousRinDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("stage B daemon extension manager contributes chat runtime adapters", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-chat-adapter-"),
  );
  const packageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-chat-adapter-pkg-"),
  );
  const markerPath = path.join(agentDir, "chat-adapter.log");
  try {
    await writeProviderPackage(
      packageDir,
      "rin-daemon-chat-adapter-test",
      `import fs from "node:fs";
const markerPath = ${JSON.stringify(markerPath)};
export function createDaemonWorker(ctx) {
  ctx.registerChatAdapter(({ app }) => ({
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
    const manager = new daemonExtensions.RinDaemonExtensionManager({
      cwd: agentDir,
      agentDir,
      logger: { warn: (message: string) => warnings.push(String(message)) },
    });
    const started = await manager.start();
    assert.deepEqual(started, [
      {
        name: "rin-daemon-chat-adapter-test",
        packageName: "rin-daemon-chat-adapter-test",
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

test("stage B daemon extension manager exposes memory provider API for non-local originals", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-memory-provider-"),
  );
  const packageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-memory-provider-pkg-"),
  );
  const markerPath = path.join(agentDir, "memory-provider.log");
  try {
    await writeProviderPackage(
      packageDir,
      "rin-daemon-memory-provider-test",
      `import fs from "node:fs";
export function createDaemonWorker(ctx) {
  ctx.registerMemoryProvider({
    async search(request) {
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
    async listRecent(request) {
      fs.appendFileSync(ctx.config.markerPath, "recent:" + request.limit + "\\n");
      return [{ id: "remote-recent-1", name: "Remote recent", summary: "Recent remote memory", reference: "mem://remote-recent-1" }];
    },
    async write(entry) {
      fs.appendFileSync(ctx.config.markerPath, "write:" + entry.role + ":" + entry.text + "\\n");
    },
  }, { key: "remote-memory", name: "Remote Memory" });
}
`,
    );
    await writeJson(path.join(agentDir, "settings.json"), {
      rinExtensions: {
        daemonWorkers: [
          {
            name: "memory-provider",
            packageName: "rin-daemon-memory-provider-test",
            version: `file:${packageDir}`,
            config: { markerPath },
          },
        ],
      },
    });

    const manager = new daemonExtensions.RinDaemonExtensionManager({
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

test("stage B daemon extension manager ignores direct extensions without daemon entry", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-ignore-"),
  );
  const packageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-nondaemon-extension-pkg-"),
  );
  try {
    await writeProviderPackage(
      packageDir,
      "rin-nondaemon-extension-test",
      `export default function activate() { throw new Error("should_not_run"); }\n`,
    );
    await writeJson(path.join(agentDir, "settings.json"), {
      extensions: [packageDir],
    });

    const warnings: string[] = [];
    const manager = new daemonExtensions.RinDaemonExtensionManager({
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

test("stage B daemon extension manager starts async workers and stops them", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-stage-b-"));
  const packageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-worker-pkg-"),
  );
  const markerPath = path.join(agentDir, "worker.log");
  try {
    await writeProviderPackage(
      packageDir,
      "rin-daemon-worker-test",
      `import fs from "node:fs";
export const rinDaemonExtension = {
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
};
`,
    );
    await writeJson(path.join(agentDir, "settings.json"), {
      rinExtensions: {
        daemonWorkers: [
          {
            name: "worker-a",
            packageName: "rin-daemon-worker-test",
            version: `file:${packageDir}`,
            config: { markerPath },
          },
        ],
      },
    });

    const manager = new daemonExtensions.RinDaemonExtensionManager({
      cwd: agentDir,
      agentDir,
      logger: { warn: () => {} },
    });
    const started = await manager.start();
    await manager.stop();

    assert.deepEqual(started, [
      { name: "worker-a", packageName: "rin-daemon-worker-test" },
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
