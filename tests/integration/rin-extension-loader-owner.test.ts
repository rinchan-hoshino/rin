import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRinDefaultResourceLoader } from "../../dist/core/rin-lib/extension-loader.js";

async function withTempDir(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-loader-owner-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

const fullExtension = `export default async function ownerExtension(api) {
  if ("registerBackgroundService" in api || "registerChatAdapter" in api || "dataDir" in api || "runtimeRoot" in api) {
    throw new Error("daemon APIs leaked into the session extension API");
  }
  api.on("owner:event", () => "first");
  api.on("owner:event", () => "second");
  api.registerTool({ name: " owner_tool ", description: "owner tool" });
  api.registerCommand(" owner-command ", { description: "owner command" });
  api.registerShortcut(" ctrl+x ", { description: "owner shortcut" });
  api.registerFlag(" owner-flag ", { default: "enabled" });
  api.registerMessageRenderer(" owner-message ", () => "rendered");
  api.registerEntryRenderer(" owner-entry ", () => "entry");
  api.registerProvider({ id: "owner-provider" });
  api.unregisterProvider("owner-provider");
  api.sendMessage(); api.sendUserMessage(); api.appendEntry(); api.setSessionName();
  api.setLabel(); api.setActiveTools(); api.setThinkingLevel();
  const unsubscribe = api.events.on("owner:bus", () => {});
  unsubscribe();
  api.events.emit("owner:bus");
  await api.exec("true", []); await api.setModel({ provider: "owner", id: "model" });
  api.getSessionName(); api.getActiveTools(); api.getAllTools(); api.getCommands();
  api.getThinkingLevel(); api.getFlag("owner-flag");
}`;

function fakeRuntime(configured: string[]) {
  const constructorOptions: any[] = [];
  const packageManagerCalls: any[] = [];
  class BaseLoader {
    cwd: string;
    agentDir: string;
    settingsManager: any;
    eventBus = { on: () => () => {}, off() {}, emit() {} };
    extensionsResult: any;
    constructor(options: any) {
      constructorOptions.push(options);
      this.cwd = options.cwd;
      this.agentDir = options.agentDir;
      this.settingsManager = options.settingsManager;
      this.extensionsResult = {
        extensions: [],
        errors: [],
        runtime: {
          assertActive() {},
          invalidate() {},
          trackEventBusSubscription(unsubscribe: () => void) {
            return unsubscribe;
          },
          appendEntry() {},
          flagValues: new Map(),
          getActiveTools: () => [],
          getAllTools: () => [],
          getCommands: () => [],
          getSessionName: () => "",
          getThinkingLevel: () => "off",
          pendingNativeProviderRegistrations: [],
          pendingProviderRegistrations: [],
          refreshTools() {},
          registerNativeProvider() {},
          registerProvider() {},
          sendMessage() {},
          sendUserMessage() {},
          setActiveTools() {},
          setLabel() {},
          async setModel() {},
          setSessionName() {},
          setThinkingLevel() {},
          unregisterProvider() {},
        },
      };
    }
    async reload(options?: any) {
      packageManagerCalls.push({ baseReload: options });
      this.extensionsResult.extensions = [];
      this.extensionsResult.errors = [];
    }
    getExtensions() {
      return this.extensionsResult;
    }
  }
  class PackageManager {
    constructor(options: any) {
      packageManagerCalls.push({ constructor: options });
    }
    async resolveExtensionSources(paths: string[], options: any) {
      packageManagerCalls.push({ cli: paths, options });
      return {
        extensions: paths.map((entry) => ({ path: entry, enabled: true })),
      };
    }
    async resolve() {
      packageManagerCalls.push({ configured: true });
      return {
        extensions: configured.map((entry) => ({ path: entry, enabled: true })),
      };
    }
  }
  return {
    runtime: {
      DefaultResourceLoader: BaseLoader,
      DefaultPackageManager: PackageManager,
    },
    constructorOptions,
    packageManagerCalls,
  };
}

test("Rin resource loader resolves file, directory, package, nested, and TypeScript extensions", async () => {
  await withTempDir(async (root) => {
    const direct = await writeFile(path.join(root, "direct.js"), fullExtension);
    const indexDir = path.join(root, "index-dir");
    await writeFile(
      path.join(indexDir, "index.js"),
      `export default api => api.registerTool({ name: "index_tool" });`,
    );
    const packageDir = path.join(root, "package-dir");
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ pi: { extensions: ["entry.js", "missing.js"] } }),
    );
    await writeFile(
      path.join(packageDir, "entry.js"),
      `export default api => api.registerCommand("package-command", {});`,
    );
    const manifestFallbackDir = path.join(root, "manifest-fallback");
    await writeFile(
      path.join(manifestFallbackDir, "package.json"),
      JSON.stringify({ name: "owner-manifest-fallback" }),
    );
    await writeFile(
      path.join(manifestFallbackDir, "index.js"),
      `export default api => api.registerTool({ name: "manifest_fallback" });`,
    );
    const nestedRoot = path.join(root, "nested-root");
    await writeFile(
      path.join(nestedRoot, "plain.js"),
      `export default api => api.registerShortcut("plain", {});`,
    );
    await writeFile(path.join(nestedRoot, "ignored.txt"), "ignored");
    await writeFile(
      path.join(nestedRoot, "child", "index.js"),
      `export default api => api.registerFlag("nested", { default: 7 });`,
    );
    await writeFile(
      path.join(nestedRoot, "package-child", "package.json"),
      JSON.stringify({ pi: { extensions: ["dist/main.js"] } }),
    );
    await writeFile(
      path.join(nestedRoot, "package-child", "dist", "main.js"),
      `export default api => api.registerMessageRenderer("nested-message", () => "ok");`,
    );
    const typescript = await writeFile(
      path.join(root, "typed.ts"),
      `export default function typed(api: any) { api.registerTool({ name: "typed_tool" }); }`,
    );
    const ignored = await writeFile(
      path.join(root, "ignored.js"),
      `export const value = 1;`,
    );
    const broken = await writeFile(
      path.join(root, "broken.js"),
      `throw new Error("owner broken extension");`,
    );

    const { runtime, constructorOptions, packageManagerCalls } = fakeRuntime([
      packageDir,
      manifestFallbackDir,
      nestedRoot,
      ignored,
      broken,
      path.join(root, "missing.js"),
    ]);
    const Loader = createRinDefaultResourceLoader(runtime as any);
    const loader = new Loader({
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager: { id: "settings" },
      additionalExtensionPaths: [direct, direct, indexDir, typescript, "  "],
    });
    await loader.reload({ reason: "owner-test" });

    assert.deepEqual(constructorOptions[0].additionalExtensionPaths, []);
    assert.equal(constructorOptions[0].noExtensions, true);
    assert.ok(
      packageManagerCalls.some(
        (call) => call.baseReload?.reason === "owner-test",
      ),
    );
    assert.ok(
      packageManagerCalls.some((call) => call.options?.temporary === true),
    );

    const result = loader.getExtensions();
    const directError = result.errors.find((item: any) => item.path === direct);
    assert.equal(directError?.error, undefined);
    assert.deepEqual(
      result.extensions
        .map((extension: any) => extension.path)
        .sort((left: string, right: string) => left.localeCompare(right)),
      [
        direct,
        path.join(indexDir, "index.js"),
        path.join(packageDir, "entry.js"),
        path.join(manifestFallbackDir, "index.js"),
        path.join(nestedRoot, "plain.js"),
        path.join(nestedRoot, "child", "index.js"),
        path.join(nestedRoot, "package-child", "dist", "main.js"),
        typescript,
      ].sort((left, right) => left.localeCompare(right)),
    );
    assert.equal(result.errors.length, 2);
    assert.ok(
      result.errors.some(
        (item: any) =>
          item.path === broken && /owner broken extension/.test(item.error),
      ),
    );
    assert.ok(
      result.errors.some((item: any) => /missing\.js$/.test(item.path)),
    );

    const owner = result.extensions.find(
      (extension: any) => extension.path === direct,
    );
    assert.equal(owner.handlers.get("owner:event").length, 2);
    assert.equal(
      owner.tools.get(" owner_tool ").definition.description,
      "owner tool",
    );
    assert.equal(
      owner.commands.get(" owner-command ").description,
      "owner command",
    );
    assert.equal(owner.shortcuts.get(" ctrl+x ").extensionPath, direct);
    assert.equal(owner.flags.get(" owner-flag ").extensionPath, direct);
    assert.equal(owner.flags.get(" owner-flag ").default, "enabled");
    assert.equal(result.runtime.flagValues.get(" owner-flag "), "enabled");
    assert.equal(owner.messageRenderers.get(" owner-message ")(), "rendered");
  });
});

test("Rin resource loader honors noExtensions while retaining temporary CLI extensions", async () => {
  await withTempDir(async (root) => {
    const direct = await writeFile(
      path.join(root, "direct.js"),
      `export default api => api.registerTool({ name: "direct" });`,
    );
    const configured = await writeFile(
      path.join(root, "configured.js"),
      `export default api => api.registerTool({ name: "configured" });`,
    );
    const { runtime, packageManagerCalls } = fakeRuntime([configured]);
    const Loader = createRinDefaultResourceLoader(runtime as any);
    const loader = new Loader({
      cwd: root,
      agentDir: root,
      settingsManager: {},
      additionalExtensionPaths: [
        direct,
        "~/missing-owner-extension.js",
        "~missing-owner-extension.js",
      ],
      noExtensions: true,
    });
    await loader.reload();
    assert.deepEqual(
      loader
        .getExtensions()
        .extensions.map((item: any) => path.basename(item.path)),
      ["direct.js"],
    );
    const errors = loader.getExtensions().errors;
    assert.equal(errors.length, 2);
    assert.equal(new Set(errors.map((item: any) => item.path)).size, 1);
    assert.equal(
      packageManagerCalls.some((call) => call.configured),
      false,
    );
  });
});
