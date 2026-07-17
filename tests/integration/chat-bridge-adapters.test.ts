import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const support = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href
);
const runtimeConfig = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "runtime-config.js"))
    .href
);
const adapters = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-bridge", "adapters.js"),
  ).href
);

test("chat bridge adapter labels and defaults come from shared built-in specs", () => {
  const specs = adapters.listChatBridgeAdapterSpecs();

  assert.deepEqual(
    specs.map((item) => item.key),
    ["telegram", "onebot", "lark", "discord", "slack", "minecraft"],
  );
  assert.deepEqual(adapters.getChatBridgeAdapterSpec("telegram")?.defaults, {
    protocol: "polling",
    token: "",
    slash: true,
  });
  assert.deepEqual(adapters.getChatBridgeAdapterSpec("slack")?.defaults, {
    protocol: "ws",
  });
  assert.deepEqual(adapters.listSupportedChatBridgeLabels(), [
    "Telegram",
    "OneBot",
    "Feishu / Lark",
    "Discord",
    "Slack",
    "Minecraft / QueQiao",
  ]);
});

test("chat bridge adapter config materialization covers built-in adapters", () => {
  const config = support.buildChatConfigFromSettings({
    chat: {
      discord: { token: "discord-token" },
      lark: [
        {
          name: "corp-a",
          appId: "cli_xxx",
          appSecret: "secret",
        },
      ],
    },
  });

  assert.deepEqual(config.plugins["adapter-discord"], {
    token: "discord-token",
  });
  assert.deepEqual(config.plugins["adapter-lark"], {
    protocol: "ws",
    platform: "feishu",
    appId: "cli_xxx",
    appSecret: "secret",
  });
});

test("chat bridge adapter config materialization applies minimal setup defaults", () => {
  const config = support.buildChatConfigFromSettings({
    chat: {
      lark: { appId: "cli_xxx", appSecret: "secret_xxx" },
      slack: { token: "xapp-demo", botToken: "xoxb-demo" },
    },
  });

  assert.deepEqual(config.plugins["adapter-lark"], {
    protocol: "ws",
    platform: "feishu",
    appId: "cli_xxx",
    appSecret: "secret_xxx",
  });
  assert.deepEqual(config.plugins["adapter-slack"], {
    protocol: "ws",
    token: "xapp-demo",
    botToken: "xoxb-demo",
  });
});

test("chat bridge runtime adapter entries expose only configured built-in adapter keys", () => {
  const entries = support.listChatRuntimeAdapterEntries({
    chat: {
      telegram: { token: "telegram-token", protocol: "polling" },
      onebot: { endpoint: "ws://127.0.0.1:3001", protocol: "ws", selfId: "42" },
      minecraft: { url: "ws://127.0.0.1:8080", selfId: "minecraft" },
    },
  });

  assert.deepEqual(
    entries.map((item) => item.key),
    ["telegram", "onebot", "minecraft"],
  );
});

test("chat runtime config expands multi-entry built-in adapters and strips setup-only metadata", () => {
  const settings = {
    chat: {
      telegram: [
        {
          name: "Alpha Bot",
          token: "telegram-alpha",
          owners: ["owner"],
          ownerUserIds: ["42"],
          botId: "tg-alpha",
        },
        {
          name: "Beta/Bot",
          token: "telegram-beta",
          slash: false,
        },
      ],
    },
  };

  const config = runtimeConfig.buildChatConfigFromSettings(settings);
  const entries = runtimeConfig.listChatRuntimeAdapterEntries(settings);

  assert.deepEqual(config.plugins["adapter-telegram"], {
    protocol: "polling",
    token: "telegram-alpha",
    slash: true,
  });
  assert.deepEqual(config.plugins["adapter-telegram:Beta-Bot"], {
    protocol: "polling",
    token: "telegram-beta",
    slash: false,
  });
  assert.deepEqual(
    entries.map((item) => ({
      key: item.key,
      name: item.name,
      config: item.config,
    })),
    [
      {
        key: "telegram",
        name: "Alpha-Bot",
        config: {
          protocol: "polling",
          token: "telegram-alpha",
          slash: true,
        },
      },
      {
        key: "telegram",
        name: "Beta-Bot",
        config: {
          protocol: "polling",
          token: "telegram-beta",
          slash: false,
        },
      },
    ],
  );
});

