import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const schema = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "core", "schema.js"),
  ).href
);

test("memory schema parses and renders markdown docs consistently", () => {
  const doc = schema.parseMarkdownDoc(
    "/tmp/demo.md",
    `---\nname: Demo\nexposure: self_improve_prompts\nself_improve_prompt_slot: core_doctrine\ntags:\n  - one\n  - two\n---\nhello world\n`,
  );
  assert.equal(doc.name, "Demo");
  assert.deepEqual(doc.tags, ["one", "two"]);
  const rendered = schema.renderMarkdownDoc(doc);
  assert.ok(rendered.includes("name: Demo"));
  assert.ok(rendered.includes("exposure: self_improve_prompts"));
  assert.ok(rendered.includes("hello world"));
});

test("memory schema normalizes defaults for memory prompt docs", () => {
  const doc = schema.normalizeFrontmatter(
    {
      exposure: "self_improve_prompts",
      self_improve_prompt_slot: "user_profile",
      content: "",
    },
    "/tmp/x.md",
    "hello",
  );
  assert.equal(doc.scope, "global");
  assert.equal(doc.kind, "instruction");
  assert.equal(doc.self_improve_prompt_slot, "user_profile");
});
