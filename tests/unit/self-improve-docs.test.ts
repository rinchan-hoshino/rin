import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SelfImproveDoc } from "../../src/core/self-improve/core/types.js";
import { importBuiltModule } from "../support/import-built-module.js";

const docsModule = await importBuiltModule<
  typeof import("../../src/core/self-improve/docs.js")
>("dist/core/self-improve/docs.js");

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-docs-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function promptDoc(overrides: Partial<SelfImproveDoc> = {}): SelfImproveDoc {
  return {
    id: "agent-profile",
    name: "agent profile",
    exposure: "self_improve_prompts",
    fidelity: "exact",
    self_improve_prompt_slot: "agent_profile",
    description: "",
    tags: [],
    aliases: [],
    scope: "global",
    kind: "instruction",
    sensitivity: "normal",
    source: "",
    updated_at: "2026-07-16T00:00:00.000Z",
    last_observed_at: "2026-07-16T00:00:00.000Z",
    observation_count: 1,
    status: "active",
    supersedes: [],
    canonical: true,
    path: "/tmp/agent_profile.md",
    content: "Keep replies concise.",
    ...overrides,
  };
}

test("markdown walking and prompt loading own only valid prompt slots", async () => {
  await withRoot(async (root) => {
    assert.deepEqual(
      await docsModule.walkMarkdownFiles(path.join(root, "missing")),
      [],
    );
    assert.deepEqual(docsModule.loadSelfImproveDocsSync(root), []);

    const prompts = path.join(root, "prompts");
    await fs.mkdir(path.join(prompts, "nested"), { recursive: true });
    await fs.writeFile(
      path.join(prompts, "agent_profile.md"),
      " Agent rule \n",
    );
    await fs.writeFile(path.join(prompts, "user_profile.md"), "   \n");
    await fs.writeFile(path.join(prompts, "notes.md"), "not a prompt slot\n");
    await fs.writeFile(path.join(prompts, "ignored.txt"), "ignored\n");
    await fs.writeFile(
      path.join(prompts, "nested", "core_doctrine.md"),
      "Core rule\n",
    );

    assert.deepEqual(await docsModule.walkMarkdownFiles(prompts), [
      path.join(prompts, "agent_profile.md"),
      path.join(prompts, "nested", "core_doctrine.md"),
      path.join(prompts, "notes.md"),
      path.join(prompts, "user_profile.md"),
    ]);

    const asyncDocs = await docsModule.loadSelfImproveDocs(root);
    assert.deepEqual(
      asyncDocs.map((doc) => [doc.id, doc.content]),
      [
        ["agent-profile", "Agent rule"],
        ["core-doctrine", "Core rule"],
      ],
    );
    const syncDocs = docsModule.loadSelfImproveDocsSync(root);
    assert.deepEqual(
      syncDocs.map((doc) => doc.path),
      asyncDocs.map((doc) => doc.path),
    );
  });
});

test("document resolution supports paths and slot identities without accepting unrelated markdown", async () => {
  await withRoot(async (root) => {
    const prompts = path.join(root, "prompts");
    await fs.mkdir(prompts, { recursive: true });
    const agentPath = path.join(prompts, "agent_profile.md");
    await fs.writeFile(agentPath, "Agent rule\n", "utf8");
    await fs.writeFile(path.join(root, "other.md"), "Other\n", "utf8");

    assert.equal(await docsModule.resolveSelfImproveDoc(root, "  "), null);
    assert.equal(await docsModule.resolveSelfImproveDoc(root, "missing"), null);
    assert.equal(
      await docsModule.resolveSelfImproveDoc(root, path.join(root, "other.md")),
      null,
    );
    assert.equal(
      (await docsModule.resolveSelfImproveDoc(root, "agent-profile"))?.content,
      "Agent rule",
    );
    assert.equal(
      (await docsModule.resolveSelfImproveDoc(root, "agent_profile"))?.id,
      "agent-profile",
    );
    assert.equal(
      (await docsModule.resolveSelfImproveDoc(root, "prompts/agent_profile.md"))
        ?.self_improve_prompt_slot,
      "agent_profile",
    );
    assert.equal(
      (await docsModule.resolveSelfImproveDoc(root, agentPath))?.name,
      "agent profile",
    );
    assert.equal(
      docsModule.selfImprovePromptPath(root, "user_profile"),
      path.join(root, "prompts", "user_profile.md"),
    );
  });
});

test("prompt document validation, writing, and previews enforce durable slot limits", async () => {
  const valid = promptDoc();
  assert.doesNotThrow(() => docsModule.assertSelfImprovePromptDoc(valid));
  assert.throws(
    () =>
      docsModule.assertSelfImprovePromptDoc(
        promptDoc({ self_improve_prompt_slot: "unknown" }),
      ),
    /self_improve_prompt_slot_required/,
  );
  assert.throws(
    () =>
      docsModule.assertSelfImprovePromptDoc(
        promptDoc({ fidelity: "unsupported" as any }),
      ),
    /self_improve_prompt_fidelity_invalid/,
  );
  assert.throws(
    () =>
      docsModule.assertSelfImprovePromptDoc(
        promptDoc({
          content: Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"),
        }),
      ),
    /self_improve_prompt_content_too_long:agent_profile:8/,
  );

  await withRoot(async (root) => {
    const pathToWrite = path.join(root, "nested", "agent_profile.md");
    await docsModule.writeSelfImproveDoc(
      promptDoc({ path: pathToWrite, content: "  Written rule  " }),
    );
    assert.equal(await fs.readFile(pathToWrite, "utf8"), "Written rule\n");
  });

  const previews = docsModule.previewDocs([valid]);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].id, "agent-profile");
});
