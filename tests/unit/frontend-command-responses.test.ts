import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const sdk = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);
const chatResponses = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "command-responses.js"),
  ).href
);

test("frontend SDK owns shared command parsing and builtin response text", () => {
  assert.equal(sdk.frontendCommandNameFromLine("/compact now"), "compact");
  assert.equal(sdk.frontendCommandNameFromLine("plain text"), "");
  assert.deepEqual(sdk.parseFrontendCompactCommand("/compact keep facts"), {
    compact: true,
    customInstructions: "keep facts",
  });
  assert.deepEqual(sdk.parseFrontendCompactCommand("/status"), {
    compact: false,
    customInstructions: undefined,
  });
  assert.equal(sdk.isFrontendAbortCommand("/abort"), true);
  assert.equal(sdk.isFrontendNewSessionCommand("/new"), true);

  const responses = sdk.resolveRinFrontendCommandResponses({
    compact: "done",
    reload: "loaded",
  });
  assert.equal(
    sdk.applyFrontendBuiltinCommandText("compact", {}, responses).text,
    "done",
  );
  assert.equal(
    sdk.applyFrontendBuiltinCommandText(
      "compact",
      { text: "native compact summary must not leak", tokensBefore: 108642 },
      responses,
    ).text,
    "[compaction]\n\nCompacted from 108,642 tokens (ctrl+o to expand)",
  );
  assert.equal(
    sdk.applyFrontendBuiltinCommandText(
      "compact",
      { text: "native compact summary must not leak", tokensBefore: 108642 },
      responses,
      { preferConfiguredText: true },
    ).text,
    "[compaction]\n\nCompacted from 108,642 tokens (ctrl+o to expand)",
  );
  assert.equal(
    sdk.applyFrontendBuiltinCommandText(
      "compact",
      { compactionBusy: true },
      responses,
    ).text,
    "Compaction already in progress.",
  );
  assert.equal(
    sdk.applyFrontendBuiltinCommandText("reload", {}, responses).text,
    "loaded",
  );
});

test("chat command responses are aliases for the shared frontend SDK table", () => {
  assert.equal(
    chatResponses.DEFAULT_CHAT_COMMAND_RESPONSES,
    sdk.DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES,
  );
  assert.deepEqual(
    chatResponses.resolveChatCommandResponses({ new: "fresh" }),
    sdk.resolveRinFrontendCommandResponses({ new: "fresh" }),
  );
});

function listSourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(file);
    return entry.isFile() && entry.name.endsWith(".ts") ? [file] : [];
  });
}

function importOffenders(dir, pattern) {
  return listSourceFiles(dir).flatMap((file) => {
    const text = fs.readFileSync(file, "utf8");
    return pattern.test(text) ? [path.relative(rootDir, file)] : [];
  });
}

test("frontend SDK owns shared frontend implementations without chat or TUI imports", () => {
  const sdkDir = path.join(rootDir, "src", "core", "rin-frontend-sdk");
  assert.deepEqual(
    importOffenders(sdkDir, /from "\.\.\/(?:chat|rin-tui)\b/),
    [],
  );
});

test("chat does not depend on TUI implementation modules", () => {
  const chatDir = path.join(rootDir, "src", "core", "chat");
  assert.deepEqual(importOffenders(chatDir, /from "\.\.\/rin-tui\b/), []);
});

test("TUI shared runtime code does not import chat implementation modules", () => {
  const tuiDir = path.join(rootDir, "src", "core", "rin-tui");
  assert.deepEqual(importOffenders(tuiDir, /from "\.\.\/chat\b/), []);
});

test("old TUI shared frontend module paths do not exist", () => {
  const removedSharedFiles = [
    "frontend-surface.ts",
    "model-settings.ts",
    "rpc-auth.ts",
    "rpc-client.ts",
    "rpc-model-registry.ts",
    "session-helpers.ts",
    "state-utils.ts",
    "stats.ts",
  ];
  const offenders = removedSharedFiles.flatMap((name) => {
    const relative = path.join("src", "core", "rin-tui", name);
    return fs.existsSync(path.join(rootDir, relative)) ? [relative] : [];
  });

  assert.deepEqual(offenders, []);
});
