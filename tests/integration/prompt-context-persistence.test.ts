import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const { formatPromptContextSystemPromptBlock } = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/prompt-context.js")
>("dist/core/rin-frontend-sdk/prompt-context.js");
const { appendPromptContextSystemPrompt, persistPromptContextSystemPrompt } =
  await importBuiltModule<typeof import("../../src/core/rin-lib/runtime.js")>(
    "dist/core/rin-lib/runtime.js",
  );

test("prompt context system blocks persist only the latest binding state", () => {
  const entries: any[] = [];
  const session = {
    sessionManager: {
      getBranch: () => entries,
      appendCustomEntry(customType: string, data: any) {
        entries.push({ type: "custom", customType, data });
      },
    },
  };
  const meta = {
    source: "chat-bridge",
    chatKey: "telegram/1:2",
    chatName: "Original room",
    chatType: "group",
    userId: "guest-1",
    nickname: "Guest",
    identity: "OTHER",
  };

  const next = persistPromptContextSystemPrompt(session, "Base prompt", meta);
  assert.ok(next.startsWith("Base prompt\n\nChat context:"));
  assert.equal(next.includes("- sender user id:"), false);
  assert.deepEqual(entries, [
    {
      type: "custom",
      customType: "rin-system-prompt-blocks",
      data: {
        version: 1,
        blocks: [formatPromptContextSystemPromptBlock(meta)],
      },
    },
  ]);

  const repeated = persistPromptContextSystemPrompt(session, next, meta);
  assert.equal(repeated, next);
  assert.equal(entries.length, 1);

  const renamedMeta = { ...meta, chatName: "Renamed room" };
  const replaced = persistPromptContextSystemPrompt(
    session,
    repeated,
    renamedMeta,
  );
  assert.equal(replaced.includes("Original room"), false);
  assert.equal(replaced.includes("Renamed room"), true);
  assert.deepEqual(entries.at(-1), {
    type: "custom",
    customType: "rin-system-prompt-blocks",
    data: {
      version: 1,
      blocks: [formatPromptContextSystemPromptBlock(renamedMeta)],
    },
  });

  const combined = appendPromptContextSystemPrompt("Base prompt", meta);
  assert.ok(combined.includes("Chat context:"));
  assert.equal(combined.includes("- sender user id:"), false);
});
