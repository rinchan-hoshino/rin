import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const relevance = await importBuiltModule<
  typeof import("../../src/core/self-improve/relevance.js")
>("dist/core/self-improve/relevance.js");

function doc(overrides: Record<string, unknown> = {}) {
  return {
    id: "search-doc",
    name: "SearXNG Search",
    description: "Private search adapter",
    content: "Use the SearXNG adapter for current sources and search history.",
    self_improve_prompt_slot: "search_policy",
    scope: "project",
    kind: "instruction",
    tags: ["search", "sources"],
    aliases: ["web lookup"],
    exposure: "self_improve_prompts",
    status: "active",
    ...overrides,
  } as any;
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    kind: "tool_result",
    summary: "Search results arrived",
    text: "SearXNG returned current sources",
    tool_name: "browse",
    tags: ["search"],
    created_at: new Date().toISOString(),
    ...overrides,
  } as any;
}

test("self-improve relevance scores lexical and recency evidence", () => {
  const active = doc();
  assert.equal(relevance.lexicalScore("", active), 0);
  assert.equal(
    relevance.lexicalScore(
      "search",
      doc({
        id: "",
        name: "",
        description: "",
        content: "",
        self_improve_prompt_slot: "",
        scope: "",
        kind: "",
        tags: [],
        aliases: [],
        exposure: "",
      }),
    ),
    0,
  );
  assert.ok(relevance.lexicalScore("search-doc", active) > 6);
  assert.ok(relevance.lexicalScore("search_policy", active) > 6);
  assert.ok(relevance.lexicalScore("SearXNG adapter", active) > 0);
  assert.ok(
    relevance.lexicalScore(
      "\u641c\u7d22\u6765\u6e90",
      doc({
        content: "\u641c\u7d22\u6765\u6e90\u4e0e\u641c\u7d22\u7ed3\u679c",
      }),
    ) > 0,
  );
  assert.ok(
    relevance.lexicalScore("search", doc({ status: "superseded" })) <
      relevance.lexicalScore("search", active),
  );
  assert.ok(
    relevance.lexicalScore(
      "recent search history",
      doc({ tags: ["search", "chronicle"] }),
    ) > 0,
  );

  assert.equal(relevance.eventScore("", event()), 0);
  assert.ok(relevance.eventScore("search", event()) > 0);
  assert.ok(
    relevance.eventScore(
      "search",
      event({
        created_at: new Date(Date.now() - 96 * 3_600_000).toISOString(),
      }),
    ) < relevance.eventScore("search", event()),
  );
  assert.ok(
    Number.isFinite(
      relevance.eventScore("search", event({ created_at: "invalid" })),
    ),
  );
});

test("self-improve recall excerpts preserve useful local context", () => {
  assert.equal(
    relevance.excerptForRecall(doc({ description: "", content: "" }), "x"),
    "",
  );
  assert.equal(
    relevance.excerptForRecall(
      doc({ description: "short", content: "" }),
      "",
      20,
    ),
    "short",
  );

  const long = doc({
    description: "prefix ".repeat(20),
    content: `${"before ".repeat(20)}needle ${"after ".repeat(20)}`,
  });
  const aroundNeedle = relevance.excerptForRecall(long, "needle", 60);
  assert.ok(aroundNeedle.includes("needle"));
  assert.ok(aroundNeedle.startsWith("…"));
  assert.ok(aroundNeedle.endsWith("…"));
  assert.ok(relevance.excerptForRecall(long, "missing", 40).length <= 41);
});

test("self-improve relation scoring explains the strongest shared feature", () => {
  assert.equal(
    relevance.relationScore(doc(), doc({ id: "other" })).reason,
    "shared-tags",
  );
  assert.equal(
    relevance.relationScore(
      doc({ tags: [], aliases: [], scope: "a", kind: "a" }),
      doc({ id: "b", tags: [], aliases: [], scope: "b", kind: "b" }),
    ).reason,
    "shared-concepts",
  );
  assert.equal(
    relevance.relationScore(
      doc({
        name: "Alpha",
        description: "",
        content: "",
        tags: [],
        aliases: [],
        scope: "same",
        kind: "a",
      }),
      doc({
        id: "b",
        name: "Beta",
        description: "",
        content: "",
        tags: [],
        aliases: [],
        scope: "same",
        kind: "b",
      }),
    ).reason,
    "shared-scope",
  );
  assert.equal(
    relevance.relationScore(
      doc({
        name: "Alpha",
        description: "",
        content: "",
        tags: [],
        aliases: [],
        scope: "a",
        kind: "same",
      }),
      doc({
        id: "b",
        name: "Beta",
        description: "",
        content: "",
        tags: [],
        aliases: [],
        scope: "b",
        kind: "same",
      }),
    ).reason,
    "shared-kind",
  );
  assert.equal(
    relevance.relationScore(
      doc({
        name: "Alpha",
        description: "",
        content: "",
        tags: [],
        aliases: [],
        scope: "a",
        kind: "a",
      }),
      doc({
        id: "b",
        name: "Beta",
        description: "",
        content: "",
        tags: [],
        aliases: [],
        scope: "b",
        kind: "b",
      }),
    ).reason,
    "",
  );
});

test("self-improve relevance recognizes history intent and active documents", () => {
  assert.equal(
    relevance.shouldInjectRecentHistory("what happened just now"),
    true,
  );
  assert.equal(relevance.shouldInjectRecentHistory("ordinary lookup"), false);
  assert.deepEqual(relevance.activeDocsOnly(null as any), []);
  const active = doc();
  assert.deepEqual(
    relevance.activeDocsOnly([
      active,
      doc({ id: "old", status: "archived" }),
      null as any,
    ]),
    [active],
  );
});