test("chat runtime normalization expands named built-in adapter maps", () => {
  const settings = {
    chat: {
      telegram: {
        "Alpha Bot": {
          token: "telegram-alpha",
        },
        beta: {
          name: "Beta/Bot",
          token: "telegram-beta",
          slash: false,
        },
      },
    },
  };

  const config = runtimeConfig.buildChatConfigFromSettings(settings);
  const entries = runtimeConfig.listChatRuntimeAdapterEntries(settings);

  assert.deepEqual(config.plugins["adapter-telegram"], {
    protocol: "polling",
    token: "telegram-alpha",
    slash: true,
  });
  assert.deepEqual(config.plugins["adapter-telegram:Beta-Bot"], {
    protocol: "polling",
    token: "telegram-beta",
    slash: false,
  });
  assert.deepEqual(
    entries.map((item) => ({
      key: item.key,
      name: item.name,
      config: item.config,
    })),
    [
      {
        key: "telegram",
        name: "Alpha-Bot",
        config: {
          protocol: "polling",
          token: "telegram-alpha",
          slash: true,
        },
      },
      {
        key: "telegram",
        name: "Beta-Bot",
        config: {
          protocol: "polling",
          token: "telegram-beta",
          slash: false,
        },
      },
    ],
  );
});

test("chat runtime normalization skips disabled built-in entries", () => {
  const settings = {
    chat: {
      telegram: [
        {
          name: "Enabled Bot",
          token: "telegram-enabled",
        },
        {
          name: "Disabled Bot",
          token: "telegram-disabled",
          enabled: false,
        },
      ],
    },
  };

  const config = runtimeConfig.buildChatConfigFromSettings(settings);
  const entries = runtimeConfig.listChatRuntimeAdapterEntries(settings);
  const runtimePackage = runtimeConfig.buildChatRuntimePackageJson(settings);

  assert.deepEqual(config.plugins["adapter-telegram"], {
    protocol: "polling",
    token: "telegram-enabled",
    slash: true,
  });
  assert.equal("adapter-telegram:Disabled-Bot" in config.plugins, false);
  assert.deepEqual(
    entries.map((item) => ({ key: item.key, name: item.name })),
    [{ key: "telegram", name: "Enabled-Bot" }],
  );
  assert.deepEqual(runtimePackage.dependencies, {});
});

test("chat runtime package has no generated dependencies", () => {
  const settings = {
    chat: {
      telegram: { token: "telegram-token", protocol: "polling" },
    },
  };

  const entries = runtimeConfig.listChatRuntimeAdapterEntries(settings);
  const runtimePackage = runtimeConfig.buildChatRuntimePackageJson(settings);

  assert.deepEqual(
    entries.map((item) => item.key),
    ["telegram"],
  );
  assert.deepEqual(runtimePackage.dependencies, {});
  assert.equal(
    runtimeConfig.shouldInstallChatRuntimeDependencies(
      "/tmp/rin-chat-runtime",
      settings,
    ),
    false,
  );
  assert.deepEqual(
    runtimeConfig.ensureChatRuntimeDependencies(
      "/tmp/rin-chat-runtime",
      settings,
    ),
    {
      installed: false,
      dependencies: {},
      rootDir: "/tmp/rin-chat-runtime",
    },
  );
});

test("chat support re-exports chat runtime config helpers", () => {
  assert.equal(
    support.buildChatConfigFromSettings,
    runtimeConfig.buildChatConfigFromSettings,
  );
  assert.equal(
    support.listChatRuntimeAdapterEntries,
    runtimeConfig.listChatRuntimeAdapterEntries,
  );
  assert.equal(
    support.buildChatRuntimePackageJson,
    runtimeConfig.buildChatRuntimePackageJson,
  );
});
