import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const externalResults = await importBuiltModule<
  typeof import("../../src/core/memory/external-results.js")
>("dist/core/memory/external-results.js");

test("external memory limits normalize missing, invalid, and bounded values", () => {
  assert.equal(externalResults.normalizeExternalMemoryLimit(undefined), 8);
  assert.equal(externalResults.normalizeExternalMemoryLimit(0, 5), 5);
  assert.equal(externalResults.normalizeExternalMemoryLimit("3"), 3);
  assert.equal(externalResults.normalizeExternalMemoryLimit(-4), 1);
  assert.equal(externalResults.normalizeExternalMemoryLimit("invalid", 6), 6);
});

test("external memory results accept arrays and wrapped provider results", () => {
  assert.deepEqual(externalResults.normalizeExternalMemoryResults(null), []);
  assert.deepEqual(externalResults.normalizeExternalMemoryResults({}), []);
  assert.deepEqual(
    externalResults.normalizeExternalMemoryResults({ results: [null, "bad"] }),
    [],
  );

  assert.deepEqual(
    externalResults.normalizeExternalMemoryResults(
      {
        results: [
          {
            externalId: " ext-1 ",
            summary: " Summary ",
            score: "7.5",
            messages: "not-an-array",
          },
        ],
      },
      { provider: " remote ", providerName: "Remote Memory" },
    ),
    [
      {
        externalId: " ext-1 ",
        summary: " Summary ",
        score: 7.5,
        messages: undefined,
        sourceType: "external",
        provider: "remote",
        id: "ext-1",
        name: "Summary",
      },
    ],
  );
});

test("external memory results apply stable identity, names, scores, and message defaults", () => {
  const results = externalResults.normalizeExternalMemoryResults(
    [
      {
        provider: " alpha ",
        id: " row-id ",
        name: " Row name ",
        score: 0,
        sourceType: "local",
        messages: [
          null,
          { text: "   " },
          { text: " message one ", extra: true },
          {
            id: " msg-2 ",
            toolName: " read ",
            role: " assistant ",
            timestamp: " 2026-01-01 ",
            line: "4",
            text: " message two ",
          },
        ],
      },
      {
        reference: " ref-2 ",
        description: " Description ",
        score: "not-a-number",
      },
      {
        url: " https://example.invalid/3 ",
        preview: " Preview ",
      },
      {},
    ],
    { provider: "fallback", providerName: " Provider Label ", startScore: 10 },
  );

  assert.deepEqual(results[0], {
    provider: "alpha",
    id: "row-id",
    name: "Row name",
    score: 0,
    sourceType: "external",
    messages: [
      {
        text: "message one",
        extra: true,
        role: "memory",
        timestamp: "",
        line: 1,
      },
      {
        id: "msg-2",
        toolName: "read",
        role: "assistant",
        timestamp: "2026-01-01",
        line: 4,
        text: "message two",
      },
    ],
  });
  assert.deepEqual(results[1], {
    reference: " ref-2 ",
    description: " Description ",
    score: 9,
    sourceType: "external",
    provider: "fallback",
    id: "ref-2",
    name: "Description",
    messages: undefined,
  });
  assert.equal(results[2]?.id, "https://example.invalid/3");
  assert.equal(results[2]?.name, "Preview");
  assert.equal(results[2]?.score, 8);
  assert.equal(results[3]?.id, "fallback:4");
  assert.equal(results[3]?.name, "Provider Label memory");
  assert.equal(results[3]?.score, 7);
});

test("external memory result fallbacks cover blank defaults and invalid message fields", () => {
  const [result] = externalResults.normalizeExternalMemoryResults(
    [
      {
        messages: [
          {
            id: " ",
            toolName: " ",
            role: " ",
            timestamp: null,
            line: -2,
            text: "kept",
          },
        ],
      },
    ],
    { provider: " ", providerName: " ", startScore: 0 },
  );

  assert.equal(result?.provider, "external");
  assert.equal(result?.id, "external:1");
  assert.equal(result?.name, "external memory");
  assert.equal(result?.score, 1);
  assert.deepEqual(result?.messages, [
    {
      id: " ",
      toolName: " ",
      role: "memory",
      timestamp: "",
      line: 1,
      text: "kept",
    },
  ]);
});
