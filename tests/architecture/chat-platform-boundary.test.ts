import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const chatDir = path.join(rootDir, "src", "core", "chat");
const platformDir = path.join(chatDir, "platform");

function sourceImports(filePath: string) {
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return source.statements
    .filter(ts.isImportDeclaration)
    .flatMap((statement) =>
      ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [],
    );
}

function listTypeScriptFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

test("Chat owns its built-in platform implementations without a parallel adapter subsystem", () => {
  assert.equal(
    fs.existsSync(path.join(rootDir, "src", "core", "chat-runtime")),
    false,
    "chat-runtime must not remain a core concept beside Chat",
  );
  assert.equal(fs.existsSync(path.join(chatDir, "chat.ts")), true);
  assert.equal(fs.existsSync(path.join(platformDir, "telegram.ts")), true);
  assert.equal(fs.existsSync(path.join(platformDir, "discord.ts")), true);

  for (const retired of ["onebot", "lark", "slack", "registry", "adapters"]) {
    assert.equal(
      fs.existsSync(path.join(platformDir, `${retired}.ts`)),
      false,
      `${retired} must not be a built-in Chat platform owner`,
    );
  }

  const platformFiles = new Set(listTypeScriptFiles(platformDir));
  for (const filePath of listTypeScriptFiles(
    path.join(rootDir, "src", "core"),
  )) {
    if (filePath.startsWith(`${chatDir}${path.sep}`)) continue;
    const imports = sourceImports(filePath);
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path
        .resolve(path.dirname(filePath), specifier)
        .replace(/\.js$/, ".ts");
      assert.equal(
        platformFiles.has(resolved),
        false,
        `${path.relative(rootDir, filePath)} must depend on Chat, not a Chat platform leaf`,
      );
    }
  }
});

test("Rin uses Pi extensions only for optional Chat platforms", () => {
  assert.equal(
    fs.existsSync(
      path.join(rootDir, "src", "core", "rin-daemon", "extensions.ts"),
    ),
    false,
    "Rin must not keep a second daemon extension manager",
  );
  const extensionApi = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-extension-api.ts"),
    "utf8",
  );
  for (const retired of [
    "RinDaemonExtensionAPI",
    "RinDaemonExtensionFactory",
    "defineRinDaemonExtension",
    "RinChatAdapterProvider",
  ]) {
    assert.equal(
      extensionApi.includes(retired),
      false,
      `${retired} must be removed`,
    );
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
  );
  for (const dependency of [
    "@larksuiteoapi/node-sdk",
    "@slack/socket-mode",
    "@slack/web-api",
  ]) {
    assert.equal(
      dependency in packageJson.dependencies,
      false,
      `${dependency} belongs outside Rin core`,
    );
  }
});

test("installer has no Chat knowledge", () => {
  const installerRoot = path.join(rootDir, "src", "core", "rin-install");
  const residues = listTypeScriptFiles(installerRoot)
    .filter((filePath) => /chat/i.test(fs.readFileSync(filePath, "utf8")))
    .map((filePath) => path.relative(rootDir, filePath));
  assert.deepEqual(residues, []);
});
