import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertAsyncProperty, fc } from "../../scripts/test/property-check.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist/core/chat/database.js")).href
);

test("property: sequence allocation and generation reset follow one state model", async () => {
  await assertAsyncProperty(
    fc.asyncProperty(
      fc.array(fc.constantFrom("allocate", "advance"), {
        minLength: 1,
        maxLength: 40,
      }),
      async (operations) => {
        const agentDir = await fs.mkdtemp(
          path.join(
            process.env.RIN_TEST_TMPDIR || os.tmpdir(),
            "rin-property-db-",
          ),
        );
        const chatKey = "telegram/property-bot:property-chat";
        let expectedGeneration = 0;
        let expectedSequence = 1;
        try {
          for (const operation of operations) {
            if (operation === "allocate") {
              assert.deepEqual(
                database.allocateChatSequence(agentDir, chatKey),
                {
                  sequence: expectedSequence,
                  generation: expectedGeneration,
                },
              );
              expectedSequence += 1;
            } else {
              expectedGeneration += 1;
              assert.equal(
                database.advanceChatGeneration(agentDir, chatKey)
                  .currentGeneration,
                expectedGeneration,
              );
            }
            assert.deepEqual(database.readChatState(agentDir, chatKey), {
              chatKey,
              currentGeneration: expectedGeneration,
              nextSequence: expectedSequence,
            });
          }
        } finally {
          database.closeChatDatabase(agentDir);
          await fs.rm(agentDir, { recursive: true, force: true });
        }
      },
    ),
    { numRuns: 40 },
  );
});
