import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const onboarding = await importBuiltModule<
  typeof import("../../src/core/self-improve/onboarding.js")
>("dist/core/self-improve/onboarding.js");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-onboarding-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function resolveAgentDir(agentDir: string) {
  return () => agentDir;
}

test("onboarding state defaults safely and accepts legacy completion evidence", async () => {
  await withAgentDir(async (agentDir) => {
    const resolve = resolveAgentDir(agentDir);
    assert.deepEqual(onboarding.getOnboardingState(resolve), {
      version: 2,
      promptedAt: "",
      completedAt: "",
      lastTrigger: "",
      pending: false,
      initialized: false,
    });

    const statePath = path.join(
      agentDir,
      "self_improve",
      "state",
      "init-state.json",
    );
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, "not json", "utf8");
    assert.equal(onboarding.getOnboardingState(resolve).initialized, false);

    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        completedAt: "2026-01-01T00:00:00.000Z",
        pending: true,
        custom: "preserved",
      }),
      "utf8",
    );
    const legacy = onboarding.getOnboardingState(resolve);
    assert.equal(legacy.version, 1);
    assert.equal(legacy.initialized, true);
    assert.equal(legacy.pending, true);
    assert.equal(legacy.custom, "preserved");
  });
});

test("runtime records initialization when it starts and does not ask the model to complete lifecycle state", async () => {
  await withAgentDir(async (agentDir) => {
    const resolve = resolveAgentDir(agentDir);
    const manualPrompt = onboarding.buildOnboardingPrompt("manual");
    const automaticPrompt = onboarding.buildOnboardingPrompt("auto");
    assert.match(manualPrompt, /explicitly requested/);
    assert.match(automaticPrompt, /initialization is incomplete/);
    for (const prompt of [manualPrompt, automaticPrompt]) {
      assert.match(prompt, /initialization\.md/);
      assert.doesNotMatch(prompt, /completed state|init-state\.json/i);
    }

    const startup = await onboarding.prepareOnboardingStartup(resolve);
    assert.equal(startup.shouldStart, true);
    assert.equal(startup.state.pending, false);
    assert.equal(startup.state.initialized, true);
    assert.equal(startup.state.lastTrigger, "tui_startup");
    assert.match(startup.state.promptedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(startup.state.completedAt, "");

    const persisted = onboarding.getOnboardingState(resolve);
    assert.deepEqual(persisted, startup.state);

    const repeated = await onboarding.prepareOnboardingStartup(
      resolve,
      "unused_trigger",
    );
    assert.equal(repeated.shouldStart, false);
    assert.deepEqual(repeated.state, startup.state);
  });
});
