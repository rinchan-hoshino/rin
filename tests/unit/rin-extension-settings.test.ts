import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const extensionSettings = await importBuiltModule<
  typeof import("../../src/core/rin-extension-settings.js")
>("dist/core/rin-extension-settings.js");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-extensions-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("runtime settings and extension roots clone valid persisted configuration", async () => {
  assert.deepEqual(extensionSettings.getRinExtensionRoot(null), {});
  assert.deepEqual(extensionSettings.getRinExtensionRoot({}), {});

  const settings = {
    rinExtensions: {
      backgroundServices: [{ packageName: "@demo/service" }],
    },
  };
  const root = extensionSettings.getRinExtensionRoot(settings);
  assert.deepEqual(root, settings.rinExtensions);
  (root.backgroundServices as any[])[0].packageName = "changed";
  assert.equal(
    settings.rinExtensions.backgroundServices[0].packageName,
    "@demo/service",
  );

  await withAgentDir(async (agentDir) => {
    assert.deepEqual(extensionSettings.readRuntimeSettings(agentDir), {});
    await fs.writeFile(path.join(agentDir, "settings.json"), "invalid", "utf8");
    assert.deepEqual(extensionSettings.readRuntimeSettings(agentDir), {});
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify(settings),
      "utf8",
    );
    assert.deepEqual(extensionSettings.readRuntimeSettings(agentDir), settings);
  });
});

test("daemon extension configs reject disabled or incomplete entries and normalize accepted packages", () => {
  assert.deepEqual(extensionSettings.listRinDaemonExtensionConfigs(null), []);
  assert.deepEqual(
    extensionSettings.listRinDaemonExtensionConfigs({
      rinExtensions: { daemon: "not an array" },
    }),
    [],
  );

  const settings = {
    rinExtensions: {
      daemon: [
        null,
        "invalid",
        { enabled: false, packageName: "disabled" },
        { packageName: "   " },
        {
          packageName: " @scope/demo service ",
          name: " ",
          version: " ",
          config: { nested: { enabled: true } },
        },
        {
          packageName: "plain-service",
          name: " Custom Name ",
          version: " 2.0.0 ",
          config: "invalid",
        },
      ],
    },
  };
  const configs = extensionSettings.listRinDaemonExtensionConfigs(settings);
  assert.deepEqual(configs, [
    {
      name: "scope-demo-service",
      packageName: "@scope/demo service",
      version: "latest",
      config: { nested: { enabled: true } },
    },
    {
      name: "Custom Name",
      packageName: "plain-service",
      version: "2.0.0",
      config: {},
    },
  ]);
  (configs[0].config.nested as any).enabled = false;
  assert.equal(settings.rinExtensions.daemon[4].config.nested.enabled, true);
});

test("extension runtime roots and importer creation are stable and non-destructive", async () => {
  await withAgentDir(async (agentDir) => {
    const runtimeRoot = extensionSettings.getRinExtensionRuntimeRoot(agentDir);
    assert.equal(
      runtimeRoot,
      path.join(agentDir, "data", "extensions", "runtime"),
    );

    const importerPath = extensionSettings.ensureRuntimeImporter(
      runtimeRoot,
      "import-provider.mjs",
    );
    assert.equal(importerPath, path.join(runtimeRoot, "import-provider.mjs"));
    assert.equal(
      await fs.readFile(importerPath, "utf8"),
      "export async function importProvider(specifier) { return await import(specifier); }\n",
    );

    await fs.writeFile(importerPath, "custom importer\n", "utf8");
    assert.equal(
      extensionSettings.ensureRuntimeImporter(
        runtimeRoot,
        "import-provider.mjs",
      ),
      importerPath,
    );
    assert.equal(await fs.readFile(importerPath, "utf8"), "custom importer\n");
  });
});
