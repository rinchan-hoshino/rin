import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const chatFileUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "file-utils.js"))
    .href
);
const chatSupport = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href
);
const chatRuntimeCommon = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "common.js"))
    .href
);

function assertSharedMimeParity(mimeType: string, expected: string) {
  assert.equal(chatFileUtils.extensionFromMimeType(mimeType), expected);
  assert.equal(chatSupport.extensionFromMimeType(mimeType), expected);
  assert.equal(chatRuntimeCommon.extensionFromMimeType(mimeType), expected);
}

test("chat file helpers stay consistent across shared and re-exported surfaces", () => {
  const sharedCases = [
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["application/pdf", ".pdf"],
    ["text/plain", ".txt"],
    ["text/markdown; charset=utf-8", ".md"],
    ["application/octet-stream", ""],
  ] as const;

  for (const [mimeType, expected] of sharedCases) {
    assertSharedMimeParity(mimeType, expected);
  }

  assert.equal(
    chatSupport.extensionFromMimeType,
    chatFileUtils.extensionFromMimeType,
  );
  assert.equal(chatSupport.ensureExtension, chatFileUtils.ensureExtension);

  assertSharedMimeParity("text/markdown", ".md");
  assert.equal(chatFileUtils.extensionFromMimeType(" IMAGE/JPG "), ".jpg");

  assert.equal(
    chatFileUtils.ensureFileName("bad:/\\name?*", "fallback"),
    "bad_name_",
  );
  assert.equal(
    chatSupport.fileNameFromUrl(
      "https://example.com/files/hello%20world.txt?download=1",
      "fallback",
    ),
    "hello world.txt",
  );
  assert.equal(
    chatFileUtils.fileNameFromUrl("demo.txt?download=1#view", "fallback"),
    "demo.txt",
  );
  assert.equal(
    chatFileUtils.fileNameFromUrl(
      "https://example.com/files/?download=1#view",
      "fallback",
    ),
    "fallback",
  );
  assert.equal(
    chatFileUtils.fileNameFromUrl(
      "https://example.com/files/%E0%A4%A.txt",
      "fallback",
    ),
    "%E0%A4%A.txt",
  );
  assert.equal(
    chatSupport.ensureExtension("notes", "text/markdown"),
    "notes.md",
  );
  assert.equal(
    chatRuntimeCommon.ensureExtension("notes", "text/markdown"),
    "notes.md",
  );
  assert.equal(
    chatRuntimeCommon.ensureExtension("archive.tar.gz", "image/png"),
    "archive.tar.gz",
  );
  assert.equal(chatFileUtils.isImageMimeType("image/webp"), true);
  assert.equal(chatRuntimeCommon.isImageMimeType("application/pdf"), false);
  assert.equal(chatFileUtils.isImageName("demo.SVG"), true);
  assert.equal(chatRuntimeCommon.isImageName("demo.SVG?download=1"), true);
  assert.equal(chatRuntimeCommon.isImageName("document.txt"), false);
});

test("chat file helpers keep filename fallback, decoding, and extension rules stable", () => {
  assert.equal(
    chatFileUtils.fileNameFromUrl(
      "https://example.com/files/a%20b.txt#view",
      "fallback",
    ),
    "a b.txt",
  );
  assert.equal(
    chatFileUtils.fileNameFromUrl("https://example.com/files/", "fallback"),
    "fallback",
  );
  assert.equal(
    chatFileUtils.fileNameFromUrl("not a url?x=1#y", "fallback"),
    "not a url",
  );
  assert.equal(chatFileUtils.isImageName("demo.SVG?download=1#view"), true);
  assert.equal(
    chatFileUtils.ensureExtension("notes.txt", "text/markdown"),
    "notes.txt",
  );
  assert.equal(chatFileUtils.extensionFromMimeType("text/html"), "");
  assert.equal(chatRuntimeCommon.extensionFromMimeType("text/html"), ".txt");
});
