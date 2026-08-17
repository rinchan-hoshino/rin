import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const { loadRinAgentRuntime } = await import(
  pathToFileURL(path.join(rootDir, "dist/core/rin-lib/agent-runtime.js")).href
);
const { withPiDefaultExtensionFactories } = await import(
  pathToFileURL(path.join(rootDir, "dist/core/pi/private-api.js")).href
);
const { createConfiguredAgentSession } = await import(
  pathToFileURL(path.join(rootDir, "dist/core/rin-lib/runtime.js")).href
);
const { loadRinFrontendExtensionDefinitions } = await import(
  pathToFileURL(
    path.join(rootDir, "dist/core/rin-tui/frontend-extension-adapter.js"),
  ).href
);
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist/core/rin-tui/runtime.js")).href
);

test("Rin uses Pi's native resource loader instead of a parallel loader", async () => {
  const runtime = await loadRinAgentRuntime();
  assert.equal(runtime.DefaultResourceLoader, DefaultResourceLoader);
});

test("Rin's Pi adapter preserves caller inline extensions after Pi built-ins", async () => {
  const customFactory = { name: "owner-inline", factory() {} };
  const options = withPiDefaultExtensionFactories({
    extensionFactories: [customFactory],
  });
  assert.equal(options.extensionFactories.at(-1), customFactory);
  assert.equal(
    options.extensionFactories.some((entry: any) => entry.name === "llama.cpp"),
    true,
  );
});

test("Rin composes Pi built-in extensions through the native loader", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-pi-loader-"));
  const configured = await createConfiguredAgentSession({
    cwd: root,
    agentDir: root,
    sessionManager: SessionManager.inMemory(root),
    piAgentSessionServicesOptions: {
      allowModelNetwork: false,
    },
  });

  try {
    await configured.session.bindExtensions({ mode: "rpc" });
    assert.ok(
      configured.session.extensionRunner
        .getRegisteredCommands()
        .some((command: any) => command.name === "llama"),
      "Pi's built-in /llama extension must remain available in Rin",
    );
  } finally {
    await configured.runtime.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the frontend adapter preserves native Pi renderers, shortcuts, and tool definitions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-pi-frontend-"));
  const extensionPath = path.join(root, "frontend-extension.mjs");
  await fs.writeFile(
    extensionPath,
    `export default function (pi) {
      pi.registerTool({
        name: "frontend_tool",
        label: "Frontend tool",
        description: "frontend renderer probe",
        parameters: { type: "object", properties: {} },
        async execute() { return { content: [{ type: "text", text: "ok" }] }; },
        renderCall() { return "render-call"; },
        renderResult() { return "render-result"; }
      });
      pi.registerMessageRenderer("frontend_message", () => "render-message");
      pi.registerFlag("owner-flag", { description: "owner flag", type: "string" });
      pi.registerShortcut("ctrl+alt+f", {
        description: "frontend shortcut",
        async handler() {}
      });
    }\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "settings.json"),
    `${JSON.stringify({ extensions: [extensionPath] })}\n`,
    "utf8",
  );

  await loadRinFrontendExtensionDefinitions({
    cwd: root,
    agentDir: root,
    resources: {},
  });
  const frontendExtensions = await loadRinFrontendExtensionDefinitions({
    cwd: root,
    agentDir: root,
    resources: {
      additionalExtensionPaths: [extensionPath],
      additionalSkillPaths: [],
      additionalPromptTemplatePaths: [],
      additionalThemePaths: [],
      extensionFlagValues: { "owner-flag": "enabled" },
      noExtensions: false,
      noSkills: false,
      noPromptTemplates: false,
      noThemes: false,
      noContextFiles: false,
    },
  });
  const client = {
    async call() {
      return {};
    },
    subscribe() {
      return () => {};
    },
  } as any;
  const session = new RpcInteractiveSession(
    client,
    { extensionFlagValues: { "owner-flag": "enabled" } },
    frontendExtensions,
  );

  try {
    assert.equal(
      typeof session.getToolDefinition("frontend_tool")?.renderCall,
      "function",
    );
    assert.equal(
      typeof session.extensionRunner.getMessageRenderer("frontend_message"),
      "function",
    );
    assert.ok(session.extensionRunner.getShortcuts({}).has("ctrl+alt+f"));
    assert.equal(
      session.extensionRunner.getFlagValues().get("owner-flag"),
      "enabled",
    );
    assert.equal(
      session.extensionRunner
        .getAllRegisteredTools()
        .some(
          (registration: any) =>
            registration.definition?.name === "frontend_tool",
        ),
      true,
    );
    assert.equal(typeof session.extensionRunner.getModelRegistry(), "object");
    assert.equal(session.getToolDefinition("missing_frontend_tool"), undefined);
    assert.equal(
      session.extensionRunner.getMessageRenderer("missing_frontend_message"),
      undefined,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
