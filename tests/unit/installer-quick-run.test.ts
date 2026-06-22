import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createQuickRunRuntimeEnv,
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

test("quick run finalizes prepare-only state then launches temporary daemon and TUI", async () => {
  const quickRunSource = await fs.readFile(
    path.join(rootDir, "src", "core", "rin-install", "quick-run.ts"),
    "utf8",
  );
  const finalizeSource = await fs.readFile(
    path.join(rootDir, "src", "core", "rin-install", "finalize.ts"),
    "utf8",
  );

  assert.match(quickRunSource, /finalizeQuickRunInstall/);
  assert.match(quickRunSource, /launchQuickRunTui/);
  assert.match(quickRunSource, /rin-daemon/);
  assert.match(quickRunSource, /rin-tui/);
  assert.match(
    quickRunSource,
    /spawn\(process\.execPath, \[daemonEntry, socketPath\]/,
  );
  assert.match(quickRunSource, /spawn\(process\.execPath, \[tuiEntry\]/);
  assert.match(quickRunSource, /waitForDaemonReady/);
  assert.match(quickRunSource, /canConnectDaemonSocket/);
  assert.match(quickRunSource, /createQuickRunSocketPath/);
  assert.match(quickRunSource, /RIN_DAEMON_SOCKET_ENV/);
  assert.match(quickRunSource, /RIN_SKIP_VERSION_CHECK_ENV/);
  assert.doesNotMatch(quickRunSource, /defaultDaemonSocketPath/);
  assert.doesNotMatch(quickRunSource, /rin_quick_run_daemon_already_running/);
  assert.doesNotMatch(quickRunSource, /ensureQuickRunUserSkillDir/);
  assert.doesNotMatch(quickRunSource, /Rin quick run will prepare/);
  assert.doesNotMatch(quickRunSource, /Rin quick run is ready/);
  assert.match(finalizeSource, /export async function finalizeQuickRunInstall/);
  assert.match(finalizeSource, /publishRuntime:\s*false/);
  assert.match(finalizeSource, /manageDaemon:\s*false/);
  assert.match(finalizeSource, /prepareManagedTools:\s*false/);
  assert.match(finalizeSource, /writeLaunchers:\s*false/);
});

test("quick run runtime env targets ~/.rin and skips update version checks", () => {
  assert.deepEqual(createQuickRunRuntimeEnv("/tmp/rin-home/.rin", {}), {
    RIN_DIR: "/tmp/rin-home/.rin",
    PI_CODING_AGENT_DIR: "/tmp/rin-home/.rin",
    RIN_QUICK_RUN: "1",
    RIN_SKIP_VERSION_CHECK: "1",
  });
  assert.deepEqual(
    createQuickRunRuntimeEnv("/tmp/rin-home/.rin", {}, "/tmp/rin.sock"),
    {
      RIN_DIR: "/tmp/rin-home/.rin",
      PI_CODING_AGENT_DIR: "/tmp/rin-home/.rin",
      RIN_QUICK_RUN: "1",
      RIN_SKIP_VERSION_CHECK: "1",
      RIN_DAEMON_SOCKET: "/tmp/rin.sock",
    },
  );
});
