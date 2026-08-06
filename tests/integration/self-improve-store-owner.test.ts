import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const store = await importBuiltModule<
  typeof import("../../src/core/self-improve/store.js")
>("dist/core/self-improve/store.js");
const core = await importBuiltModule<
  typeof import("../../src/core/self-improve/core/index.js")
>("dist/core/self-improve/core/index.js");

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-self-store-owner-"),
  );
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("self-improve store owns its layout and public core barrel", async () => {
  await withTempRoot(async (root) => {
    assert.equal(core.ensureSelfImproveLayout, store.ensureSelfImproveLayout);
    assert.equal(
      await core.ensureSelfImproveLayout(root),
      path.join(root, "self_improve"),
    );
    for (const directory of ["prompts", "skills", "state"]) {
      assert.equal(
        (
          await fs.stat(path.join(root, "self_improve", directory))
        ).isDirectory(),
        true,
      );
    }
    assert.deepEqual(await store.loadActiveSelfImproveDocs(root), []);
  });
});

test("self-improve store saves, loads, compiles, and removes prompt contracts", async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      store.saveSelfImprovePromptDoc(
        { selfImprovePromptSlot: "agent_profile", content: "  " },
        root,
      ),
      /self_improve_content_required/,
    );
    await assert.rejects(
      store.saveSelfImprovePromptDoc({ content: "Missing slot." }, root),
      /self_improve_prompt_slot_required/,
    );

    const saved = await store.saveSelfImprovePromptDoc(
      {
        selfImprovePromptSlot: "agent_profile",
        content: "Speak plainly.\n- Keep exact evidence.",
        name: " Owner profile ",
        description: " direct contract ",
        tags: ["owner", "owner"],
        aliases: ["voice"],
        scope: "project",
        kind: "rule",
        fidelity: "fuzzy",
        sensitivity: " private ",
        source: "test",
        observationCount: 3,
        supersedes: ["older"],
      },
      root,
    );
    assert.equal(saved.status, "ok");
    assert.equal(saved.action, "save_self_improve_prompt");
    assert.equal(saved.doc.name, "Owner profile");
    assert.equal(saved.doc.preview, "- Speak plainly.\n- Keep exact evidence.");

    const defaults = await store.executeSelfImproveAction(
      {
        action: "save_self_improve_prompt",
        selfImprovePromptSlot: "user_profile",
        content: "Use the accepted title.",
        observationCount: "bad",
        sensitivity: " ",
      },
      root,
    );
    assert.equal(defaults.doc.id, "user-profile");
    assert.equal(defaults.doc.name, "user profile");
    assert.equal(defaults.doc.observation_count, 1);

    const docs = await store.loadActiveSelfImproveDocs(root);
    assert.deepEqual(docs.map((doc) => doc.self_improve_prompt_slot).sort(), [
      "agent_profile",
      "user_profile",
    ]);

    const compiled = await store.compileSelfImprove(
      { query: "owner", domainQuery: "tests" },
      root,
    );
    assert.equal(compiled.query, "owner");
    assert.equal(compiled.domain_query, "tests");
    assert.match(compiled.self_improve_prompt_context, /\[agent_profile\]/);
    assert.equal(
      store.compileSelfImproveSync({}, root).self_improve_prompt_prompt_docs
        .length,
      2,
    );
    assert.equal(
      store.compileSelfImproveSync({}, path.join(root, "missing"))
        .self_improve_prompt_context,
      "",
    );
    assert.equal(
      (await store.executeSelfImproveAction({ action: "compile" }, root))
        .self_improve_prompt_prompt_docs.length,
      2,
    );

    await assert.rejects(
      store.removeSelfImprovePromptDoc(
        { selfImprovePromptSlot: "invalid" },
        root,
      ),
      /self_improve_prompt_slot_required/,
    );
    const removed = await store.executeSelfImproveAction(
      { action: "remove_self_improve_prompt", residentSlot: "user_profile" },
      root,
    );
    assert.equal(removed.selfImprovePromptSlot, "user_profile");
    await fs.access(removed.path).then(
      () => assert.fail("removed prompt still exists"),
      (error: NodeJS.ErrnoException) => assert.equal(error.code, "ENOENT"),
    );

    await assert.rejects(
      store.executeSelfImproveAction({ action: "unknown" }, root),
      /unsupported_self_improve_action:unknown/,
    );
  });
});
