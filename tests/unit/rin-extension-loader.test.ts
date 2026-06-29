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
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "agent-runtime.js"),
  ).href
);
const runtimeModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);
const piCodingAgent = await import("@earendil-works/pi-coding-agent");

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

test("Rin agent runtime owns the composed resource loading boundary", async () => {
  const rinRuntime = await loaderModule.loadRinAgentRuntime();
  assert.equal(typeof rinRuntime.DefaultResourceLoader, "function");
  assert.equal(typeof rinRuntime.createAgentSessionServices, "function");
  assert.equal(typeof rinRuntime.calculateContextTokens, "function");
  assert.equal(typeof rinRuntime.estimateContextTokens, "function");

  const estimate = rinRuntime.estimateContextTokens([
    { role: "user", content: [{ type: "text", text: "prompt" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      stopReason: "stop",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 20,
        cacheWrite: 0,
        totalTokens: 35,
      },
    },
    { role: "toolResult", content: [{ type: "text", text: "abcd" }] },
  ]);
  assert.equal(estimate, 36);

  const imageMessage = {
    role: "user",
    content: [
      { type: "image", data: "base64-image-data", mimeType: "image/png" },
    ],
  };
  assert.equal(
    rinRuntime.estimateContextTokens([imageMessage]),
    piCodingAgent.estimateTokens(imageMessage),
  );
});

test("Rin DefaultResourceLoader gives foreground extensions the Rin SDK surface", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-ext-loader-"));
  const extensionDir = path.join(agentDir, "extension");
  try {
    await writeExtensionPackage(extensionDir);
    await writeJson(path.join(agentDir, "settings.json"), {
      extensions: [extensionDir],
    });

    const PiAgentRuntime = await loaderModule.loadRinAgentRuntime();
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

test("Rin agent services pass Pi resource loader reload options", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-reload-options-"),
  );
  try {
    await fs.mkdir(path.join(agentDir, ".pi"), { recursive: true });
    await writeJson(path.join(agentDir, ".pi", "settings.json"), {
      steeringMode: "all",
    });

    const PiAgentRuntime = await loaderModule.loadRinAgentRuntime();
    const settingsManager = PiAgentRuntime.SettingsManager.create(
      agentDir,
      agentDir,
      { projectTrusted: false },
    );
    let resolverCalled = false;
    await PiAgentRuntime.createAgentSessionServices({
      cwd: agentDir,
      agentDir,
      settingsManager,
      resourceLoaderReloadOptions: {
        resolveProjectTrust: async () => {
          resolverCalled = true;
          return false;
        },
      },
    });

    assert.equal(resolverCalled, true);
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
