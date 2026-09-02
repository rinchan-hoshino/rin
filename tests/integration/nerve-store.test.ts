import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const nerveStore = await importBuiltModule<
  typeof import("../../src/core/nerve/store.js")
>("dist/core/nerve/store.js");

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "rin-nerve-store-"));
}

const stimulus = {
  id: "owner-event-1",
  producer: "owner-chat",
  sensation: "owner_message",
  body: "hello",
  context: { chatKey: "discord/1:2" },
};

test("nerve store durably owns idempotent stimulus admission and recovery", async () => {
  const agentDir = await tempDir();
  const store = nerveStore.openNerveStore(agentDir);
  try {
    assert.deepEqual(store.enqueue(stimulus), {
      stimulusId: stimulus.id,
      status: "queued",
    });
    assert.deepEqual(store.enqueue(stimulus), {
      stimulusId: stimulus.id,
      status: "duplicate",
    });
    assert.throws(
      () => store.enqueue({ ...stimulus, body: "different" }),
      /nerve_stimulus_id_conflict/,
    );

    const claimed = store.claimNext();
    assert.equal(claimed?.id, stimulus.id);
    assert.equal(claimed?.state, "inflight");
    assert.equal(store.counts().inflight, 1);

    store.close();
    const reopened = nerveStore.openNerveStore(agentDir);
    try {
      assert.equal(reopened.counts().queued, 1);
      const recovered = reopened.claimNext();
      assert.equal(recovered?.id, stimulus.id);
      reopened.markDelivered(stimulus.id);
      assert.deepEqual(reopened.counts(), {
        queued: 0,
        inflight: 0,
        delivered: 1,
      });
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
