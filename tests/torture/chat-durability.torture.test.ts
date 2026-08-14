import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  deterministicBits,
  tortureConfiguration,
} from "../../scripts/test/torture.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const childFixture = path.join(
  rootDir,
  "tests/support/chat-durability-torture-child.ts",
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist/core/chat/database.js")).href
);
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist/core/chat/outbox.js")).href
);

async function makeTempDir(label: string) {
  return fs.mkdtemp(
    path.join(process.env.RIN_TEST_TMPDIR || os.tmpdir(), `rin-${label}-`),
  );
}

function runAllocationChild(agentDir: string, chatKey: string, count: number) {
  return new Promise<Array<{ sequence: number; generation: number }>>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          childFixture,
          "allocate",
          agentDir,
          chatKey,
          String(count),
        ],
        { cwd: rootDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code !== 0 || signal) {
          reject(
            new Error(
              `allocation_child_failed:${code}:${signal || "none"}:${stderr}`,
            ),
          );
          return;
        }
        resolve(JSON.parse(stdout));
      });
    },
  );
}

test(
  "torture: abrupt sender exits preserve enough evidence for deterministic generation settlement",
  { timeout: 120_000 },
  async () => {
    const { seed, scale } = tortureConfiguration();
    const agentDir = await makeTempDir("crash-settlement-torture");
    const chatKey = "telegram/torture-bot:crash-chat";
    const cycles = 8 * scale;
    try {
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const dispatchBits = deterministicBits(seed + cycle, 7);
        dispatchBits[0] = false;
        dispatchBits[1] = true;
        const outputPath = path.join(agentDir, `crash-${cycle}.json`);
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            childFixture,
            "crash-after-claim",
            agentDir,
            chatKey,
            dispatchBits.map((value) => (value ? "1" : "0")).join(""),
            outputPath,
          ],
          { cwd: rootDir, env: process.env, encoding: "utf8" },
        );
        assert.equal(child.status, 91, child.stderr);
        const evidence = JSON.parse(await fs.readFile(outputPath, "utf8")) as {
          items: Array<{ id: string; dispatchStarted: boolean }>;
        };

        const advanced = database.advanceChatGeneration(agentDir, chatKey, {
          resolveNonterminalSends: true,
        });
        assert.deepEqual(advanced, {
          previousGeneration: cycle,
          currentGeneration: cycle + 1,
        });
        for (const expected of evidence.items) {
          const actual = outbox.readChatOutboxItemById(
            agentDir,
            expected.id,
          )?.item;
          assert.ok(actual, expected.id);
          assert.equal(
            actual.status,
            expected.dispatchStarted ? "delivered" : "failed",
          );
          assert.equal(
            Boolean(actual.deliveryUnconfirmed),
            expected.dispatchStarted,
          );
        }
        database.closeChatDatabase(agentDir);
      }
    } finally {
      database.closeChatDatabase(agentDir);
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  },
);

test(
  "torture: competing processes allocate one gap-free durable sequence",
  { timeout: 120_000 },
  async () => {
    const { scale } = tortureConfiguration();
    const agentDir = await makeTempDir("sequence-contention-torture");
    const chatKey = "discord/torture-bot:contention-chat";
    const processCount = 6;
    const allocationsPerProcess = 20 * scale;
    try {
      const allocations = (
        await Promise.all(
          Array.from({ length: processCount }, () =>
            runAllocationChild(agentDir, chatKey, allocationsPerProcess),
          ),
        )
      ).flat();
      const sequences = allocations
        .map((allocation) => allocation.sequence)
        .sort((left, right) => left - right);
      assert.equal(sequences.length, processCount * allocationsPerProcess);
      assert.equal(new Set(sequences).size, sequences.length);
      assert.deepEqual(
        sequences,
        Array.from({ length: sequences.length }, (_, index) => index + 1),
      );
      assert.deepEqual(
        [...new Set(allocations.map((allocation) => allocation.generation))],
        [0],
      );
    } finally {
      database.closeChatDatabase(agentDir);
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  },
);
