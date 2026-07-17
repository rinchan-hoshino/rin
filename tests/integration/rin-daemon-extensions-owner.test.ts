import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

await import("../support/register-daemon-extensions-owner-fixture.ts");
const extensions = await import(
  pathToFileURL(path.resolve("dist/core/rin-daemon/extensions.js")).href
);
const ownerGlobal = globalThis as any;
const events = ownerGlobal.__rinExtensionsOwnerEvents as any[];
const scenario = ownerGlobal.__rinExtensionsOwnerScenario as Record<
  string,
  any
>;
const modules = ownerGlobal.__rinExtensionsOwnerModules as Record<string, any>;

function reset() {
  events.length = 0;
  for (const key of Object.keys(scenario)) delete scenario[key];
  for (const key of Object.keys(modules)) delete modules[key];
  scenario.settings = {};
  scenario.entries = [];
  scenario.piEntries = [];
}

function packageEntry(name: string, overrides: Record<string, any> = {}) {
  return {
    name,
    packageName: name,
    version: "1.0.0",
    config: { owner: name },
    optional: false,
    ...overrides,
  };
}

async function withSandbox(
  run: (value: {
    root: string;
    cwd: string;
    agentDir: string;
  }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-ext-owner-"));
  const cwd = path.join(root, "cwd");
  const agentDir = path.join(root, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  try {
    await run({ root, cwd, agentDir });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function manager(cwd: string, agentDir: string, warnings: string[]) {
  return new extensions.RinBackgroundExtensionManager({
    cwd,
    agentDir,
    logger: {
      info: (message: string) => events.push(["info", message]),
      warn: (message: string) => warnings.push(message),
      error: (message: string) => events.push(["error", message]),
    },
  });
}

test("background dependency ownership writes exact runtime package and installs only when stale", async () => {
  reset();
  await withSandbox(async ({ agentDir }) => {
    const emptyRoot = extensions.ensureBackgroundExtensionDependencies(
      agentDir,
      [packageEntry("local", { modulePath: "/tmp/local.js" })],
    );
    assert.equal(emptyRoot, path.join(agentDir, "data/extensions/runtime"));
    assert.equal(
      events.some(([name]) => name === "exec"),
      false,
    );

    const runtimeRoot = extensions.ensureBackgroundExtensionDependencies(
      agentDir,
      [packageEntry("z-owner", { version: "2" }), packageEntry("a-owner")],
    );
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(runtimeRoot, "package.json"), "utf8"),
      ),
      {
        private: true,
        type: "module",
        dependencies: { "a-owner": "1.0.0", "z-owner": "2" },
      },
    );
    assert.equal(events.filter(([name]) => name === "exec").length, 1);

    await fs.writeFile(path.join(runtimeRoot, "package-lock.json"), "{}\n");
    for (const name of ["a-owner", "z-owner"]) {
      await fs.mkdir(path.join(runtimeRoot, "node_modules", name), {
        recursive: true,
      });
    }
    extensions.ensureBackgroundExtensionDependencies(agentDir, [
      packageEntry("z-owner", { version: "2" }),
      packageEntry("a-owner"),
    ]);
    assert.equal(events.filter(([name]) => name === "exec").length, 1);

    scenario.installError = Object.assign(new Error("install failed"), {
      stderr: "owner stderr",
    });
    await fs.rm(path.join(runtimeRoot, "package-lock.json"));
    assert.throws(
      () =>
        extensions.ensureBackgroundExtensionDependencies(agentDir, [
          packageEntry("a-owner"),
        ]),
      /install failed/,
    );
  });
});

test("background manager owns extension API, service lifecycle, adapters, and memory providers", async () => {
  reset();
  await withSandbox(async ({ cwd, agentDir }) => {
    scenario.entries = [packageEntry("owner-extension")];
    const serviceStops: string[] = [];
    modules["owner-extension"] = {
      default(api: any) {
        assert.equal(api.cwd, cwd);
        assert.equal(api.agentDir, agentDir);
        assert.equal(api.dataDir, path.join(agentDir, "data"));
        assert.equal(api.name, "owner-extension");
        assert.equal(api.packageName, "owner-extension");
        assert.deepEqual(api.config, { owner: "owner-extension" });
        assert.equal(api.signal.aborted, false);
        api.logger.info("loaded");
        for (const method of [
          "on",
          "registerTool",
          "registerCommand",
          "registerShortcut",
          "registerFlag",
          "registerProvider",
        ]) {
          api[method]("owner");
        }
        api.registerBackgroundService(undefined);
        api.registerBackgroundService({});
        api.registerBackgroundService(async (context: any) => {
          context.runAsync("success", () => events.push(["async-success"]));
          context.runAsync("failure", () => {
            throw new Error("async owner failure");
          });
          return { stop: () => serviceStops.push("function") };
        });
        api.registerBackgroundService({
          async start() {
            return { stop: () => serviceStops.push("object") };
          },
        });
        api.registerChatAdapter({ kind: "owner-chat" });
        api.registerChatAdapter(
          { kind: "named-chat" },
          { key: "chat-key", name: "Owner Chat", config: { chat: true } },
        );
        api.registerMemoryProvider(undefined);
        api.registerMemoryProvider({});
        api.registerMemoryProvider(
          {
            async search(request: any, context: any) {
              assert.equal(request.mode, "search");
              assert.equal(context.key, "memory-key");
              return {
                results: [
                  {
                    id: "hit",
                    name: "Owner hit",
                    summary: request.query,
                    reference: "mem://hit",
                  },
                ],
              };
            },
            async listRecent(request: any) {
              return [
                {
                  id: "recent",
                  name: "Recent",
                  summary: String(request.limit),
                  reference: "mem://recent",
                },
              ];
            },
            async write(entry: any, context: any) {
              events.push(["memory-write", entry.text, context.config]);
            },
          },
          { key: "memory-key", name: "Owner Memory", config: { memory: true } },
        );
        api.registerMemoryProvider(
          {
            search() {
              throw new Error("search owner failure");
            },
            write() {
              throw new Error("write owner failure");
            },
          },
          { key: "failing-memory" },
        );
        return { stop: () => serviceStops.push("factory-result") };
      },
    };

    const warnings: string[] = [];
    const ownerManager = manager(cwd, agentDir, warnings);
    assert.deepEqual(await ownerManager.start(), [
      { name: "owner-extension", packageName: "owner-extension" },
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(ownerManager.getChatAdapterProviders(), [
      {
        key: "owner-extension",
        name: "owner-extension",
        packageName: "owner-extension",
        config: { owner: "owner-extension" },
        provider: { kind: "owner-chat" },
      },
      {
        key: "chat-key",
        name: "Owner Chat",
        packageName: "owner-extension",
        config: { chat: true },
        provider: { kind: "named-chat" },
      },
    ]);
    assert.deepEqual(ownerManager.getMemoryProviderMetadata(), [
      {
        key: "memory-key",
        name: "Owner Memory",
        packageName: "owner-extension",
      },
      {
        key: "failing-memory",
        name: "failing-memory",
        packageName: "owner-extension",
      },
    ]);

    const hits = await ownerManager.recallProviders({
      query: "owner query",
      limit: "3",
      extra: true,
    });
    assert.deepEqual(hits, [
      {
        sourceType: "external",
        provider: "memory-key",
        score: 3,
        id: "hit",
        name: "Owner hit",
        summary: "owner query",
        reference: "mem://hit",
      },
    ]);
    const recent = await ownerManager.recallProviders({ limit: 2 });
    assert.equal(recent[0].reference, "mem://recent");
    assert.deepEqual(
      await ownerManager.writeMemoryProviders({ text: "", role: "assistant" }),
      {
        written: 0,
        providerCount: 0,
      },
    );
    assert.deepEqual(
      await ownerManager.writeMemoryProviders({
        id: "entry",
        text: "owner text",
        role: "assistant",
      }),
      { written: 1, providerCount: 2 },
    );
    assert.equal(
      events.some(([name]) => name === "memory-write"),
      true,
    );

    await ownerManager.stop(0);
    assert.equal(serviceStops.includes("factory-result"), true);
    assert.equal(serviceStops.includes("object"), true);
    assert.equal(serviceStops.includes("function"), true);
    assert.equal(
      warnings.some((message) => message.includes("async task failed")),
      true,
    );
    assert.equal(
      warnings.some((message) =>
        message.includes("memory provider search failed"),
      ),
      true,
    );
    assert.equal(
      warnings.some((message) =>
        message.includes("memory provider write failed"),
      ),
      true,
    );
  });
});

test("background discovery deduplicates explicit, Pi, and cwd extensions and isolates failures", async () => {
  reset();
  await withSandbox(async ({ cwd, agentDir }) => {
    const packageRoot = path.join(cwd, "owner-package");
    const modulePath = path.join(packageRoot, "bridge.js");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "pi-owner", type: "module" }),
    );
    await fs.writeFile(
      modulePath,
      `export default function(api) { api.registerBackgroundService({ start() {} }); }\n`,
    );
    const autoPath = path.join(cwd, "extensions", "auto-owner", "index.js");
    await fs.mkdir(path.dirname(autoPath), { recursive: true });
    await fs.writeFile(
      autoPath,
      `export default function(api) { api.registerBackgroundService({ start() {} }); }\n`,
    );
    scenario.settings = { extensions: ["owner"] };
    scenario.entries = [
      packageEntry("duplicate", { modulePath }),
      packageEntry("duplicate-again", { modulePath }),
      packageEntry("missing", { modulePath: path.join(cwd, "missing.js") }),
    ];
    scenario.piEntries = [
      { enabled: false, path: modulePath },
      { enabled: true, path: "" },
      { enabled: true, path: packageRoot },
      {
        enabled: true,
        path: path.join(cwd, "no-package", "deep", "missing.js"),
      },
      {
        enabled: true,
        path: modulePath,
        metadata: {
          source: "owner-source",
          origin: "package",
          baseDir: packageRoot,
        },
      },
    ];
    const warnings: string[] = [];
    const ownerManager = manager(cwd, agentDir, warnings);
    const started = await ownerManager.start();
    assert.deepEqual(
      started.map((entry: any) => entry.packageName).sort(),
      ["duplicate", autoPath].sort(),
    );
    assert.equal(
      warnings.some((message) =>
        message.includes("background extension init failed"),
      ),
      true,
    );
    await ownerManager.stop();
  });

  reset();
  await withSandbox(async ({ cwd, agentDir }) => {
    scenario.settings = { packages: ["owner"] };
    scenario.resolveError = new Error("resolve owner failure");
    scenario.entries = [packageEntry("install-owner")];
    scenario.installError = Object.assign(new Error("install owner failure"), {
      stdout: "owner stdout",
    });
    const warnings: string[] = [];
    assert.deepEqual(await manager(cwd, agentDir, warnings).start(), []);
    assert.equal(
      warnings.some((message) => message.includes("package resolution failed")),
      true,
    );
    assert.equal(
      warnings.some((message) => message.includes("owner stdout")),
      true,
    );
  });
});

