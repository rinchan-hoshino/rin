import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const policy = await importBuiltModule<
  typeof import("../../src/core/chat/delivery-policy.js")
>("dist/core/chat/delivery-policy.js");

test("chat delivery policy keeps terminal output visible and defers only occupied passive delivery", () => {
  assert.equal(policy.shouldSuppressQuietDelivery(true, "final"), false);
  assert.equal(policy.shouldSuppressQuietDelivery(true, "error"), false);
  assert.equal(policy.shouldSuppressQuietDelivery(true, "interim"), true);
  assert.equal(
    policy.shouldSuppressQuietDelivery(false, "passive_notice"),
    false,
  );

  assert.equal(
    policy.shouldDeferPassiveNotice({
      hasActiveTurn: false,
      awaitingTurnSettle: false,
      hasStagedDelivery: false,
    }),
    false,
  );
  assert.equal(
    policy.shouldDeferPassiveNotice({
      hasActiveTurn: true,
      awaitingTurnSettle: false,
      hasStagedDelivery: false,
    }),
    true,
  );
  assert.equal(
    policy.shouldDeferPassiveNotice({
      hasActiveTurn: false,
      awaitingTurnSettle: true,
      hasStagedDelivery: false,
    }),
    true,
  );
});

test("chat delivery presenter normalizes the latest summary and interim prefix", () => {
  assert.equal(
    policy.normalizeAssistantSummaryText(
      "Earlier detail\n\n**Latest**   `summary`",
    ),
    "Latest summary",
  );
  assert.equal(policy.normalizeAssistantSummaryText("  "), "");
  assert.equal(policy.presentInterimText(" update ", false), "... update");
  assert.equal(policy.presentInterimText(" update ", true), "update");
});

test("chat delivery outcome has explicit accepted and settled defaults", () => {
  assert.deepEqual(policy.chatDeliveryOutcome(), {
    messageIds: [],
    accepted: true,
    settled: true,
  });
  assert.deepEqual(
    policy.chatDeliveryOutcome(["message-1"], {
      accepted: false,
      settled: false,
    }),
    { messageIds: ["message-1"], accepted: false, settled: false },
  );
});
