import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const rootDir = path.resolve(import.meta.dirname, "../..");
const sourcePath = (relativePath: string) => path.join(rootDir, relativePath);

function readSource(relativePath: string) {
  return fs.readFileSync(sourcePath(relativePath), "utf8");
}

function findFunction(sourceFile: ts.SourceFile, name: string) {
  return sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
}

function descendantsOfKind(root: ts.Node, kind: ts.SyntaxKind) {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (node.kind === kind) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

test("RPC mode owns lifecycle while one dispatcher owns command registration", () => {
  const handlerFiles = [
    "src/core/rin-daemon/rpc-extension-ui-command-handler.ts",
    "src/core/rin-daemon/rpc-turn-command-handler.ts",
    "src/core/rin-daemon/rpc-session-command-handler.ts",
    "src/core/rin-daemon/rpc-resource-command-handler.ts",
    "src/core/rin-daemon/rpc-auth-command-handler.ts",
  ];
  const dispatcherPath = "src/core/rin-daemon/rpc-command-dispatcher.ts";
  for (const relativePath of [dispatcherPath, ...handlerFiles]) {
    assert.equal(fs.existsSync(sourcePath(relativePath)), true, relativePath);
  }

  const modeText = readSource("src/core/rin-daemon/rpc-mode.ts");
  const modeSource = ts.createSourceFile(
    "rpc-mode.ts",
    modeText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const runCustomRpcMode = findFunction(modeSource, "runCustomRpcMode");
  assert.ok(
    runCustomRpcMode?.body,
    "runCustomRpcMode must remain lifecycle owner",
  );
  assert.equal(
    descendantsOfKind(runCustomRpcMode.body, ts.SyntaxKind.SwitchStatement)
      .length,
    0,
    "runCustomRpcMode must delegate instead of dispatching business branches",
  );
  assert.match(modeText, /createRpcCommandDispatcher\s*\(/);

  const dispatcherText = readSource(dispatcherPath);
  const dispatcherSource = ts.createSourceFile(
    dispatcherPath,
    dispatcherText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const registries = dispatcherSource.statements.filter(
    (statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "RPC_MODE_COMMAND_REGISTRY",
      ),
  );
  assert.equal(
    registries.length,
    1,
    "RPC command names need one registry owner",
  );
  const registryDeclaration = registries[0].declarationList.declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "RPC_MODE_COMMAND_REGISTRY",
  );
  assert.ok(
    registryDeclaration?.initializer &&
      ts.isObjectLiteralExpression(registryDeclaration.initializer),
    "RPC_MODE_COMMAND_REGISTRY must be a literal auditable registry",
  );
  const commandNames = registryDeclaration.initializer.properties.flatMap(
    (property) => {
      if (!ts.isPropertyAssignment(property)) return [];
      if (ts.isStringLiteralLike(property.name)) return [property.name.text];
      if (ts.isIdentifier(property.name)) return [property.name.text];
      return [];
    },
  );
  assert.equal(commandNames.length, 61);
  assert.equal(new Set(commandNames).size, commandNames.length);

  for (const relativePath of handlerFiles) {
    const source = ts.createSourceFile(
      relativePath,
      readSource(relativePath),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    assert.equal(
      descendantsOfKind(source, ts.SyntaxKind.SwitchStatement).length,
      0,
      `${relativePath} must expose handlers rather than another dispatcher`,
    );
  }
});

test("RPC command handlers expose narrow typed contexts without test-only injection bags", () => {
  const handlerFiles = [
    "src/core/rin-daemon/rpc-extension-ui-command-handler.ts",
    "src/core/rin-daemon/rpc-turn-command-handler.ts",
    "src/core/rin-daemon/rpc-session-command-handler.ts",
    "src/core/rin-daemon/rpc-resource-command-handler.ts",
    "src/core/rin-daemon/rpc-auth-command-handler.ts",
  ];
  const sharedContextPath =
    "src/core/rin-daemon/rpc-command-handler-context.ts";
  const sharedContext = ts.createSourceFile(
    sharedContextPath,
    readSource(sharedContextPath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.equal(
    descendantsOfKind(sharedContext, ts.SyntaxKind.AnyKeyword).length,
    0,
    `${sharedContextPath} must own concrete request and response contracts`,
  );
  assert.doesNotMatch(readSource(sharedContextPath), /RpcInjectedFunction/);

  for (const relativePath of handlerFiles) {
    const source = ts.createSourceFile(
      relativePath,
      readSource(relativePath),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const contexts = source.statements.filter(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) &&
        statement.name.text.endsWith("CommandContext"),
    );
    assert.equal(contexts.length, 1, `${relativePath} needs one context owner`);
    assert.equal(
      descendantsOfKind(contexts[0], ts.SyntaxKind.AnyKeyword).length,
      0,
      `${relativePath} context must use concrete dependency contracts`,
    );
  }

  const directHandlerTests = readSource(
    "tests/integration/rpc-command-handlers.test.ts",
  );
  assert.doesNotMatch(
    directHandlerTests,
    /\bas any\b/,
    "direct handler tests must construct the real context contracts",
  );
});