test("background module entrypoint shapes and stop failures remain isolated", async () => {
  for (const [name, moduleValue, expected] of [
    [
      "create-service",
      { createBackgroundService: () => ({ start() {} }) },
      true,
    ],
    ["rin-service", { rinBackgroundService: { start() {} } }, true],
    [
      "provider-service",
      { backgroundServiceProvider: () => ({ stop() {} }) },
      true,
    ],
    ["direct-service", { start() {} }, true],
    ["missing-service", { owner: true }, false],
  ] as const) {
    reset();
    await withSandbox(async ({ cwd, agentDir }) => {
      scenario.entries = [packageEntry(name)];
      modules[name] = moduleValue;
      const warnings: string[] = [];
      const ownerManager = manager(cwd, agentDir, warnings);
      const started = await ownerManager.start();
      assert.equal(started.length > 0, expected, name);
      assert.equal(
        warnings.some((message) => message.includes("entrypoint_missing")),
        !expected,
        name,
      );
      await ownerManager.stop();
    });
  }

  reset();
  await withSandbox(async ({ cwd, agentDir }) => {
    scenario.entries = [
      packageEntry("handled-empty"),
      packageEntry("optional-empty", { optional: true }),
    ];
    modules["handled-empty"] = { default: () => ({ owner: true }) };
    modules["optional-empty"] = { owner: true };
    const warnings: string[] = [];
    const ownerManager = manager(cwd, agentDir, warnings);
    assert.deepEqual(await ownerManager.start(), []);
    assert.equal(warnings.length, 0);
  });

  reset();
  await withSandbox(async ({ cwd, agentDir }) => {
    scenario.entries = [packageEntry("stop-owner")];
    modules["stop-owner"] = {
      createRinExtension() {
        return {
          start() {
            return {
              stop() {
                throw new Error("stop owner failure");
              },
            };
          },
        };
      },
    };
    const warnings: string[] = [];
    const ownerManager = manager(cwd, agentDir, warnings);
    await ownerManager.start();
    await ownerManager.stop();
    assert.equal(
      warnings.some((message) => message.includes("stop owner failure")),
      true,
    );
  });

  reset();
  await withSandbox(async ({ cwd, agentDir }) => {
    const warnings: string[] = [];
    const ownerManager = manager(cwd, agentDir, warnings);
    assert.deepEqual(await ownerManager.start(), []);
    assert.deepEqual(ownerManager.getChatAdapterProviders(), []);
    assert.deepEqual(ownerManager.getMemoryProviderMetadata(), []);
    await ownerManager.stop();
    assert.equal(
      fsSync.existsSync(path.join(agentDir, "data/extensions/runtime")),
      false,
    );
  });

  reset();
  await withSandbox(async ({ cwd, agentDir }) => {
    const packageRoot = path.join(cwd, "typed-owner");
    const typedModule = path.join(packageRoot, "index.ts");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@owner/typed extension" }),
    );
    await fs.writeFile(
      typedModule,
      `export default function(api: any) { api.logger.warn("typed"); api.registerBackgroundService({ start() {} }); }\n`,
    );
    scenario.entries = [
      packageEntry("typed-owner", { modulePath: typedModule }),
    ];
    const warnings: string[] = [];
    const ownerManager = manager(cwd, agentDir, warnings);
    assert.deepEqual(await ownerManager.start(), []);
    assert.equal(
      warnings.some((message) =>
        message.includes("background extension init failed"),
      ),
      true,
    );
    await ownerManager.stop();
  });
});
