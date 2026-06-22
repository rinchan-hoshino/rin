import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  pickQuickRunExistingProvider,
  quickRunInstallDirForCurrentUser,
} from "../../src/core/rin-install/quick-run.js";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

test("quick run targets only the current user's ~/.rin directory", () => {
  assert.equal(
    quickRunInstallDirForCurrentUser("/tmp/rin-home"),
    "/tmp/rin-home/.rin",
  );
});

test("quick run reuses an existing configured subscription without prompting", () => {
  const picked = pickQuickRunExistingProvider({
    models: [
      {
        provider: "anthropic",
        providerLabel: "Anthropic",
        authKind: "api",
        id: "claude",
        reasoning: false,
        available: false,
      },
      {
        provider: "openai",
        providerLabel: "ChatGPT Plus/Pro",
        authKind: "subscription",
        id: "codex-mini",
        reasoning: true,
        available: true,
      },
    ],
    settings: {
      defaultProvider: "openai",
      defaultModel: "codex-mini",
      defaultThinkingLevel: "medium",
    },
    authData: { openai: { type: "oauth" } },
  });

  assert.deepEqual(picked, {
    provider: "openai",
    modelId: "codex-mini",
    thinkingLevel: "medium",
    authResult: {
      available: true,
      authKind: "existing",
      authData: { openai: { type: "oauth" } },
    },
  });
});

test("quick run honors an available configured default model even when auth is external", () => {
  const picked = pickQuickRunExistingProvider({
    models: [
      {
        provider: "openai",
        providerLabel: "ChatGPT Plus/Pro",
        authKind: "subscription",
        id: "codex-mini",
        reasoning: true,
        available: true,
      },
      {
        provider: "openai",
        providerLabel: "ChatGPT Plus/Pro",
        authKind: "subscription",
        id: "codex-max",
        reasoning: true,
        available: true,
      },
    ],
    settings: {
      defaultProvider: "openai",
      defaultModel: "codex-max",
      defaultThinkingLevel: "high",
    },
    authData: {},
  });

  assert.equal(picked?.modelId, "codex-max");
  assert.equal(picked?.thinkingLevel, "high");
});

test("quick run defaults to an available existing subscription when settings are incomplete", () => {
  const picked = pickQuickRunExistingProvider({
    models: [
      {
        provider: "openai",
        providerLabel: "ChatGPT Plus/Pro",
        authKind: "subscription",
        id: "codex-mini",
        reasoning: true,
        available: true,
      },
    ],
    settings: {},
    authData: { openai: { type: "oauth" } },
  });

  assert.equal(picked?.provider, "openai");
  assert.equal(picked?.modelId, "codex-mini");
  assert.equal(picked?.thinkingLevel, "off");
});

test("quick run uses installer finalization without daemon or runtime launch paths", async () => {
  const quickRunSource = await fs.readFile(
    path.join(rootDir, "src", "core", "rin-install", "quick-run.ts"),
    "utf8",
  );
  const finalizeSource = await fs.readFile(
    path.join(rootDir, "src", "core", "rin-install", "finalize.ts"),
    "utf8",
  );

  assert.match(quickRunSource, /finalizeQuickRunInstall/);
  assert.doesNotMatch(quickRunSource, /spawn\(/);
  assert.doesNotMatch(quickRunSource, /canConnectDaemonSocket/);
  assert.doesNotMatch(quickRunSource, /defaultDaemonSocketPath/);
  assert.match(finalizeSource, /export async function finalizeQuickRunInstall/);
  assert.match(finalizeSource, /publishRuntime:\s*false/);
  assert.match(finalizeSource, /manageDaemon:\s*false/);
  assert.match(finalizeSource, /prepareManagedTools:\s*false/);
  assert.match(finalizeSource, /writeLaunchers:\s*false/);
});
