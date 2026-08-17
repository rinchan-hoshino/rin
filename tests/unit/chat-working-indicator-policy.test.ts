import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const policy = await importBuiltModule<
  typeof import("../../src/core/chat/working-indicator-policy.js")
>("dist/core/chat/working-indicator-policy.js");
type WorkingIndicator =
  import("../../src/core/chat/working-indicator-policy.js").WorkingIndicator;

test("working indicator policy selects one visible presentation beside every typing heartbeat", () => {
  const typing = { type: "polling", presentation: "typing", name: "typing" };
  const message = {
    type: "polling",
    presentation: "message",
    name: "message",
  };
  const reaction = {
    type: "polling",
    presentation: "reaction",
    name: "reaction",
  };
  const editable = {
    type: "polling",
    presentation: "editable-message",
    name: "editable",
  };
  const legacy = { type: "polling", name: "legacy", priority: 999 };
  const marker = { type: "marker", presentation: "reaction", name: "marker" };
  const indicators = [
    typing,
    message,
    reaction,
    editable,
    legacy,
    marker,
  ] as WorkingIndicator[];

  assert.deepEqual(
    policy.selectTypingIndicatorsForKind(indicators, "polling"),
    [typing],
  );
  assert.deepEqual(
    policy.selectVisibleWorkingIndicatorsForKind(indicators, "polling"),
    [editable],
  );
  assert.deepEqual(
    policy.selectWorkingIndicatorsForKind(indicators, "polling"),
    [typing, editable],
  );
  assert.deepEqual(policy.selectWorkingIndicatorsForEnd(indicators), [
    editable,
  ]);
  assert.equal(policy.findEditableWorkingIndicator(indicators), editable);
  assert.deepEqual(policy.workingIndicatorPolicy(indicators), {
    polling: true,
    marker: false,
  });
  assert.deepEqual(
    policy.workingIndicatorPolicy([marker as WorkingIndicator]),
    {
      polling: false,
      marker: true,
    },
  );
});

test("working indicator policy normalizes capabilities and honors explicit priority", () => {
  const legacy = { kind: "polling", name: "legacy" };
  const highMessage = {
    kind: "polling",
    capability: "message",
    priority: 500,
  };
  const editable = { kind: "polling", capability: "editable-message" };
  const normalized = policy.normalizeWorkingIndicators([
    null,
    {},
    { type: "unknown" },
    legacy,
    highMessage,
    editable,
  ]);

  assert.deepEqual(normalized, [legacy, highMessage, editable]);
  assert.equal(policy.workingIndicatorKind(legacy), "polling");
  assert.equal(policy.workingIndicatorPresentation(legacy), "legacy");
  assert.equal(policy.workingIndicatorPresentation(highMessage), "message");
  assert.deepEqual(
    policy.selectVisibleWorkingIndicatorsForKind(normalized, "polling"),
    [highMessage],
  );
  assert.equal(policy.findEditableWorkingIndicator(normalized), undefined);
});

test("working indicator heartbeat policy applies platform cadence without hidden clocks", () => {
  assert.equal(policy.workingIndicatorPollIntervalMs("telegram"), 4_000);
  assert.equal(policy.workingIndicatorPollIntervalMs("discord"), 9_000);
  assert.equal(policy.workingIndicatorPollIntervalMs("external"), 30_000);
  assert.equal(policy.isWorkingIndicatorPollDue("discord", 0, 1), true);
  assert.equal(
    policy.isWorkingIndicatorPollDue("discord", 1_000, 9_999),
    false,
  );
  assert.equal(
    policy.isWorkingIndicatorPollDue("discord", 1_000, 10_000),
    true,
  );
});
