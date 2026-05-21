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
const loaderModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "loader.js")).href
);
const runtimeModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeExtensionPackage(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "package.json"), {
    name: "rin-extension-loader-test",
    version: "0.0.0",
    type: "module",
    pi: { extensions: ["dist/index.js"] },
  });
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "dist", "index.js"),
    `export default function extension(ctx) {
      ctx.registerChatAdapter(() => ({ adapter: { start() {}, stop() {} }, bot: { platform: "x", selfId: "x", status: 1, sendMessage() {} } }), { key: "x" });
      ctx.registerBackgroundService({ start() { return { stop() {} }; } });
      ctx.registerTool({ name: "rin_extension_loader_tool", description: ctx.dataDir, parameters: { type: "object", properties: {} }, execute() { return { content: [{ type: "text", text: ctx.dataDir }] }; } });
    }\n`,
    "utf8",
  );
}

test("Rin DefaultResourceLoader gives foreground extensions the Rin SDK surface", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-ext-loader-"));
  const extensionDir = path.join(agentDir, "extension");
  try {
    await writeExtensionPackage(extensionDir);
    await writeJson(path.join(agentDir, "settings.json"), {
      extensions: [extensionDir],
    });

    const PiAgentRuntime = await loaderModule.loadPiAgentRuntime();
    const settingsManager = PiAgentRuntime.SettingsManager.create(
      agentDir,
      agentDir,
    );
    const resourceLoader = new PiAgentRuntime.DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager,
    });

    await resourceLoader.reload();
    const result = resourceLoader.getExtensions();
    assert.deepEqual(result.errors, []);
    const tools = result.extensions.flatMap((extension: any) =>
      Array.from(extension.tools.values()).map((tool: any) => tool.definition),
    );
    const tool = tools.find(
      (item: any) => item.name === "rin_extension_loader_tool",
    );
    assert.ok(tool);
    assert.equal(tool.description, path.join(agentDir, "data"));
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("configured Rin sessions use the Rin extension loader through agent services", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-ext-session-"));
  const extensionDir = path.join(agentDir, "extension");
  const previousSessionDir = process.env.RIN_SESSION_DIR;
  try {
    await writeExtensionPackage(extensionDir);
    await writeJson(path.join(agentDir, "settings.json"), {
      extensions: [extensionDir],
    });
    process.env.RIN_SESSION_DIR = path.join(agentDir, "sessions");

    const configured = await runtimeModule.createConfiguredAgentSession({
      cwd: agentDir,
      agentDir,
      noContextFiles: true,
    });
    try {
      const result = configured.session.resourceLoader.getExtensions();
      assert.deepEqual(result.errors, []);
      const tools = result.extensions.flatMap((extension: any) =>
        Array.from(extension.tools.values()).map(
          (tool: any) => tool.definition,
        ),
      );
      assert.ok(
        tools.some((item: any) => item.name === "rin_extension_loader_tool"),
      );
    } finally {
      await configured.runtime?.dispose?.().catch?.(() => {});
    }
  } finally {
    if (previousSessionDir === undefined) delete process.env.RIN_SESSION_DIR;
    else process.env.RIN_SESSION_DIR = previousSessionDir;
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
