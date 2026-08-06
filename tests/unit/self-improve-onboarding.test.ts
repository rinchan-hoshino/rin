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
    assert.equal(onboarding.isOnboardingActive(resolve), false);

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
    assert.equal(onboarding.isOnboardingActive(resolve, legacy), true);
  });
});

test("prompt, prompted, initialized, and startup transitions persist their contract", async () => {
  await withAgentDir(async (agentDir) => {
    const resolve = resolveAgentDir(agentDir);
    const manualPrompt = onboarding.buildOnboardingPrompt("manual");
    const automaticPrompt = onboarding.buildOnboardingPrompt("auto");
    assert.match(manualPrompt, /explicitly requested/);
    assert.match(automaticPrompt, /initialization is incomplete/);
    for (const prompt of [manualPrompt, automaticPrompt]) {
      assert.match(prompt, /initialization\.md/);
      assert.match(prompt, /completed state is false/);
    }

    const prompted = await onboarding.markOnboardingPrompted(
      resolve,
      "manual_command",
    );
    assert.equal(prompted.pending, true);
    assert.equal(prompted.initialized, false);
    assert.equal(prompted.lastTrigger, "manual_command");
    assert.match(prompted.promptedAt, /^\d{4}-\d{2}-\d{2}T/);

    const completed = onboarding.setOnboardingInitialized(
      resolve,
      true,
      "owner_complete",
    );
    assert.equal(completed.pending, false);
    assert.equal(completed.initialized, true);
    assert.equal(completed.lastTrigger, "owner_complete");
    assert.match(completed.completedAt, /^\d{4}-\d{2}-\d{2}T/);

    const preserved = onboarding.setOnboardingInitialized(
      resolve,
      true,
      "repeat_complete",
    );
    assert.equal(preserved.completedAt, completed.completedAt);

    const reset = onboarding.setOnboardingInitialized(
      resolve,
      false,
      "owner_reset",
    );
    assert.equal(reset.completedAt, "");
    assert.equal(reset.initialized, false);

    const startup = await onboarding.prepareOnboardingStartup(resolve);
    assert.equal(startup.shouldStart, true);
    assert.equal(startup.complete, false);
    assert.equal(startup.state.lastTrigger, "tui_startup");

    onboarding.setOnboardingInitialized(resolve, true, "finished");
    const complete = await onboarding.prepareOnboardingStartup(
      resolve,
      "unused_trigger",
    );
    assert.equal(complete.shouldStart, false);
    assert.equal(complete.complete, true);
    assert.equal(complete.state.lastTrigger, "finished");
  });
});
