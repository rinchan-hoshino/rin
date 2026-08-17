import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function read(relativePath: string) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function listTypeScriptFiles(relativePath: string): string[] {
  const directory = path.join(rootDir, relativePath);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(child);
    return entry.isFile() && entry.name.endsWith(".ts")
      ? [path.join(rootDir, child)]
      : [];
  });
}

test("backend runtime does not depend on frontend implementation modules", () => {
  for (const relative of [
    "src/core/rin-daemon",
    "src/core/rin-lib",
    "src/core/session",
  ]) {
    for (const file of listTypeScriptFiles(relative)) {
      const fileRelative = path.relative(rootDir, file);
      const source = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(
        source,
        /(?:from|import\()\s*["'][^"']*rin-frontend-sdk\//,
        fileRelative,
      );
    }
  }
});

test("backend core tools do not own TUI presentation", () => {
  const backendFiles = [
    "src/core/memory/index.ts",
    "src/core/rin-lib/item-tool.ts",
    "src/core/rin-lib/todo.ts",
  ];

  for (const relativePath of backendFiles) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /@earendil-works\/pi-tui/);
    assert.doesNotMatch(source, /\brender(?:Call|Result|Shell)\s*:/);
  }
});

test("RPC frontend does not assemble backend capabilities for presentation", () => {
  const source = read("src/core/rin-tui/runtime.ts");
  assert.doesNotMatch(source, /createRinCapabilityDefinitions/);
  assert.doesNotMatch(source, /coreToolDefinitions/);
});

test("backend runtime cannot import TUI presentation dependencies", () => {
  const backendRoots = [
    "src/core/rin-daemon",
    "src/core/rin-lib",
    "src/core/session",
    "src/core/memory",
  ];
  const offenders = backendRoots
    .flatMap(listTypeScriptFiles)
    .flatMap((filePath) => {
      const text = fs.readFileSync(filePath, "utf8");
      return /@earendil-works\/pi-tui|\/rin-tui\//.test(text)
        ? [path.relative(rootDir, filePath)]
        : [];
    });
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(
    read("src/core/rin-daemon/worker-helpers.ts"),
    /commandResponses|Available sessions:|Available models:|Session ID:|Model set to:/,
  );
});

test("error presentation is frontend-neutral and not owned by a backend module", () => {
  for (const relative of [
    "src/app/rin-daemon",
    "src/app/rin-install",
    "src/core/rin-install",
  ]) {
    for (const file of listTypeScriptFiles(relative)) {
      assert.doesNotMatch(
        fs.readFileSync(file, "utf8"),
        /rin-frontend-sdk\/error-presentation/,
        path.relative(rootDir, file),
      );
    }
  }
});

test("neutral backend storage does not own runtime or chat error presentation", () => {
  const outbox = read("src/core/chat/outbox.ts");
  assert.doesNotMatch(outbox, /formatRuntimeErrorForFrontend/);
  assert.doesNotMatch(outbox, /formatChatOutboxErrorParts/);
});
