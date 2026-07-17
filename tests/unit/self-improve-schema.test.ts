import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

type ParsedDoc = {
  id: string;
  name: string;
  exposure: string;
  fidelity: string;
  self_improve_prompt_slot: string;
  description: string;
  tags: string[];
  aliases: string[];
  scope: string;
  kind: string;
  sensitivity: string;
  source: string;
  updated_at: string;
  last_observed_at: string;
  observation_count: number;
  status: string;
  supersedes: string[];
  canonical: boolean;
  path: string;
  content: string;
};
const schema = await importBuiltModule<{
  parseMarkdownDoc(file: string, content: string): ParsedDoc;
  renderMarkdownDoc(doc: ParsedDoc): string;
  normalizeFrontmatter(
    frontmatter: Record<string, unknown>,
    file: string,
    content: string,
  ): ParsedDoc;
  ensureExposure(value: string, fallback?: string): string;
  ensureFidelity(value: string, fallback?: string): string;
  ensureScope(value: string, fallback?: string): string;
  ensureKind(value: string, fallback?: string): string;
  ensureStatus(value: string, fallback?: string): string;
  previewSelfImproveDoc(doc: ParsedDoc): Record<string, unknown>;
}>("dist/core/self-improve/core/schema.js");

test("self-improve schema parses and renders canonical Markdown documents", () => {
  const doc = schema.parseMarkdownDoc(
    "/tmp/demo.md",
    `---\nname: Demo\nexposure: self_improve_prompts\nself_improve_prompt_slot: core_doctrine\ntags:\n  - one\n  - two\n---\nhello world\n`,
  );
  assert.equal(doc.name, "Demo");
  assert.deepEqual(doc.tags, ["one", "two"]);
  const rendered = schema.renderMarkdownDoc(doc);
  assert.match(rendered, /name: Demo/);
  assert.match(rendered, /exposure: self_improve_prompts/);
  assert.match(rendered, /hello world/);
  assert.deepEqual(schema.parseMarkdownDoc("/tmp/demo.md", rendered).tags, [
    "one",
    "two",
  ]);
});

test("self-improve schema normalizes missing frontmatter to explicit defaults", () => {
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
  assert.equal(doc.fidelity, "fuzzy");
  assert.equal(doc.status, "active");
  assert.equal(doc.self_improve_prompt_slot, "user_profile");
  assert.equal(doc.content, "hello");
});

test("self-improve schema validates every frontmatter enum and legacy kind", () => {
  assert.equal(
    schema.ensureExposure(" self_improve_prompts "),
    "self_improve_prompts",
  );
  assert.equal(
    schema.ensureExposure("self_improve_skills"),
    "self_improve_skills",
  );
  assert.equal(schema.ensureExposure(""), "self_improve_skills");
  assert.equal(
    schema.ensureExposure("bad", "self_improve_prompts"),
    "self_improve_prompts",
  );

  for (const value of ["exact", "fuzzy"])
    assert.equal(schema.ensureFidelity(value), value);
  assert.equal(schema.ensureFidelity("bad", "exact"), "exact");
  for (const value of ["global", "domain", "project", "session"]) {
    assert.equal(schema.ensureScope(value), value);
  }
  assert.equal(schema.ensureScope("bad", "domain"), "domain");
  for (const value of ["skill", "instruction", "rule", "fact", "index"]) {
    assert.equal(schema.ensureKind(value), value);
  }
  for (const value of ["identity", "style", "method", "value", "preference"]) {
    assert.equal(schema.ensureKind(value), "instruction");
  }
  for (const value of ["knowledge", "history"])
    assert.equal(schema.ensureKind(value), "fact");
  assert.equal(schema.ensureKind("bad", "index"), "index");
  for (const value of ["active", "superseded", "invalidated"]) {
    assert.equal(schema.ensureStatus(value), value);
  }
  assert.equal(schema.ensureStatus("bad", "superseded"), "superseded");
});

test("self-improve schema accepts metadata fallbacks and rejects malformed YAML", () => {
  const doc = schema.normalizeFrontmatter(
    {
      title: "Metadata title",
      description: " description ",
      summary: "ignored",
      metadata: {
        id: "meta-id",
        exposure: "self_improve_skills",
        fidelity: "exact",
        tags: ["one"],
        aliases: "two, three",
        scope: "session",
        kind: "rule",
        sensitivity: "private",
        source: "owner",
        updated_at: "2026-01-01T00:00:00.000Z",
        last_observed_at: "2026-01-02T00:00:00.000Z",
        observation_count: 0,
        status: "superseded",
        supersedes: ["old"],
        canonical: false,
      },
    },
    "/tmp/meta.md",
    "body",
  );
  assert.equal(doc.name, "Metadata title");
  assert.equal(doc.id, "meta-id");
  assert.equal(doc.scope, "session");
  assert.equal(doc.kind, "rule");
  assert.equal(doc.observation_count, 1);
  assert.equal(doc.canonical, false);
  assert.deepEqual(doc.aliases, ["two", "three"]);
  assert.equal(
    schema.parseMarkdownDoc("/tmp/plain.md", " plain ").content,
    "plain",
  );
  assert.equal(
    schema.parseMarkdownDoc("/tmp/bad.md", "---\n: bad: yaml\n---\nbody")
      .content,
    "body",
  );
});

test("self-improve schema renders and previews complete optional metadata", () => {
  const doc = schema.normalizeFrontmatter(
    {
      name: "Full",
      id: "full",
      exposure: "self_improve_prompts",
      self_improve_prompt_slot: "agent_profile",
      description: "desc",
      tags: ["tag"],
      aliases: ["alias"],
      scope: "global",
      kind: "instruction",
      sensitivity: "private",
      source: "owner",
      updated_at: "2026-01-01T00:00:00.000Z",
      last_observed_at: "2026-01-02T00:00:00.000Z",
      observation_count: 2,
      status: "active",
      supersedes: ["old"],
      canonical: true,
    },
    "/tmp/full.md",
    "  long body  ",
  );
  const rendered = schema.renderMarkdownDoc(doc);
  for (const value of [
    "description: desc",
    "aliases:",
    "source: owner",
    "supersedes:",
  ]) {
    assert.match(rendered, new RegExp(value));
  }
  assert.deepEqual(schema.previewSelfImproveDoc(doc), {
    id: "full",
    name: "Full",
    exposure: "self_improve_prompts",
    fidelity: "fuzzy",
    self_improve_prompt_slot: "agent_profile",
    description: "desc",
    tags: ["tag"],
    aliases: ["alias"],
    scope: "global",
    kind: "instruction",
    sensitivity: "private",
    source: "owner",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_observed_at: "2026-01-02T00:00:00.000Z",
    observation_count: 2,
    status: "active",
    supersedes: ["old"],
    canonical: true,
    path: "/tmp/full.md",
    preview: "long body",
  });
});
