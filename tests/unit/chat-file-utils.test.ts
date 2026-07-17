import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const fileUtils = await importBuiltModule<
  typeof import("../../src/core/chat/file-utils.js")
>("dist/core/chat/file-utils.js");

test("chat file utilities normalize MIME extensions", () => {
  const cases = [
    ["image/jpeg", ".jpg"],
    [" IMAGE/JPG ", ".jpg"],
    ["image/png", ".png"],
    ["application/pdf", ".pdf"],
    ["text/plain", ".txt"],
    ["text/markdown; charset=utf-8", ".md"],
    ["application/octet-stream", ""],
    ["", ""],
  ] as const;
  for (const [mimeType, expected] of cases) {
    assert.equal(fileUtils.extensionFromMimeType(mimeType), expected);
  }
  assert.equal(
    fileUtils.extensionFromMimeType("text/html", { allTextMimeTypes: true }),
    ".txt",
  );
  assert.equal(fileUtils.extensionFromMimeType("text/html"), "");
});

test("chat file utilities sanitize and decode filenames", () => {
  assert.equal(
    fileUtils.ensureFileName("bad:/\\name?*", "fallback"),
    "bad_name_",
  );
  assert.equal(fileUtils.ensureFileName("...", "fallback"), "fallback");
  assert.equal(fileUtils.ensureFileName("", ""), "");
  assert.equal(
    fileUtils.fileNameFromUrl(
      "https://example.com/files/hello%20world.txt?download=1",
      "fallback",
    ),
    "hello world.txt",
  );
  assert.equal(
    fileUtils.fileNameFromUrl("demo.txt?download=1#view", "fallback"),
    "demo.txt",
  );
  assert.equal(
    fileUtils.fileNameFromUrl(
      "https://example.com/files/?download=1#view",
      "fallback",
    ),
    "fallback",
  );
  assert.equal(
    fileUtils.fileNameFromUrl(
      "https://example.com/files/%E0%A4%A.txt",
      "fallback",
    ),
    "%E0%A4%A.txt",
  );
  assert.equal(
    fileUtils.fileNameFromUrl("not a url?x=1#y", "fallback"),
    "not a url",
  );
  assert.equal(
    fileUtils.fileNameFromUrl("https://example.com/", ""),
    "attachment",
  );
});

test("chat file utilities preserve explicit extensions and classify images", () => {
  assert.equal(fileUtils.ensureExtension("notes", "text/markdown"), "notes.md");
  assert.equal(
    fileUtils.ensureExtension("notes", "text/html", { allTextMimeTypes: true }),
    "notes.txt",
  );
  assert.equal(
    fileUtils.ensureExtension("archive.tar.gz", "image/png"),
    "archive.tar.gz",
  );
  assert.equal(
    fileUtils.ensureExtension("notes", "application/octet-stream"),
    "notes",
  );
  assert.equal(fileUtils.isImageMimeType("image/webp"), true);
  assert.equal(fileUtils.isImageMimeType("application/pdf"), false);
  assert.equal(fileUtils.isImageName("demo.SVG?download=1#view"), true);
  assert.equal(fileUtils.isImageName("document.txt"), false);
});
