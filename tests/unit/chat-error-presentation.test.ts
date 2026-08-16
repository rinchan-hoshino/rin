import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const presentation = await importBuiltModule<
  typeof import("../../src/core/chat/error-presentation.js")
>("dist/core/chat/error-presentation.js");

test("Chat error presentation preserves structured context and formats text once", () => {
  assert.deepEqual(
    presentation.formatChatErrorParts([
      { type: "image", url: "https://example.com/context.png" },
      { type: "markdown", text: "   " },
      { type: "quote", id: "owner-message" },
      { type: "text", text: "rin_turn_result_recovery_timeout" },
      { type: "at", id: "operator" },
      { type: "markdown", text: "Rin error: follow-up failed" },
      { type: "file", url: "https://example.com/context.txt" },
      { type: "text", text: "final detail" },
    ]),
    [
      { type: "quote", id: "owner-message" },
      { type: "text", text: "Error: turn result recovery timeout" },
      { type: "image", url: "https://example.com/context.png" },
      { type: "at", id: "operator" },
      { type: "markdown", text: "follow-up failed" },
      { type: "file", url: "https://example.com/context.txt" },
      { type: "text", text: "final detail" },
    ],
  );
  assert.deepEqual(
    presentation.formatChatErrorParts([
      { type: "quote", id: "owner-message" },
      { type: "image", url: "https://example.com/error.png" },
    ]),
    [
      { type: "quote", id: "owner-message" },
      { type: "text", text: "Error: unknown error" },
      { type: "image", url: "https://example.com/error.png" },
    ],
  );
  assert.deepEqual(
    presentation.formatChatErrorParts([
      { type: "text", text: "Rin error: rin error: request failed" },
    ]),
    [{ type: "text", text: "Error: request failed" }],
  );

  const parts = [{ type: "quote" as const, id: "owner-message" }];
  assert.equal(
    presentation.hashChatErrorDeliveryContent("request failed", parts),
    presentation.hashChatErrorDeliveryContent("request failed", parts),
  );
  assert.notEqual(
    presentation.hashChatErrorDeliveryContent("request failed", parts),
    presentation.hashChatErrorDeliveryContent("different failure", parts),
  );
  assert.deepEqual(presentation.formatChatErrorDelivery({ text: null }), {
    parts: [],
  });
  assert.deepEqual(
    presentation.formatChatErrorDelivery({
      text: "ignored fallback",
      parts: [undefined as never, { type: "text", text: "explicit failure" }],
    }),
    { parts: [{ type: "text", text: "Error: explicit failure" }] },
  );
});
