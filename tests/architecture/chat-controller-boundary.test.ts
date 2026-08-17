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

function parseSource(relativePath: string) {
  return ts.createSourceFile(
    relativePath,
    readSource(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function declarationName(node: ts.NamedDeclaration) {
  return ts.isIdentifier(node.name) ? node.name.text : "";
}

test("ChatController solely owns mutable lifecycle while pure chat decisions use function modules", () => {
  const controllerPath = "src/core/chat/controller.ts";
  const pureModulePaths = [
    "src/core/chat/delivery-policy.ts",
    "src/core/chat/delivery-presentation.ts",
    "src/core/chat/todo-presentation.ts",
    "src/core/chat/working-indicator-policy.ts",
  ];
  for (const relativePath of pureModulePaths) {
    assert.equal(
      fs.existsSync(sourcePath(relativePath)),
      true,
      `${relativePath} must own its pure input/output decisions`,
    );
  }

  const controller = parseSource(controllerPath);
  const controllerClasses = controller.statements.filter(ts.isClassDeclaration);
  assert.deepEqual(
    controllerClasses.map((declaration) => declaration.name?.text),
    ["ChatController"],
  );
  const chatController = controllerClasses[0];
  const controllerFields = chatController.members
    .filter(ts.isPropertyDeclaration)
    .map(declarationName);
  assert.ok(
    controllerFields.length <= 53,
    "responsibility extraction must not create additional controller state",
  );
  for (const field of [
    "currentTurn",
    "compactionTurn",
    "pendingTurnPresentations",
    "stagedDelivery",
    "todoDeliveryQueue",
    "turnAbortGeneration",
  ]) {
    assert.ok(
      controllerFields.includes(field),
      `ChatController must retain lifecycle state owner ${field}`,
    );
  }

  const importedModules = controller.statements
    .filter(ts.isImportDeclaration)
    .map((declaration) =>
      ts.isStringLiteralLike(declaration.moduleSpecifier)
        ? declaration.moduleSpecifier.text
        : "",
    );
  for (const moduleName of [
    "./delivery-policy.js",
    "./delivery-presentation.js",
    "./todo-presentation.js",
    "./working-indicator-policy.js",
  ]) {
    assert.ok(
      importedModules.includes(moduleName),
      `ChatController must delegate to ${moduleName}`,
    );
  }

  const forbiddenTopLevelOwners = new Set([
    "TodoNoticeRenderMode",
    "WorkingIndicator",
    "WorkingIndicatorKind",
    "WorkingIndicatorPresentation",
    "formatTodoNoticeText",
    "normalizeWorkingIndicators",
    "pickVisibleWorkingIndicator",
    "selectTypingIndicatorsForKind",
    "selectVisibleWorkingIndicatorsForKind",
    "todoNoticeRenderModeForChatKey",
    "workingIndicatorKind",
    "workingIndicatorPresentation",
  ]);
  for (const statement of controller.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name &&
      forbiddenTopLevelOwners.has(statement.name.text)
    ) {
      assert.fail(`${statement.name.text} must not be owned by ChatController`);
    }
  }

  const forbiddenControllerMethods = new Set([
    "buildAssistantDelivery",
    "currentConversationSessionPayload",
    "editableWorkingIndicator",
    "getWorkingIndicatorPolicy",
    "hasEditableWorkingIndicator",
    "isTypingHeartbeatDue",
    "isVisibleWorkingPollDue",
    "localizeBuiltinCommandResult",
    "pickStoredValue",
    "resolveSessionFileForUse",
    "shouldDeferPassiveNotice",
    "shouldSuppressQuietDelivery",
    "typingPollIntervalMs",
  ]);
  const retainedMethods = chatController.members
    .filter(ts.isMethodDeclaration)
    .map(declarationName);
  for (const method of forbiddenControllerMethods) {
    assert.equal(
      retainedMethods.includes(method),
      false,
      `${method} must be a stateless collaborator, not a controller method`,
    );
  }

  const outbox = parseSource("src/core/chat/outbox.ts");
  assert.equal(
    outbox.statements
      .filter(ts.isFunctionDeclaration)
      .some((statement) => statement.name?.text === "withChatQuotePart"),
    false,
    "delivery presentation, not outbox persistence, must own quote insertion",
  );

  for (const relativePath of pureModulePaths) {
    const source = parseSource(relativePath);
    assert.equal(
      source.statements.some(ts.isClassDeclaration),
      false,
      `${relativePath} must not introduce another controller/service class`,
    );
    assert.equal(
      source.statements.some(
        (statement) =>
          ts.isVariableStatement(statement) &&
          (statement.declarationList.flags & ts.NodeFlags.Const) === 0,
      ),
      false,
      `${relativePath} must not own module-level mutable state`,
    );
    for (const declaration of source.statements.filter(
      ts.isImportDeclaration,
    )) {
      const moduleName = ts.isStringLiteralLike(declaration.moduleSpecifier)
        ? declaration.moduleSpecifier.text
        : "";
      assert.notEqual(
        moduleName,
        "./controller.js",
        `${relativePath} must not receive ChatController as a service locator`,
      );
      assert.equal(
        /^(?:node:)?(?:fs|path|crypto|sqlite|better-sqlite3)(?:\/|$)/.test(
          moduleName,
        ),
        false,
        `${relativePath} pure policy must not perform storage or identity I/O`,
      );
    }
  }
});
