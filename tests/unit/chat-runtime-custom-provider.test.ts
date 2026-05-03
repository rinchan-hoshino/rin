import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const runtime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js"))
    .href
);

async function writeProviderPackage(
  runtimeRoot: string,
  packageName: string,
  source: string,
  packageJson: Record<string, unknown> = {},
) {
  const packageDir = path.join(runtimeRoot, "node_modules", packageName);
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
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
  await fs.writeFile(path.join(packageDir, "index.js"), source, "utf8");
}

test("chat runtime loads custom provider return values from runtime root packages", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-runtime-"));
  const markerPath = path.join(dir, "lifecycle.log");
  try {
    await writeProviderPackage(
      dir,
      "chat-runtime-provider-return",
      `import fs from "node:fs";
export function createAdapter({ config }) {
  return {
    adapter: {
      async start() { fs.appendFileSync(config.markerPath, "start\\n"); },
      async stop() { fs.appendFileSync(config.markerPath, "stop\\n"); },
    },
    bot: {
      platform: "custom-return",
      selfId: "bot-1",
      status: 0,
      async sendMessage() { return []; },
    },
  };
}
`,
    );

    const app = runtime.createChatRuntimeApp(dir);
    const created = await runtime.instantiateChatRuntimeAdapters(app, {
      dataDir: dir,
      runtimeRoot: dir,
      adapterEntries: [
        {
          key: "custom-return",
          name: "primary",
          builtIn: false,
          packageName: "chat-runtime-provider-return",
          config: { markerPath },
        },
      ],
    });

    assert.deepEqual(created, [{ key: "custom-return", name: "primary" }]);
    assert.equal(app.bots[0]?.platform, "custom-return");
    await app.start();
    await app.stop();
    assert.equal(await fs.readFile(markerPath, "utf8"), "start\nstop\n");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("chat runtime loads ESM-only provider package exports with import conditions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-runtime-"));
  try {
    await writeProviderPackage(
      dir,
      "chat-runtime-provider-esm-only",
      `export const chatBridgeProvider = {
  createAdapter() {
    return {
      adapter: { async start() {}, async stop() {} },
      bot: { platform: "custom-esm", selfId: "bot-esm", status: 0, async sendMessage() { return []; } },
    };
  },
};
`,
      { exports: { import: "./index.js" }, main: undefined },
    );

    const app = runtime.createChatRuntimeApp(dir);
    const created = await runtime.instantiateChatRuntimeAdapters(app, {
      dataDir: dir,
      runtimeRoot: dir,
      adapterEntries: [
        {
          key: "custom-esm",
          name: "primary",
          builtIn: false,
          packageName: "chat-runtime-provider-esm-only",
          config: {},
        },
      ],
    });

    assert.deepEqual(created, [{ key: "custom-esm", name: "primary" }]);
    assert.equal(app.bots[0]?.platform, "custom-esm");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("chat runtime custom providers may self-register with the app", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-runtime-"));
  try {
    await writeProviderPackage(
      dir,
      "chat-runtime-provider-self-register",
      `export default {
  createAdapter({ app }) {
    app.register(
      { async start() {}, async stop() {} },
      { platform: "custom-self", selfId: "bot-2", status: 0, async sendMessage() { return []; } },
    );
  },
};
`,
    );

    const app = runtime.createChatRuntimeApp(dir);
    const created = await runtime.instantiateChatRuntimeAdapters(app, {
      dataDir: dir,
      runtimeRoot: dir,
      adapterEntries: [
        {
          key: "custom-self",
          name: "primary",
          builtIn: false,
          packageName: "chat-runtime-provider-self-register",
          config: {},
        },
      ],
    });

    assert.deepEqual(created, [{ key: "custom-self", name: "primary" }]);
    assert.equal(app.bots[0]?.platform, "custom-self");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("chat runtime rejects custom providers that do not register a bot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-runtime-"));
  const warnings: string[] = [];
  try {
    await writeProviderPackage(
      dir,
      "chat-runtime-provider-empty",
      `export function createAdapter() { return {}; }\n`,
    );

    const app = runtime.createChatRuntimeApp(dir);
    const created = await runtime.instantiateChatRuntimeAdapters(app, {
      dataDir: dir,
      runtimeRoot: dir,
      logger: { warn: (message: string) => warnings.push(String(message)) },
      adapterEntries: [
        {
          key: "empty",
          name: "primary",
          builtIn: false,
          packageName: "chat-runtime-provider-empty",
          config: {},
        },
      ],
    });

    assert.deepEqual(created, []);
    assert.equal(app.bots.length, 0);
    assert.match(warnings[0] || "", /provider_return_requires_adapter_and_bot/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("chat runtime custom provider failures are isolated", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-runtime-"));
  const warnings: string[] = [];
  try {
    const app = runtime.createChatRuntimeApp(dir);
    const created = await runtime.instantiateChatRuntimeAdapters(app, {
      dataDir: dir,
      runtimeRoot: dir,
      logger: { warn: (message: string) => warnings.push(String(message)) },
      adapterEntries: [
        {
          key: "missing",
          name: "primary",
          builtIn: false,
          packageName: "missing-chat-runtime-provider",
          config: {},
        },
      ],
    });

    assert.deepEqual(created, []);
    assert.equal(app.bots.length, 0);
    assert.match(
      warnings[0] || "",
      /chat runtime adapter init failed key=missing/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
