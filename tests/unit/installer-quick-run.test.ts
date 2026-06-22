import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createQuickRunRuntimeEnv,
  persistQuickRunProviderState,
  pickQuickRunExistingProvider,
  quickRunInstallDirForCurrentUser,
} from "../../src/core/rin-install/quick-run.js";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-quick-run-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("quick run targets only the current user's ~/.rin directory", () => {
  assert.equal(
    quickRunInstallDirForCurrentUser("/tmp/rin-home"),
    "/tmp/rin-home/.rin",
  );
});

test("quick run runtime env points Rin and Pi at the selected ~/.rin", () => {
  const env = createQuickRunRuntimeEnv("/tmp/rin-home/.rin", { PATH: "/bin" });
  assert.equal(env.RIN_DIR, "/tmp/rin-home/.rin");
  assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/rin-home/.rin");
  assert.equal(env.PATH, "/bin");
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

test("quick run persists only provider settings and auth needed by the temporary backend", async () => {
  await withTempDir(async (home) => {
    const installDir = path.join(home, ".rin");
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "settings.json"),
      JSON.stringify({ keep: true, defaultModel: "old" }),
      "utf8",
    );

    persistQuickRunProviderState({
      installDir,
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "medium",
      language: "zh-CN",
      authData: { openai: { type: "api_key", key: "test" } },
    });

    const settings = JSON.parse(
      await fs.readFile(path.join(installDir, "settings.json"), "utf8"),
    );
    assert.deepEqual(settings, {
      keep: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "medium",
      language: "zh_CN",
    });
    const auth = JSON.parse(
      await fs.readFile(path.join(installDir, "auth.json"), "utf8"),
    );
    assert.deepEqual(auth, { openai: { type: "api_key", key: "test" } });
    await assert.rejects(fs.stat(path.join(installDir, "app")), /ENOENT/);
  });
});
