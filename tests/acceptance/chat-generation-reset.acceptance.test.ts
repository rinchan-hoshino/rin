import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadGherkinFeature,
  runGherkinScenario,
  type GherkinStepDefinition,
} from "../../scripts/test/gherkin.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const distRoot =
  process.env.RIN_MUTATION_DIST_ROOT?.trim() || path.join(rootDir, "dist");
const database = await import(
  pathToFileURL(path.join(distRoot, "core/chat/database.js")).href
);
const outbox = await import(
  pathToFileURL(path.join(distRoot, "core/chat/outbox.js")).href
);
const feature = loadGherkinFeature(
  process.env.RIN_ACCEPTANCE_FEATURE_PATH?.trim() ||
    path.join(
      rootDir,
      "tests/acceptance/features/chat-generation-reset.feature",
    ),
);

type World = {
  agentDir: string;
  chatKey: string;
  itemId: string;
  resetResult?: { currentGeneration: number };
};

const definitions: GherkinStepDefinition<World>[] = [
  {
    pattern:
      /^a claimed interim delivery whose adapter dispatch has (not )?started$/,
    async run(world, notStarted) {
      world.itemId = outbox.enqueueChatOutboxPayload(
        world.agentDir,
        {
          createdAt: new Date().toISOString(),
          chatKey: world.chatKey,
          parts: [{ type: "text", text: "working" }],
        },
        { deliveryKind: "interim" },
      );
      const claimed = outbox.claimChatOutboxItem(world.agentDir, world.itemId, {
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(claimed.status, "sending");
      if (!notStarted) {
        assert.ok(
          outbox.markChatOutboxDispatchStarted(world.agentDir, claimed),
        );
      }
    },
  },
  {
    pattern: /^the chat generation is reset with nonterminal settlement$/,
    run(world) {
      world.resetResult = database.advanceChatGeneration(
        world.agentDir,
        world.chatKey,
        { resolveNonterminalSends: true },
      );
    },
  },
  {
    pattern: /^the chat generation advances exactly once$/,
    run(world) {
      assert.equal(world.resetResult?.currentGeneration, 1);
      assert.equal(
        database.readChatState(world.agentDir, world.chatKey).currentGeneration,
        1,
      );
    },
  },
  {
    pattern: /^the delivery is failed without an unconfirmed marker$/,
    run(world) {
      const item = outbox.readChatOutboxItemById(
        world.agentDir,
        world.itemId,
      )?.item;
      assert.equal(item?.status, "failed");
      assert.equal(Boolean(item?.deliveryUnconfirmed), false);
      assert.equal(item?.failureKind, "permanent");
    },
  },
  {
    pattern: /^the delivery is delivered with an unconfirmed marker$/,
    run(world) {
      const item = outbox.readChatOutboxItemById(
        world.agentDir,
        world.itemId,
      )?.item;
      assert.equal(item?.status, "delivered");
      assert.equal(item?.deliveryUnconfirmed, true);
      assert.equal(Boolean(item?.failureKind), false);
    },
  },
];

for (const scenario of feature.scenarios) {
  test(`${feature.name}: ${scenario.name}`, async () => {
    const agentDir = await fs.mkdtemp(
      path.join(
        process.env.RIN_TEST_TMPDIR || os.tmpdir(),
        "rin-acceptance-reset-",
      ),
    );
    const world: World = {
      agentDir,
      chatKey: "telegram/acceptance-bot:acceptance-chat",
      itemId: "",
    };
    try {
      await runGherkinScenario({ feature, scenario, world, definitions });
    } finally {
      database.closeChatDatabase(agentDir);
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
}
