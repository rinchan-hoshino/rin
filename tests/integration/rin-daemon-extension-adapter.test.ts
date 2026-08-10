import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const { RinDaemonExtensionManager, resolveDaemonExtensionJitiStaticPath } =
  await import(
    pathToFileURL(path.join(rootDir, "dist/core/rin-daemon/extensions.js")).href
  );

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function writePackage(root: string, name: string, source: string) {
  const packageDir = path.join(root, name);
  await fs.mkdir(packageDir, { recursive: true });
  await writeJson(path.join(packageDir, "package.json"), {
    name,
    version: "1.0.0",
    type: "module",
    pi: { extensions: ["./index.js"] },
  });
  await fs.writeFile(path.join(packageDir, "index.js"), source, "utf8");
  return packageDir;
}

test("daemon TypeScript loading resolves jiti from Pi's runtime package", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-daemon-jiti-"));
  const piEntryPath = path.join(
    root,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "index.js",
  );
  const expectedJitiPath = path.join(
    root,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "jiti",
    "lib",
    "jiti-static.mjs",
  );
  try {
    await fs.mkdir(path.dirname(piEntryPath), { recursive: true });
    await fs.writeFile(piEntryPath, "export {};\n", "utf8");
    await writeJson(
      path.join(
        root,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "node_modules",
        "jiti",
        "package.json",
      ),
      { name: "jiti", version: "2.7.0" },
    );
    await fs.mkdir(path.dirname(expectedJitiPath), { recursive: true });
    await fs.writeFile(expectedJitiPath, "export {};\n", "utf8");

    assert.equal(
      resolveDaemonExtensionJitiStaticPath(piEntryPath),
      expectedJitiPath,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("daemon adaptation uses only Pi-discovered extension sources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-daemon-adapter-"));
  const eventsPath = path.join(root, "events.jsonl");
  const good = await writePackage(
    root,
    "owner-daemon-extension",
    `
      import fs from "node:fs";
      const record = (value) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(value) + "\\n");
      export default () => {};
      export const rinDaemonExtension = (api) => {
        api.logger.info("owner-info");
        api.logger.warn("owner-warn");
        api.logger.error("owner-error");
        api.registerBackgroundService(null);
        api.registerBackgroundService({});
        api.registerBackgroundService(async () => ({ stop: async () => record(["function-stop"]) }));
        api.registerBackgroundService({
          name: "owner-service",
          install: async (ctx) => record(["install", ctx.config.owner]),
          status: async () => ({ ready: true }),
          start: async (ctx) => {
            await ctx.sessions.getStates([]);
            const chatKeys = await ctx.chat.listKeys({ platform: "discord" });
            const bindings = await ctx.chat.getSessionBindings(chatKeys);
            record(["chat", await ctx.sessions.getStates(bindings)]);
            record(["start"]);
            return {
              stop: async () => { record(["stop"]); throw new Error("owner-stop"); },
            };
          },
        });
        api.registerChatAdapter({ name: "owner-chat", provider: { id: "owner-chat" } });
        api.registerChatAdapter(
          { name: "owner-chat-two", provider: { id: "owner-chat-two" } },
          { key: "chat-two", name: "Chat Two", config: { owner: 2 } },
        );
        api.registerMemoryProvider({});
        api.registerMemoryProvider({
          name: "owner-memory",
          metadata: { label: "Owner Memory" },
          search: async (request, ctx) => [{
            text: request.query,
            score: 1,
            metadata: { root: ctx.runtimeRoot },
          }],
          write: async () => true,
        });
        api.registerMemoryProvider({
          listRecent: async () => { throw new Error("owner-recent"); },
          write: async () => { throw new Error("owner-write"); },
        }, { key: "bad-memory", name: "Bad Memory" });
      };
    `,
  );
  const noDaemon = await writePackage(
    root,
    "owner-foreground-only",
    "export default () => {};",
  );
  const typescriptPackage = await writePackage(
    root,
    "owner-typescript-daemon",
    "export default () => {};",
  );
  await writeJson(path.join(typescriptPackage, "package.json"), {
    name: "owner-typescript-daemon",
    version: "1.0.0",
    type: "module",
    pi: { extensions: ["./index.ts"] },
  });
  await fs.writeFile(
    path.join(typescriptPackage, "index.ts"),
    `
      export default () => {};
      export const rinDaemonExtension = (api) => {
        api.registerBackgroundService(async () => ({ stop: async () => {} }));
      };
    `,
    "utf8",
  );
  const broken = await writePackage(
    root,
    "owner-broken-daemon",
    `
      export default () => {};
      export const rinDaemonExtension = () => { throw new Error("owner-broken"); };
    `,
  );
  await writeJson(path.join(root, "settings.json"), {
    extensions: [good, noDaemon, typescriptPackage, broken],
    rinExtensions: {
      daemon: [
        {
          name: "owner-config",
          packageName: "owner-daemon-extension",
          config: { owner: "configured" },
        },
        {
          name: "owner-typescript-daemon",
          packageName: "owner-wrong-package",
          config: { owner: "name-match" },
        },
      ],
    },
  });

  const messages: string[] = [];
  const warnings: string[] = [];
  const manager = new RinDaemonExtensionManager({
    agentDir: root,
    cwd: root,
    logger: {
      info: (message: string) => messages.push(message),
      warn: (message: string) => warnings.push(message),
      error: (message: string) => messages.push(message),
    },
  });
  const unavailableManager = new RinDaemonExtensionManager({
    agentDir: root,
    cwd: root,
    logger: console,
  });
  await unavailableManager.start();
  await unavailableManager.stop();

  manager.setChatApi({
    async listKeys() {
      return ["discord/1:10"];
    },
    async getSessionBindings() {
      return [{ token: "owner-session" }];
    },
  });
  manager.setSessionApi({
    async getStates(refs: readonly unknown[]) {
      return refs.map(() => "idle" as const);
    },
  });
  try {
    const running = await manager.start();
    assert.equal(running.length, 2, warnings.join("\n"));
    assert.equal(running[0].name, "owner-config");
    assert.equal((await manager.start()).length, 2);
    assert.equal(
      manager.getChatAdapterProviders()[0].provider.provider.id,
      "owner-chat",
    );
    assert.equal(manager.getChatAdapterProviders()[1].key, "chat-two");
    assert.equal(manager.getMemoryProviderMetadata()[0].name, "owner-config");
    assert.equal(manager.getMemoryProviderMetadata()[1].key, "bad-memory");
    const recalled = await manager.recallProviders({ query: "owner" });
    assert.equal(recalled[0].text, "owner");
    assert.equal(recalled[0].metadata.root, good);
    assert.deepEqual(await manager.recallProviders(), []);
    const written = await manager.writeMemoryProviders({
      role: "user",
      text: "owner",
    });
    assert.deepEqual(written, { written: 1, providerCount: 2 });
    const events = (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      events.some((value) => value[0] === "chat" && value[1][0] === "idle"),
      true,
    );
    assert.equal(
      messages.some((value) => value.includes("owner-info")),
      true,
    );
    assert.equal(
      messages.some((value) => value.includes("owner-error")),
      true,
    );
    assert.equal(
      warnings.some((value) => value.includes("owner-broken")),
      true,
    );
  } finally {
    await manager.stop(100);
    await fs.rm(root, { recursive: true, force: true });
  }
  assert.equal(
    warnings.some((value) => value.includes("owner-stop")),
    true,
  );
});

