import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";
import { createTestSandbox } from "../support/test-sandbox.js";

const triggerHost = await importBuiltModule<
  typeof import("../../src/core/nerve/trigger-host.js")
>("dist/core/nerve/trigger-host.js");

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("wait_for_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("trigger host launches TypeScript triggers and reloads them without daemon ownership", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-nerve-trigger-host-"),
  );
  const sandbox = await createTestSandbox(root);
  assert.equal(sandbox.env.RIN_DIR, sandbox.agentDir);
  const triggerDir = path.join(sandbox.agentDir, "nerve", "triggers");
  await fs.mkdir(triggerDir, { recursive: true });
  const triggerPath = path.join(triggerDir, "clock.ts");
  await fs.writeFile(
    triggerPath,
    `export async function start({ emit, sleepFor }: any) {
      await sleepFor(5);
      await emit({ dedupeKey: "clock-v1", body: "v1" });
    }\n`,
  );
  const emitted: any[] = [];
  const errors: any[] = [];
  const host = triggerHost.createNerveTriggerHost({
    agentDir: sandbox.agentDir,
    workerPath: path.resolve("dist/app/rin-daemon/nerve-trigger-worker.js"),
    emit: async (input: any) => {
      emitted.push(input);
    },
    onTriggerError: (input: any) => {
      errors.push(input);
    },
  });
  try {
    await host.start();
    await waitFor(() => emitted.length === 1);
    assert.deepEqual(emitted[0], {
      dedupeKey: "clock-v1",
      body: "v1",
    });

    await fs.writeFile(
      triggerPath,
      `export async function start({ emit }: any) {
        await emit({ dedupeKey: "clock-v2", body: "v2" });
      }\n`,
    );
    await host.reload("clock");
    await waitFor(() => emitted.length === 2);
    assert.equal(emitted[1].body, "v2");
    assert.equal(host.status().triggers[0]?.id, "clock");

    await fs.writeFile(
      triggerPath,
      `export async function start({ sleepFor }: any) {
        await sleepFor(60_000);
      }\n`,
    );
    await host.reload("clock");
    await waitFor(() => host.status().triggers[0]?.state === "running");
    const pid = host.status().triggers[0]?.pid;
    assert.equal(typeof pid, "number");
    process.kill(pid as number, "SIGTERM");
    await waitFor(() => host.status().triggers[0]?.state === "stopped");
    assert.deepEqual(errors, []);
  } finally {
    await host.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
