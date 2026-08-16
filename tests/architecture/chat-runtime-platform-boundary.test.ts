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
const runtimeDir = "src/core/chat-runtime";
const platforms = ["discord", "slack", "lark", "telegram", "onebot"] as const;

function sourcePath(name: string) {
  return path.join(rootDir, runtimeDir, `${name}.ts`);
}

function parse(name: string) {
  const filePath = sourcePath(name);
  assert.equal(fs.existsSync(filePath), true, `missing ${name}.ts owner`);
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function imports(source: ts.SourceFile) {
  return source.statements
    .filter(ts.isImportDeclaration)
    .map((statement) =>
      ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : "",
    );
}

function namedCommonImports(source: ts.SourceFile) {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "./common.js"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

test("chat runtime keeps app neutral and one registry assembles isolated platform adapters", () => {
  assert.equal(fs.existsSync(sourcePath("adapters")), false);
  assert.equal(fs.existsSync(sourcePath("index")), false);

  const app = parse("app");
  const registry = parse("registry");
  const common = parse("common");
  const platformSources = new Map(platforms.map((name) => [name, parse(name)]));

  const platformSpecifiers = new Set(platforms.map((name) => `./${name}.js`));
  const registryPlatformImports = imports(registry).filter((specifier) =>
    platformSpecifiers.has(specifier as `./${(typeof platforms)[number]}.js`),
  );
  assert.deepEqual(
    [...registryPlatformImports].sort(),
    [...platformSpecifiers].sort(),
    "registry must assemble each built-in platform exactly once",
  );

  for (const source of [app, common]) {
    assert.equal(
      imports(source).some((specifier) =>
        platformSpecifiers.has(specifier as never),
      ),
      false,
      `${path.basename(source.fileName)} must not depend on a platform adapter`,
    );
  }

  const runtimeFiles = fs
    .readdirSync(path.join(rootDir, runtimeDir))
    .filter((name) => name.endsWith(".ts"));
  for (const fileName of runtimeFiles) {
    if (fileName === "registry.ts") continue;
    const source = parse(fileName.slice(0, -3));
    assert.equal(
      imports(source).some((specifier) =>
        platformSpecifiers.has(specifier as never),
      ),
      false,
      `${fileName} must not assemble or depend on another platform`,
    );
  }

  const expectedClassNames = {
    discord: "DiscordAdapter",
    slack: "SlackAdapter",
    lark: "LarkAdapter",
    telegram: "TelegramAdapter",
    onebot: "OneBotAdapter",
  } as const;
  for (const [name, source] of platformSources) {
    const classes = source.statements.filter(ts.isClassDeclaration);
    assert.deepEqual(
      classes.map((declaration) => declaration.name?.text),
      [expectedClassNames[name]],
      `${name}.ts must own exactly its adapter class`,
    );
    assert.equal(
      classes[0]?.heritageClauses?.length ?? 0,
      0,
      `${name}.ts must not introduce an adapter base class`,
    );
    assert.equal(
      imports(source).includes("./registry.js"),
      false,
      `${name}.ts must not register itself`,
    );
  }

  const appText = app.getFullText();
  const commonText = common.getFullText();
  for (const platform of platforms) {
    assert.equal(
      appText.includes(`"${platform}"`) || appText.includes(`'${platform}'`),
      false,
      `app.ts must not branch on ${platform}`,
    );
    assert.equal(
      commonText.includes(`"${platform}"`) ||
        commonText.includes(`'${platform}'`),
      false,
      `common.ts must not branch on ${platform}`,
    );
  }

  const sdkSpecifiers = [
    "grammy",
    "ws",
    "@discordjs/rest",
    "@slack/socket-mode",
    "@slack/web-api",
    "@larksuiteoapi/node-sdk",
  ];
  for (const source of [app, registry, common]) {
    const text = source.getFullText();
    for (const sdk of sdkSpecifiers) {
      assert.equal(
        text.includes(sdk),
        false,
        `${path.basename(source.fileName)} must not own the ${sdk} SDK boundary`,
      );
    }
  }

  const commonConsumers = new Map<string, string[]>();
  for (const [platform, source] of platformSources) {
    for (const name of namedCommonImports(source)) {
      commonConsumers.set(name, [
        ...(commonConsumers.get(name) ?? []),
        platform,
      ]);
    }
  }
  for (const [name, consumers] of commonConsumers) {
    const commonReferences = commonText.match(new RegExp(`\\b${name}\\b`, "g"));
    assert.ok(
      consumers.length >= 2 || (commonReferences?.length ?? 0) > 1,
      `${name} belongs in ${consumers[0]}.ts, not common.ts`,
    );
  }
});
