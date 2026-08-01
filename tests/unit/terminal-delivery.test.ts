import assert from "node:assert/strict";
import test from "node:test";
import { assistantDeliveryParts } from "../../dist/core/chat/terminal-delivery.js";

test("assistant delivery preserves non-empty final text without media", () => {
  assert.deepEqual(assistantDeliveryParts("final answer", undefined), [
    { type: "text", text: "final answer" },
  ]);
});

test("assistant delivery preserves canonical final text before media", () => {
  const parts = assistantDeliveryParts("final answer", {
    messages: [{ type: "image", url: "https://example.invalid/final.png" }],
  });

  assert.deepEqual(parts, [
    { type: "text", text: "final answer" },
    {
      type: "image",
      url: "https://example.invalid/final.png",
      mimeType: undefined,
    },
  ]);
});

test("assistant delivery omits blank text while preserving media", () => {
  assert.deepEqual(
    assistantDeliveryParts("  \n", {
      messages: [{ type: "file", path: "/tmp/final.txt" }],
    }),
    [
      {
        type: "file",
        path: "/tmp/final.txt",
        name: undefined,
        mimeType: undefined,
      },
    ],
  );
});
