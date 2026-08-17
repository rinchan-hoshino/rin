import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const estimator = await importBuiltModule<
  typeof import("../../src/core/rin-lib/context-token-estimator.js")
>("dist/core/rin-lib/context-token-estimator.js");

test("context token calculation accepts Pi usage and rejects unusable inputs", () => {
  assert.equal(estimator.calculateContextTokens(null), 0);
  assert.equal(estimator.calculateContextTokens("bad"), 0);
  assert.equal(
    estimator.calculateContextTokens({
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 1,
    }),
    10,
  );
  assert.equal(
    estimator.calculateContextTokens({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }),
    0,
  );

  const throwingUsage = new Proxy(
    {},
    {
      get() {
        throw new Error("usage getter failed");
      },
    },
  );
  assert.equal(estimator.calculateContextTokens(throwingUsage), 0);
});

test("message token estimation supports assistant strings and Pi message shapes", () => {
  assert.equal(estimator.estimateMessageTokens(null), 0);
  assert.equal(estimator.estimateMessageTokens("invalid"), 0);

  const assistantString = estimator.estimateMessageTokens({
    role: "assistant",
    content: "12345678",
  });
  const assistantParts = estimator.estimateMessageTokens({
    role: "assistant",
    content: [{ type: "text", text: "12345678" }],
  });
  assert.equal(assistantString, assistantParts);
  assert.ok(assistantString > 0);
  assert.ok(
    estimator.estimateMessageTokens({ role: "user", content: "hello world" }) >
      0,
  );

  const throwingMessage = {
    role: "user",
    get content() {
      throw new Error("message getter failed");
    },
  };
  assert.equal(estimator.estimateMessageTokens(throwingMessage), 0);
});

test("context token estimation reuses successful assistant usage then estimates the remainder", () => {
  const fromUsage = estimator.estimateContextTokens([
    {
      role: "assistant",
      content: "done",
      usage: { input: 5, output: 4, cacheRead: 3, cacheWrite: 0 },
    },
    { role: "user", content: "follow up" },
  ] as any);
  const estimatedOnly = estimator.estimateContextTokens([
    { role: "assistant", content: "done" },
    { role: "user", content: "follow up" },
  ] as any);

  assert.ok(fromUsage >= 12);
  assert.ok(estimatedOnly > 0);
  assert.notEqual(fromUsage, estimatedOnly);
  assert.equal(estimator.estimateContextTokens([]), 0);
});
