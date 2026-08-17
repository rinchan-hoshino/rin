import "../support/require-test-sandbox.ts";
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

test("Rin runtime auth storage persists credentials and delegates provider operations", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-runtime-auth-owner-"),
  );
  const authPath = path.join(root, "auth.json");
  try {
    await fs.writeFile(
      authPath,
      JSON.stringify({ existing: { type: "api_key", key: "stored" } }),
    );
    const runtime: any = await agentRuntime.loadRinAgentRuntime();
    const auth = runtime.AuthStorage.create(authPath);
    const calls: any[] = [];
    auth.bindModelRuntime({
      getProviders: () => [
        {
          id: "oauth-owner",
          name: "OAuth Owner",
          auth: { oauth: { name: "Owner Login", usesCallbackServer: true } },
        },
        {
          id: "oauth-name-fallback",
          name: "Fallback Name",
          auth: { oauth: {} },
        },
        { id: "oauth-id-fallback", auth: { oauth: {} } },
        { id: "", auth: { oauth: {} } },
        { id: "api-owner", name: "API Owner" },
      ],
      setRuntimeApiKey: async (...args: any[]) => calls.push(["key", ...args]),
      login: async (...args: any[]) => {
        calls.push(["login", ...args]);
        const interaction = args[2];
        if (interaction?.prompt) {
          await interaction.prompt({
            type: "select",
            message: "select owner",
            options: ["one"],
            signal: new AbortController().signal,
          });
          await interaction.prompt({ type: "manual_code", message: "code" });
          await interaction.prompt({ type: "text", message: "text" });
        }
        interaction?.notify?.({ type: "auth_url", url: "https://owner" });
        interaction?.notify?.({ type: "device_code", code: "OWNER" });
        interaction?.notify?.({ type: "info", message: "owner info" });
        interaction?.notify?.({ type: "progress", message: "owner progress" });
        interaction?.notify?.({ type: "unknown" });
        return { type: "oauth", access: "owner-token" };
      },
      logout: async (...args: any[]) => calls.push(["logout", ...args]),
    });

    assert.equal(auth.get("existing").key, "stored");
    assert.deepEqual(await auth.read("missing"), undefined);
    assert.equal(auth.hasAuth("existing"), true);
    assert.deepEqual(auth.list(), [
      { providerId: "existing", type: "api_key" },
    ]);
    assert.deepEqual(auth.getOAuthProviders(), [
      {
        id: "oauth-owner",
        name: "Owner Login",
        usesCallbackServer: true,
      },
      {
        id: "oauth-name-fallback",
        name: "Fallback Name",
        usesCallbackServer: false,
      },
      {
        id: "oauth-id-fallback",
        name: "oauth-id-fallback",
        usesCallbackServer: false,
      },
    ]);
    auth.set("api-owner", { type: "api_key", key: "owner-key" });
    auth.set("oauth-static", {
      type: "oauth",
      access: "static-owner-token",
    });
    auth.set("", { type: "api_key", key: "ignored" });
    await auth.modify("api-owner", (credential: any) => ({
      ...credential,
      key: "modified",
    }));
    assert.equal(auth.get("api-owner").key, "modified");
    const authInteractions: string[] = [];
    await auth.login("oauth-owner", {
      signal: new AbortController().signal,
      onSelect: () => authInteractions.push("select"),
      onManualCodeInput: () => authInteractions.push("manual"),
      onPrompt: (prompt: any) => {
        assert.equal(prompt.allowEmpty, true);
        authInteractions.push("text");
      },
      onAuth: () => authInteractions.push("auth"),
      onDeviceCode: () => authInteractions.push("device"),
      onInfo: () => authInteractions.push("info"),
      onProgress: () => authInteractions.push("progress"),
    });
    assert.deepEqual(authInteractions, [
      "select",
      "manual",
      "text",
      "auth",
      "device",
      "info",
      "progress",
    ]);
    const directInteractions: string[] = [];
    await auth.login("oauth-owner", {
      prompt: async () => directInteractions.push("prompt"),
      notify: () => directInteractions.push("notify"),
    });
    assert.ok(directInteractions.includes("prompt"));
    assert.ok(directInteractions.includes("notify"));
    assert.equal(auth.get("oauth-owner").access, "owner-token");
    auth.logout("oauth-owner");
    await auth.delete("api-owner");
    await auth.modify("created", () => ({
      type: "api_key",
      key: "created-owner-key",
    }));
    assert.equal(auth.get("created").key, "created-owner-key");
    await auth.delete("created");
    assert.equal(auth.hasAuth("api-owner"), false);
    assert.ok(calls.some(([name]) => name === "key"));
    assert.ok(calls.some(([name]) => name === "login"));
    assert.ok(calls.some(([name]) => name === "logout"));

    const memory = runtime.AuthStorage.inMemory({
      plain: { type: "api_key", key: "memory-owner-key" },
    });
    assert.deepEqual(memory.list(), [{ providerId: "plain", type: "api_key" }]);
    assert.deepEqual(memory.getOAuthProviders(), []);
    memory.set("owner", { type: "api_key", key: "owner-key" });
    assert.equal(await memory.login("owner"), undefined);
    memory.logout("owner");
    memory.set("", { type: "api_key", key: "ignored" });
    memory.logout("");
    await assert.rejects(memory.login(""), /oauth_provider_id_required/);

    const noPath = runtime.AuthStorage.create();
    noPath.set("owner", { type: "api_key", key: "owner-key" });
    assert.equal(noPath.getAll().owner.key, "owner-key");

    await fs.writeFile(authPath, "not-json");
    assert.deepEqual(runtime.AuthStorage.create(authPath).getAll(), {});
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
    const modelRuntime = await runtime.ModelRuntime.create({
      credentials: authStorage,
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    const modelRegistry = runtime.createModelRegistry(
      modelRuntime,
      authStorage,
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
