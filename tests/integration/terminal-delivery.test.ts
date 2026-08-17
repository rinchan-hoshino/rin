import "../support/require-test-sandbox.ts";
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

test("assistant delivery normalizes every terminal message part", () => {
  assert.deepEqual(assistantDeliveryParts("", { messages: null }), []);
  assert.deepEqual(
    assistantDeliveryParts("canonical", {
      messages: [
        { type: "text", text: " original " },
        { type: "text", text: " second " },
        { type: "text", text: " " },
        {
          type: "image",
          path: " /tmp/image.png ",
          url: "https://example.invalid/ignored.png",
          mimeType: " image/png ",
        },
        { type: "image", url: " https://example.invalid/image.jpg " },
        { type: "image", data: " ZGF0YQ== " },
        { type: "image" },
        {
          type: "file",
          path: " /tmp/report.txt ",
          url: " https://example.invalid/report.txt ",
          name: " report ",
          mimeType: " text/plain ",
        },
        { type: "file", url: " https://example.invalid/remote.bin " },
        { type: "file" },
        { type: "unknown" },
      ],
    }),
    [
      { type: "text", text: "canonical" },
      { type: "text", text: "second" },
      { type: "image", path: "/tmp/image.png", mimeType: "image/png" },
      {
        type: "image",
        url: "https://example.invalid/image.jpg",
        mimeType: undefined,
      },
      {
        type: "image",
        url: "data:image/png;base64,ZGF0YQ==",
        mimeType: undefined,
      },
      {
        type: "file",
        path: "/tmp/report.txt",
        url: "https://example.invalid/report.txt",
        name: "report",
        mimeType: "text/plain",
      },
      {
        type: "file",
        url: "https://example.invalid/remote.bin",
        name: undefined,
        mimeType: undefined,
      },
    ],
  );
});
