import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertProperty, fc } from "../../scripts/test/property-check.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const distRoot =
  process.env.RIN_MUTATION_DIST_ROOT?.trim() || path.join(rootDir, "dist");
const support = await import(
  pathToFileURL(path.join(distRoot, "core/chat/support.js")).href
);
const outbox = await import(
  pathToFileURL(path.join(distRoot, "core/chat/outbox.js")).href
);

const identifier = fc
  .array(
    fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-",
    ),
    {
      minLength: 1,
      maxLength: 24,
    },
  )
  .map((characters) => characters.join(""));

test("property: canonical chat keys round-trip without losing identity", () => {
  assertProperty(
    fc.property(
      identifier,
      identifier,
      identifier,
      (platform, botId, chatId) => {
        const key = support.composeChatKey(
          ` ${platform} `,
          ` ${chatId} `,
          ` ${botId} `,
        );
        assert.deepEqual(support.parseChatKey(key), {
          platform,
          botId,
          chatId,
        });
        assert.equal(support.normalizeChatKey(key), key);
        assert.equal(
          support.composeChatKey(
            support.parseChatKey(key).platform,
            support.parseChatKey(key).chatId,
            support.parseChatKey(key).botId,
          ),
          key,
        );
      },
    ),
  );
});

test("property: normalized outbox payloads are idempotent", () => {
  const part = fc.oneof(
    fc.record({
      type: fc.constant("text"),
      text: fc.string({ maxLength: 80 }),
    }),
    fc.record({
      type: fc.constant("markdown"),
      text: fc.string({ maxLength: 80 }),
    }),
  );
  assertProperty(
    fc.property(
      identifier,
      identifier,
      identifier,
      fc.array(part, { minLength: 1, maxLength: 8 }),
      (platform, botId, chatId, parts) => {
        const chatKey = support.composeChatKey(platform, chatId, botId);
        const first = outbox.normalizeChatOutboxPayload({
          createdAt: "2026-07-27T00:00:00.000Z",
          chatKey,
          parts,
        });
        assert.ok(first);
        assert.deepEqual(outbox.normalizeChatOutboxPayload(first), first);
      },
    ),
  );
});

test("property: legacy reply metadata becomes exactly one leading quote", () => {
  assertProperty(
    fc.property(
      identifier,
      fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 6 }),
      identifier,
      (chatId, texts, replyId) => {
        const payload = outbox.normalizeChatOutboxPayload(
          {
            createdAt: "2026-07-27T00:00:00.000Z",
            chatKey: support.composeChatKey("telegram", chatId, "bot"),
            replyToMessageId: ` ${replyId} `,
            parts: texts.map((text) => ({ type: "text", text })),
          },
          { allowLegacyReplyMetadata: true },
        );
        assert.ok(payload);
        assert.deepEqual(payload.parts[0], { type: "quote", id: replyId });
        assert.equal(
          payload.parts.filter((part) => part.type === "quote").length,
          1,
        );
        assert.equal("replyToMessageId" in payload, false);
      },
    ),
  );
});
