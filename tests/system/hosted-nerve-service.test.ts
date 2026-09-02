import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";
import { createTestSandbox } from "../support/test-sandbox.js";

test("hosted nerve service starts dormant, routes commands, and stops cleanly", async () => {
  const { createHostedNerveService } = await importBuiltModule(
    "dist/app/rin-daemon/hosted-nerve-service.js",
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hosted-nerve-"));
  const sandbox = await createTestSandbox(root);
  assert.equal(sandbox.env.RIN_DIR, sandbox.agentDir);
  await fs.writeFile(
    path.join(sandbox.agentDir, "settings.json"),
    JSON.stringify({ nerve: { ownerChatKey: "discord/bot:channel" } }),
  );
  const service = createHostedNerveService({ agentDir: sandbox.agentDir });
  try {
    await service.start(async () => {
      throw new Error("frontend connection is lazy until the first stimulus");
    });
    assert.equal(service.getOwnerChatKey(), "discord/bot:channel");
    assert.equal(service.getStatus().ready, true);

    const status = await service.commandRouter({ type: "nerve_status" });
    assert.equal(status.success, true);
    assert.equal(status.data.ready, true);

    const outside = await service.observeChat({
      chatKey: "discord/bot:other",
      messageId: "1",
      trust: "OWNER",
      text: "outside",
    });
    assert.deepEqual(outside, { handled: false, stimulated: false });
  } finally {
    await service.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
  assert.equal(service.getStatus().ready, false);
});
