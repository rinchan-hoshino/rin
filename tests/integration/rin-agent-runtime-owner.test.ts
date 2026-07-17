import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const agentRuntime = await importBuiltModule<
  typeof import("../../src/core/rin-lib/agent-runtime.js")
>("dist/core/rin-lib/agent-runtime.js");

async function writeOwnerExtension(directory: string) {
  await fs.mkdir(path.join(directory, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "owner-runtime-extension",
      version: "0.0.0",
      type: "module",
      pi: { extensions: ["dist/index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(directory, "dist", "index.js"),
    `export default function extension(context) {
      context.registerFlag("owner-toggle", { type: "boolean" });
      context.registerFlag("owner-label", { type: "string" });
      context.registerProvider("owner-provider", { baseUrl: "https://example.invalid" });
    }\n`,
  );
}

test("Rin runtime composes the Pi runtime and caches the composed surface", async () => {
  const first: any = await agentRuntime.loadRinAgentRuntime();
  const second = await agentRuntime.loadRinAgentRuntime();

  assert.equal(second, first);
  assert.equal(typeof first.DefaultResourceLoader, "function");
  assert.equal(typeof first.createAgentSessionServices, "function");
  assert.equal(typeof first.calculateContextTokens, "function");
  assert.equal(typeof first.estimateContextTokens, "function");
  assert.ok(
    first.estimateContextTokens([
      { role: "user", content: [{ type: "text", text: "owner message" }] },
    ]) > 0,
  );
});

test("Rin session services own extension loading, defaults, and flag diagnostics", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-runtime-owner-"),
  );
  const extensionDir = path.join(agentDir, "extension");
  try {
    await writeOwnerExtension(extensionDir);
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ extensions: [extensionDir] }),
    );

    const runtime: any = await agentRuntime.loadRinAgentRuntime();
    const authStorage = runtime.AuthStorage.inMemory({});
    const settingsManager = runtime.SettingsManager.create(agentDir, agentDir);
    const modelRegistry = runtime.ModelRegistry.create(
      authStorage,
      path.join(agentDir, "models.json"),
    );
    let trustChecks = 0;
    const services = await runtime.createAgentSessionServices({
      cwd: agentDir,
      agentDir,
      authStorage,
      settingsManager,
      modelRegistry,
      extensionFlagValues: new Map([
        ["owner-toggle", false],
        ["owner-label", "rin"],
        ["unknown-one", true],
      ]),
      resourceLoaderOptions: {},
      resourceLoaderReloadOptions: {
        async resolveProjectTrust() {
          trustChecks += 1;
          return false;
        },
      },
    });

    assert.equal(services.cwd, agentDir);
    assert.equal(services.agentDir, agentDir);
    assert.equal(services.authStorage, authStorage);
    assert.equal(services.settingsManager, settingsManager);
    assert.equal(services.modelRegistry, modelRegistry);
    assert.equal(trustChecks, 1);
    const extensions = services.resourceLoader.getExtensions();
    assert.equal(extensions.runtime.flagValues.get("owner-toggle"), true);
    assert.equal(extensions.runtime.flagValues.get("owner-label"), "rin");
    assert.match(
      services.diagnostics[0].message,
      /Unknown option: --unknown-one/,
    );

    const originalGetExtensions =
      runtime.DefaultResourceLoader.prototype.getExtensions;
    const getExtensions = mock.method(
      runtime.DefaultResourceLoader.prototype,
      "getExtensions",
      function (this: any) {
        const result = originalGetExtensions.call(this);
        result.runtime.pendingProviderRegistrations = [
          {
            name: "owner-provider",
            config: {},
            extensionPath: "/owner/extension.js",
          },
          {
            name: "owner-provider-plain-error",
            config: {},
            extensionPath: "/owner/plain-extension.js",
          },
        ];
        return result;
      },
    );
    try {
      let providerCalls = 0;
      const providerFailure = await runtime.createAgentSessionServices({
        cwd: agentDir,
        agentDir,
        authStorage,
        settingsManager,
        modelRegistry: {
          registerProvider() {
            providerCalls += 1;
            if (providerCalls === 1) {
              throw new Error("owner provider rejected");
            }
            const error = new Error("");
            error.toString = () => "plain provider rejection";
            throw error;
          },
        },
      });
      assert.match(
        providerFailure.diagnostics[0].message,
        /owner provider rejected/,
      );
      assert.match(
        providerFailure.diagnostics[1].message,
        /plain provider rejection/,
      );
    } finally {
      getExtensions.mock.restore();
    }

    const invalid = await runtime.createAgentSessionServices({
      cwd: agentDir,
      agentDir,
      authStorage,
      settingsManager,
      modelRegistry,
      extensionFlagValues: new Map([
        ["owner-label", true],
        ["unknown-one", true],
        ["unknown-two", true],
      ]),
    });
    assert.ok(
      invalid.diagnostics.some((entry: any) =>
        String(entry.message).includes("requires a value"),
      ),
    );
    assert.ok(
      invalid.diagnostics.some((entry: any) =>
        String(entry.message).includes("Unknown options"),
      ),
    );

    const defaults = await runtime.createAgentSessionServices({
      cwd: agentDir,
      agentDir,
    });
    assert.equal(defaults.diagnostics.length, 0);

    const inferred = await runtime.createAgentSessionServices({
      cwd: agentDir,
      authStorage,
      settingsManager,
      modelRegistry,
    });
    assert.ok(inferred.agentDir);

    const empty = await runtime.createAgentSessionServices({
      cwd: agentDir,
      agentDir: "",
    });
    assert.equal(empty.agentDir, "");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