test("daemon adaptation follows Pi auto-discovery without a Rin registry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-daemon-auto-"));
  const extensionDir = path.join(root, "extensions", "owner-auto");
  await fs.mkdir(extensionDir, { recursive: true });
  await fs.mkdir(path.join(root, ".pi"), { recursive: true });
  await writeJson(path.join(root, ".pi", "settings.json"), {
    extensions: [path.join(extensionDir, "index.js")],
  });
  await fs.writeFile(
    path.join(extensionDir, "index.js"),
    `
      export default () => {};
      export const rinDaemonExtension = (api) => {
        api.registerBackgroundService(async () => ({ stop: async () => {} }));
      };
    `,
    "utf8",
  );
  const manager = new RinDaemonExtensionManager({ agentDir: root, cwd: root });
  try {
    const running = await manager.start({ extensions: [] });
    assert.equal(running.length, 1);
    assert.match(running[0].packageName, /owner-auto[\\/]index\.js$/);
  } finally {
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("daemon adaptation remains idle without Pi extension sources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-daemon-empty-"));
  const manager = new RinDaemonExtensionManager({ agentDir: root, cwd: root });
  try {
    assert.deepEqual(await manager.start(), []);
    assert.deepEqual(await manager.start({ packages: ["owner-unused"] }), []);
    assert.deepEqual(manager.getChatAdapterProviders(), []);
    assert.deepEqual(manager.getMemoryProviderMetadata(), []);
    assert.deepEqual(await manager.recallProviders(), []);
    assert.deepEqual(await manager.writeMemoryProviders({}), {
      written: 0,
      providerCount: 0,
    });
  } finally {
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
