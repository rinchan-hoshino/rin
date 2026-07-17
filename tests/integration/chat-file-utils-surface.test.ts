import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const fileUtils = await importBuiltModule<
  typeof import("../../src/core/chat/file-utils.js")
>("dist/core/chat/file-utils.js");
const chatSupport = await importBuiltModule<
  typeof import("../../src/core/chat/support.js")
>("dist/core/chat/support.js");
const runtimeCommon = await importBuiltModule<
  typeof import("../../src/core/chat-runtime/common.js")
>("dist/core/chat-runtime/common.js");

test("chat file utility re-exports share the canonical implementation", () => {
  assert.equal(
    chatSupport.extensionFromMimeType,
    fileUtils.extensionFromMimeType,
  );
  assert.equal(chatSupport.ensureExtension, fileUtils.ensureExtension);
  assert.equal(runtimeCommon.extensionFromMimeType("text/html"), ".txt");
  assert.equal(
    runtimeCommon.ensureExtension("notes", "text/markdown"),
    "notes.md",
  );
  assert.equal(runtimeCommon.isImageName("demo.SVG?download=1"), true);
});
