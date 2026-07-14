import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { TEST_SUITES, type TestSuite } from "./run-test-suite.js";

type UnitCatalog = {
  schemaVersion: number;
  thresholds: { lines: number; functions: number; branches: number };
  modules: Array<{ test: string; source: string; built: string }>;
};
type ProvenanceEntry = {
  file: string;
  introducedBy: string;
  subject: string;
};
type RegressionCatalog = {
  schemaVersion: number;
  files: Array<ProvenanceEntry & { failure: string }>;
};
type CharacterizationCatalog = {
  schemaVersion: number;
  files: ProvenanceEntry[];
};
type CharacterizationBaseline = {
  schemaVersion: number;
  baselineRef: string;
  files: string[];
};
type CharacterizationCaseBaseline = {
  schemaVersion: number;
  baselineRef: string;
  files: Array<{ file: string; cases: string[] }>;
};
type CoveragePolicy = {
  schemaVersion: number;
  productionSourceRef: string;
  baselineHarnessVersion: number;
  baselineCommand: string;
  target: { lines: number; functions: number; branches: number };
  modules: Array<{
    source: string;
    built: string;
    owner: "unit" | "system" | "migration";
    status: "strict" | "ratchet";
    baseline: Record<string, { total: number; covered: number; pct: number }>;
  }>;
};

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const RATCHET_BASELINE_SHA256 =
  "3cd73c8d7c87534a6b944cd74ae11bf1ade0cad4fe55fc6517be3ee5ef1591f6";
const CHARACTERIZATION_BASELINE_SHA256 =
  "1479d92749988c2c367f3a053efd45d6671c5d0afbffcfc0e3eb0af6f91eb6e5";
const CHARACTERIZATION_CASE_BASELINE_SHA256 =
  "c705a9cb3b943ae63c8d8b7747790c2dbcef43c32bfb58f9c9668713c6454a78";

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function listFiles(directory: string, suffix: string): string[] {
  const result: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(suffix)) {
        result.push(path.relative(rootDir, absolute).split(path.sep).join("/"));
      }
    }
  };
  visit(path.join(rootDir, directory));
  return result.sort();
}

function sameMembers(actual: string[], expected: string[]) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function bindingIdentifiers(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  );
}

function assertUnique(values: string[], label: string) {
  const duplicates = values.filter(
    (value, index) => values.indexOf(value) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `${label}_duplicates:${[...new Set(duplicates)].join(",")}`,
    );
  }
}

const allowedUnitNodeModule =
  /^node:(?:assert(?:\/strict)?|fs(?:\/promises)?|os|path|test|url)$/;

export function sourceUsesAmbientNetwork(
  sourceText: string,
  fileName = "unit-network-probe.ts",
) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const isForbiddenModule = (specifier: string) =>
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !allowedUnitNodeModule.test(specifier);
  let found = false;
  const inspect = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"].includes(
        node.text,
      )
    ) {
      found = true;
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"].includes(
        node.argumentExpression.text,
      )
    ) {
      found = true;
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isForbiddenModule(node.moduleSpecifier.text)
    ) {
      found = true;
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      isForbiddenModule(node.arguments[0].text)
    ) {
      found = true;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      isForbiddenModule(node.moduleReference.expression.text)
    ) {
      found = true;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return found;
}

function testUsesAmbientNetwork(relativePath: string) {
  return sourceUsesAmbientNetwork(
    fs.readFileSync(path.join(rootDir, relativePath), "utf8"),
    relativePath,
  );
}

function testUsesAmbientProcess(relativePath: string) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    fs.readFileSync(path.join(rootDir, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const inspect = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "process") found = true;
    if (
      ts.isStringLiteralLike(node) &&
      ["process", "node:process"].includes(node.text)
    ) {
      found = true;
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "process"
    ) {
      found = true;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return found;
}

const fsModuleSpecifiers = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
]);

const mutatingFsMethods = new Set([
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "cp",
  "createWriteStream",
  "link",
  "lchown",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "open",
  "rename",
  "rm",
  "rmdir",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
]);

function normalizedFsMethod(name: string) {
  return name.endsWith("Sync") ? name.slice(0, -"Sync".length) : name;
}

export function sourceWritesFixedHostPath(
  sourceText: string,
  fileName = "fixed-host-path-probe.ts",
) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const fsObjects = new Set<string>();
  const fsFunctions = new Map<string, string>();
  const initializers = new Map<string, ts.Expression>();
  const ambiguousInitializers = new Set<string>();
  const unwrapFsExpression = (expression: ts.Expression): ts.Expression => {
    if (
      ts.isAwaitExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isPartiallyEmittedExpression(expression)
    ) {
      return unwrapFsExpression(expression.expression);
    }
    return expression;
  };
  const fsModuleExpression = (expression: ts.Expression): boolean => {
    const candidate = unwrapFsExpression(expression);
    if (
      ts.isPropertyAccessExpression(candidate) &&
      ["default", "promises"].includes(candidate.name.text)
    ) {
      return fsModuleExpression(candidate.expression);
    }
    if (
      ts.isElementAccessExpression(candidate) &&
      candidate.argumentExpression &&
      ts.isStringLiteralLike(candidate.argumentExpression) &&
      ["default", "promises"].includes(candidate.argumentExpression.text)
    ) {
      return fsModuleExpression(candidate.expression);
    }
    if (!ts.isCallExpression(candidate)) return false;
    const dynamicImport =
      candidate.expression.kind === ts.SyntaxKind.ImportKeyword;
    const commonJsRequire =
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === "require";
    return (
      (dynamicImport || commonJsRequire) &&
      candidate.arguments.some(
        (argument) =>
          ts.isStringLiteralLike(argument) &&
          fsModuleSpecifiers.has(argument.text),
      )
    );
  };
  const rootIdentifier = (expression: ts.Expression): string | undefined => {
    const candidate = unwrapFsExpression(expression);
    if (ts.isIdentifier(candidate)) return candidate.text;
    if (
      ts.isPropertyAccessExpression(candidate) ||
      ts.isElementAccessExpression(candidate)
    ) {
      return rootIdentifier(candidate.expression);
    }
    return undefined;
  };
  const fsMethodExpression = (expression: ts.Expression) => {
    const candidate = unwrapFsExpression(expression);
    if (ts.isIdentifier(candidate)) return fsFunctions.get(candidate.text);
    if (
      !ts.isPropertyAccessExpression(candidate) &&
      !ts.isElementAccessExpression(candidate)
    ) {
      return undefined;
    }
    const owner = candidate.expression;
    const member = ts.isPropertyAccessExpression(candidate)
      ? candidate.name.text
      : candidate.argumentExpression &&
          ts.isStringLiteralLike(candidate.argumentExpression)
        ? candidate.argumentExpression.text
        : undefined;
    const method = member ? normalizedFsMethod(member) : undefined;
    const root = rootIdentifier(owner);
    return method &&
      mutatingFsMethods.has(method) &&
      ((root && fsObjects.has(root)) || fsModuleExpression(owner))
      ? method
      : undefined;
  };
  const bindingPropertyText = (name: ts.PropertyName | undefined) => {
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    if (
      ts.isComputedPropertyName(name) &&
      ts.isStringLiteralLike(name.expression)
    ) {
      return name.expression.text;
    }
    return name.getText(sourceFile);
  };
  const registerFsBinding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      fsObjects.add(name.text);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        const imported =
          bindingPropertyText(element.propertyName) ??
          (ts.isIdentifier(element.name) ? element.name.text : "");
        if (["default", "promises"].includes(imported)) {
          if (ts.isIdentifier(element.name)) {
            fsObjects.add(element.name.text);
          } else {
            registerFsBinding(element.name);
          }
        }
        if (
          ts.isIdentifier(element.name) &&
          mutatingFsMethods.has(normalizedFsMethod(imported))
        ) {
          fsFunctions.set(element.name.text, normalizedFsMethod(imported));
        }
      }
    }
  };

  const collect = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      fsModuleSpecifiers.has(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause;
      if (clause?.name) fsObjects.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        fsObjects.add(clause.namedBindings.name.text);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (["default", "promises"].includes(imported)) {
            fsObjects.add(element.name.text);
          }
          if (mutatingFsMethods.has(normalizedFsMethod(imported))) {
            fsFunctions.set(element.name.text, normalizedFsMethod(imported));
          }
        }
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      fsModuleSpecifiers.has(node.moduleReference.expression.text)
    ) {
      fsObjects.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        if (initializers.has(node.name.text)) {
          initializers.delete(node.name.text);
          ambiguousInitializers.add(node.name.text);
        } else if (!ambiguousInitializers.has(node.name.text)) {
          initializers.set(node.name.text, node.initializer);
        }
      }
      const initializerRoot = rootIdentifier(node.initializer);
      if (
        fsModuleExpression(node.initializer) ||
        (ts.isObjectBindingPattern(node.name) &&
          initializerRoot &&
          fsObjects.has(initializerRoot))
      ) {
        registerFsBinding(node.name);
      }
      if (ts.isIdentifier(node.name)) {
        const method = fsMethodExpression(node.initializer);
        if (method) fsFunctions.set(node.name.text, method);
      }
      if (ts.isIdentifier(node.name)) {
        const initializer = unwrapFsExpression(node.initializer);
        if (ts.isIdentifier(initializer) && fsObjects.has(initializer.text)) {
          fsObjects.add(node.name.text);
        }
        if (
          ts.isPropertyAccessExpression(initializer) ||
          ts.isElementAccessExpression(initializer)
        ) {
          const member = ts.isPropertyAccessExpression(initializer)
            ? initializer.name.text
            : initializer.argumentExpression &&
                ts.isStringLiteralLike(initializer.argumentExpression)
              ? initializer.argumentExpression.text
              : undefined;
          const root = rootIdentifier(initializer.expression);
          if (
            member &&
            ["default", "promises"].includes(member) &&
            root &&
            fsObjects.has(root)
          ) {
            fsObjects.add(node.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const containsFixedPath = (
    node: ts.Node,
    seen = new Set<string>(),
  ): boolean => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/])/.test(node.text)
    ) {
      return true;
    }
    if (ts.isTemplateExpression(node)) {
      if (
        /^(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/])/.test(node.head.text)
      ) {
        return true;
      }
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const initializer = initializers.get(node.text);
      if (initializer) {
        seen.add(node.text);
        if (containsFixedPath(initializer, seen)) return true;
      }
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && containsFixedPath(child, new Set(seen))) found = true;
    });
    return found;
  };
  let unsafe = false;
  const inspect = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const method = fsMethodExpression(node.expression);
      if (method) {
        const pathArgumentIndexes =
          method === "rename"
            ? [0, 1]
            : ["copyFile", "cp", "link", "symlink"].includes(method)
              ? [1]
              : [0];
        if (
          pathArgumentIndexes.some((index) => {
            const argument = node.arguments[index];
            return argument ? containsFixedPath(argument) : false;
          })
        ) {
          unsafe = true;
        }
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return unsafe;
}

function testWritesFixedHostPath(relativePath: string) {
  return sourceWritesFixedHostPath(
    fs.readFileSync(path.join(rootDir, relativePath), "utf8"),
    relativePath,
  );
}

function testCaseIdentities(relativePath: string) {
  const sourceText = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const identities: string[] = [];
  const functionDeclarations = new Map<string, ts.FunctionDeclaration>();
  const moduleConstants = new Map<string, string>();
  const moduleInitializers = new Map<string, ts.Expression>();
  const pathToFileUrlImports = new Set<string>();
  const shadowedBindings = new Set<string>();
  const collectFunctions = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "node:url" &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === "pathToFileURL") {
          pathToFileUrlImports.add(element.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      for (const name of bindingIdentifiers(node.name)) {
        shadowedBindings.add(name);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      shadowedBindings.add(node.name.text);
      functionDeclarations.set(node.name.text, node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      moduleInitializers.set(node.name.text, node.initializer);
      if (
        ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer)
      ) {
        moduleConstants.set(node.name.text, node.initializer.text);
      }
    }
    ts.forEachChild(node, collectFunctions);
  };
  collectFunctions(sourceFile);
  const moduleSpecifier = (expression: ts.Expression): string | undefined => {
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      return expression.text;
    }
    if (ts.isIdentifier(expression))
      return moduleConstants.get(expression.text);
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = moduleSpecifier(expression.left);
      const right = moduleSpecifier(expression.right);
      return left == null || right == null ? undefined : left + right;
    }
    return undefined;
  };
  const isSafeFileModuleExpression = (
    expression: ts.Expression,
    seen = new Set<string>(),
  ): boolean => {
    if (ts.isParenthesizedExpression(expression)) {
      return isSafeFileModuleExpression(expression.expression, seen);
    }
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return false;
      const initializer = moduleInitializers.get(expression.text);
      if (!initializer) return false;
      seen.add(expression.text);
      return isSafeFileModuleExpression(initializer, seen);
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "href" &&
      ts.isCallExpression(expression.expression) &&
      ts.isIdentifier(expression.expression.expression) &&
      pathToFileUrlImports.has(expression.expression.expression.text) &&
      !shadowedBindings.has(expression.expression.expression.text)
    ) {
      return true;
    }
    if (ts.isTemplateExpression(expression)) {
      const first = expression.templateSpans[0];
      return (
        expression.head.text === "" &&
        Boolean(first) &&
        isSafeFileModuleExpression(first.expression, new Set(seen))
      );
    }
    return false;
  };
  const assertContextCannotRegisterTests = (
    body: ts.Node,
    contextNames: Set<string>,
    visitedFunctions = new Set<string>(),
  ) => {
    const inspect = (node: ts.Node) => {
      if (ts.isIdentifier(node) && contextNames.has(node.text)) {
        const parent = node.parent;
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node
        ) {
          if (parent.name.text === "test") {
            throw new Error(`characterization_nested_test_api:${relativePath}`);
          }
        } else if (
          ts.isCallExpression(parent) &&
          parent.arguments.some((argument) => argument === node) &&
          ts.isIdentifier(parent.expression)
        ) {
          const declaration = functionDeclarations.get(parent.expression.text);
          const argumentIndex = parent.arguments.findIndex(
            (argument) => argument === node,
          );
          const parameter = declaration?.parameters[argumentIndex]?.name;
          if (!declaration?.body || !parameter || !ts.isIdentifier(parameter)) {
            throw new Error(
              `characterization_test_context_escape:${relativePath}`,
            );
          }
          const functionName = declaration.name?.text ?? "";
          if (!visitedFunctions.has(functionName)) {
            visitedFunctions.add(functionName);
            assertContextCannotRegisterTests(
              declaration.body,
              new Set([parameter.text]),
              visitedFunctions,
            );
          }
        } else {
          throw new Error(
            `characterization_test_context_alias:${relativePath}`,
          );
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(body);
  };
  let canonicalImport = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const dynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const commonJsRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || commonJsRequire) {
        for (const argument of node.arguments) {
          const resolved = moduleSpecifier(argument);
          if (resolved === "node:test") {
            throw new Error(
              `characterization_dynamic_test_import:${relativePath}`,
            );
          }
          if (resolved == null && !isSafeFileModuleExpression(argument)) {
            throw new Error(
              `characterization_unresolved_dynamic_import:${relativePath}`,
            );
          }
        }
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "node:test"
    ) {
      const importClause = node.importClause;
      if (importClause?.name?.text === "test") canonicalImport = true;
      if (
        !importClause?.name ||
        importClause.name.text !== "test" ||
        (importClause.namedBindings &&
          ts.isNamespaceImport(importClause.namedBindings)) ||
        (importClause?.namedBindings &&
          ts.isNamedImports(importClause.namedBindings) &&
          importClause.namedBindings.elements.some((element) =>
            ["test", "it", "describe", "suite"].includes(
              element.propertyName?.text ?? element.name.text,
            ),
          ))
      ) {
        throw new Error(
          `characterization_noncanonical_test_import:${relativePath}`,
        );
      }
    }
    if (ts.isIdentifier(node) && node.text === "test") {
      const parent = node.parent;
      const isImportName = ts.isImportClause(parent) && parent.name === node;
      const isDirectCall =
        ts.isCallExpression(parent) && parent.expression === node;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
          parent.name === node);
      if (!isImportName && !isDirectCall && !isPropertyName) {
        throw new Error(`characterization_test_alias:${relativePath}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && expression.text === "test") {
        const title = node.arguments[0];
        if (!title)
          throw new Error(
            `characterization_test_without_title:${relativePath}`,
          );
        identities.push(title.getText(sourceFile));
        const callback = [...node.arguments]
          .reverse()
          .find(
            (argument) =>
              ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
          );
        if (!callback) {
          throw new Error(
            `characterization_noncanonical_test_callback:${relativePath}`,
          );
        }
        const contextNames = new Set(
          callback.parameters.flatMap((parameter) =>
            bindingIdentifiers(parameter.name),
          ),
        );
        if (contextNames.size > 0) {
          assertContextCannotRegisterTests(callback.body, contextNames);
        }
      } else if (
        ts.isIdentifier(expression) &&
        ["it", "describe", "suite"].includes(expression.text)
      ) {
        throw new Error(
          `characterization_noncanonical_test_call:${relativePath}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!canonicalImport) {
    throw new Error(`characterization_missing_test_import:${relativePath}`);
  }
  return identities;
}

function ratchetBaselineDigest(policy: CoveragePolicy) {
  const payload = policy.modules
    .filter((module) => module.status === "ratchet")
    .map(({ source, built, status, baseline }) => ({
      source,
      built,
      status,
      baseline,
    }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function verifyTestArchitecture() {
  const errors: string[] = [];
  const unitCatalog = readJson<UnitCatalog>("tests/unit/catalog.json");
  const regressionCatalog = readJson<RegressionCatalog>(
    "tests/regression/catalog.json",
  );
  const characterizationCatalog = readJson<CharacterizationCatalog>(
    "tests/characterization/catalog.json",
  );
  const characterizationBaselinePath =
    "tests/characterization/baseline-files.json";
  const characterizationBaseline = readJson<CharacterizationBaseline>(
    characterizationBaselinePath,
  );
  const characterizationCaseBaselinePath =
    "tests/characterization/baseline-cases.json";
  const characterizationCaseBaseline = readJson<CharacterizationCaseBaseline>(
    characterizationCaseBaselinePath,
  );
  const coveragePolicy = readJson<CoveragePolicy>("tests/coverage-policy.json");

  for (const [name, schemaVersion] of [
    ["unit", unitCatalog.schemaVersion],
    ["regression", regressionCatalog.schemaVersion],
    ["characterization", characterizationCatalog.schemaVersion],
    ["characterization-baseline", characterizationBaseline.schemaVersion],
    [
      "characterization-case-baseline",
      characterizationCaseBaseline.schemaVersion,
    ],
    ["coverage", coveragePolicy.schemaVersion],
  ] as const) {
    if (schemaVersion !== 1) errors.push(`unsupported_schema:${name}`);
  }
  if (
    coveragePolicy.productionSourceRef !== "fa644064" ||
    coveragePolicy.baselineHarnessVersion !== 3 ||
    coveragePolicy.baselineCommand !== "npm run test:coverage"
  ) {
    errors.push("coverage_baseline_identity_changed");
  }
  if (
    characterizationBaseline.baselineRef !== "fa644064" ||
    characterizationCaseBaseline.baselineRef !== "fa644064"
  ) {
    errors.push("characterization_baseline_identity_changed");
  }
  const characterizationBaselineDigest = createHash("sha256")
    .update(fs.readFileSync(path.join(rootDir, characterizationBaselinePath)))
    .digest("hex");
  if (characterizationBaselineDigest !== CHARACTERIZATION_BASELINE_SHA256) {
    errors.push("characterization_baseline_digest_changed");
  }
  const characterizationCaseBaselineDigest = createHash("sha256")
    .update(
      fs.readFileSync(path.join(rootDir, characterizationCaseBaselinePath)),
    )
    .digest("hex");
  if (
    characterizationCaseBaselineDigest !== CHARACTERIZATION_CASE_BASELINE_SHA256
  ) {
    errors.push("characterization_case_baseline_digest_changed");
  }

  for (const retired of ["tests/e2e", "tests/interactive"]) {
    if (fs.existsSync(path.join(rootDir, retired)))
      errors.push(`retired_bucket:${retired}`);
  }

  const allTests = listFiles("tests", ".test.ts");
  for (const file of listFiles("tests", ".ts")) {
    const content = fs.readFileSync(path.join(rootDir, file), "utf8");
    if (content.includes("new URL(import.meta.url).pathname")) {
      errors.push(`nonportable_file_url_path:${file}`);
    }
    if (testWritesFixedHostPath(file)) {
      errors.push(`fixed_host_write_path:${file}`);
    }
  }
  for (const file of allTests) {
    const bucket = file.split("/")[1] as TestSuite;
    if (!TEST_SUITES.includes(bucket)) errors.push(`unclassified_test:${file}`);
  }
  for (const suite of TEST_SUITES) {
    if (!allTests.some((file) => file.startsWith(`tests/${suite}/`))) {
      errors.push(`empty_test_bucket:${suite}`);
    }
  }

  const unitFiles = listFiles("tests/unit", ".test.ts");
  const catalogUnitFiles = unitCatalog.modules
    .map((entry) => entry.test)
    .sort();
  if (!sameMembers(unitFiles, catalogUnitFiles)) {
    errors.push("unit_catalog_does_not_match_files");
  }
  assertUnique(catalogUnitFiles, "unit_test");
  assertUnique(
    unitCatalog.modules.map((entry) => entry.source),
    "unit_source",
  );

  const forbiddenUnitPatterns: Array<[RegExp, string]> = [
    [
      /node:(?:child_process|cluster|dgram|http|https|net|tls|worker_threads)/,
      "process_or_network_dependency",
    ],
    [/\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/, "subprocess_call"],
  ];
  for (const module of unitCatalog.modules) {
    for (const relativePath of [module.test, module.source]) {
      if (!fs.existsSync(path.join(rootDir, relativePath))) {
        errors.push(`missing_unit_path:${relativePath}`);
      }
    }
    const expectedBuilt = `dist/${module.source.slice("src/".length).replace(/\.ts$/, ".js")}`;
    if (module.built !== expectedBuilt)
      errors.push(`unit_built_path_mismatch:${module.built}`);
    const content = fs.readFileSync(path.join(rootDir, module.test), "utf8");
    if (testUsesAmbientProcess(module.test)) {
      errors.push(`unit_boundary:${module.test}:ambient_process_dependency`);
    }
    if (testUsesAmbientNetwork(module.test)) {
      errors.push(`unit_boundary:${module.test}:ambient_network_dependency`);
    }
    for (const [pattern, reason] of forbiddenUnitPatterns) {
      if (pattern.test(content))
        errors.push(`unit_boundary:${module.test}:${reason}`);
    }
  }

  const regressionFiles = listFiles("tests/regression", ".test.ts");
  const catalogRegressionFiles = regressionCatalog.files
    .map((entry) => entry.file)
    .sort();
  if (!sameMembers(regressionFiles, catalogRegressionFiles)) {
    errors.push("regression_catalog_does_not_match_files");
  }
  assertUnique(catalogRegressionFiles, "regression_test");
  for (const entry of regressionCatalog.files) {
    if (
      !entry.introducedBy.trim() ||
      !entry.subject.trim() ||
      !entry.failure.trim()
    ) {
      errors.push(`regression_missing_provenance:${entry.file}`);
    }
  }

  const characterizationFiles = listFiles("tests/characterization", ".test.ts");
  const catalogCharacterizationFiles = characterizationCatalog.files
    .map((entry) => entry.file)
    .sort();
  if (!sameMembers(characterizationFiles, catalogCharacterizationFiles)) {
    errors.push("characterization_catalog_does_not_match_files");
  }
  assertUnique(catalogCharacterizationFiles, "characterization_test");
  assertUnique(characterizationBaseline.files, "characterization_baseline");
  const allowedCharacterizationFiles = new Set(characterizationBaseline.files);
  for (const file of characterizationFiles) {
    if (!allowedCharacterizationFiles.has(file)) {
      errors.push(`characterization_debt_increased:${file}`);
    }
  }
  const baselineCaseFiles = characterizationCaseBaseline.files
    .map((entry) => entry.file)
    .sort();
  if (
    !sameMembers(baselineCaseFiles, [...characterizationBaseline.files].sort())
  ) {
    errors.push("characterization_case_baseline_files_mismatch");
  }
  const baselineCasesByFile = new Map(
    characterizationCaseBaseline.files.map((entry) => [
      entry.file,
      entry.cases,
    ]),
  );
  for (const file of characterizationFiles) {
    const remaining = new Map<string, number>();
    for (const identity of baselineCasesByFile.get(file) ?? []) {
      remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
    }
    for (const identity of testCaseIdentities(file)) {
      const count = remaining.get(identity) ?? 0;
      if (count === 0) {
        errors.push(`characterization_case_added:${file}:${identity}`);
      } else {
        remaining.set(identity, count - 1);
      }
    }
  }
  for (const entry of characterizationCatalog.files) {
    if (!entry.introducedBy.trim() || !entry.subject.trim()) {
      errors.push(`characterization_missing_provenance:${entry.file}`);
    }
  }

  for (const file of listFiles("tests/system", ".test.ts")) {
    const content = fs.readFileSync(path.join(rootDir, file), "utf8");
    const usesSandbox =
      /from ["'][^"']*test-sandbox\.js["']/.test(content) &&
      /createTestSandbox\s*\(/.test(content) &&
      /sandbox\.env/.test(content);
    const usesContainerHarness =
      /from ["'][^"']*install-to-tui-harness\.js["']/.test(content) &&
      /runInstallToTuiSmokeInContainer\s*\(/.test(content);
    if (!usesSandbox && !usesContainerHarness) {
      errors.push(`system_without_verified_sandbox:${file}`);
    }
    if (/os\.homedir\s*\(/.test(content)) {
      errors.push(`system_reads_real_home:${file}`);
    }
  }

  const sourceFiles = listFiles("src", ".ts");
  const policySources = coveragePolicy.modules
    .map((entry) => entry.source)
    .sort();
  if (!sameMembers(sourceFiles, policySources)) {
    errors.push("coverage_policy_does_not_match_source_modules");
  }
  assertUnique(policySources, "coverage_source");

  const requiredTargets = { lines: 90, functions: 90, branches: 85 };
  if (
    JSON.stringify(unitCatalog.thresholds) !==
      JSON.stringify(requiredTargets) ||
    JSON.stringify(coveragePolicy.target) !== JSON.stringify(requiredTargets)
  ) {
    errors.push("coverage_targets_must_remain_90_90_85");
  }

  const strictSources = new Set(
    unitCatalog.modules.map((entry) => entry.source),
  );
  for (const module of coveragePolicy.modules) {
    if (!(["strict", "ratchet"] as const).includes(module.status)) {
      errors.push(`coverage_status_invalid:${module.source}`);
    }
    if (!(["unit", "system", "migration"] as const).includes(module.owner)) {
      errors.push(`coverage_owner_invalid:${module.source}`);
    }
    const expectedBuilt = `dist/${module.source.slice("src/".length).replace(/\.ts$/, ".js")}`;
    if (module.built !== expectedBuilt)
      errors.push(`coverage_built_path_mismatch:${module.source}`);
    const shouldBeStrict = strictSources.has(module.source);
    if ((module.status === "strict") !== shouldBeStrict) {
      errors.push(`coverage_status_mismatch:${module.source}`);
    }
    for (const metric of ["lines", "functions", "branches"] as const) {
      const baseline = module.baseline[metric];
      const countsAreValid =
        baseline &&
        Number.isInteger(baseline.total) &&
        Number.isInteger(baseline.covered) &&
        baseline.total >= 0 &&
        baseline.covered >= 0 &&
        baseline.total >= baseline.covered;
      const expectedPct =
        countsAreValid && baseline.total > 0
          ? Math.floor((baseline.covered / baseline.total) * 10_000) / 100
          : 100;
      if (
        !countsAreValid ||
        !Number.isFinite(baseline.pct) ||
        baseline.pct < 0 ||
        baseline.pct > 100 ||
        Math.abs(baseline.pct - expectedPct) > 0.005
      ) {
        errors.push(`coverage_baseline_invalid:${module.source}:${metric}`);
      }
    }
  }

  for (const source of [
    "src/app/rin/main.ts",
    "src/app/rin-daemon/daemon.ts",
    "src/app/rin-daemon/worker.ts",
    "src/app/rin-tui/main.ts",
  ]) {
    const module = coveragePolicy.modules.find(
      (entry) => entry.source === source,
    );
    if (!module || module.baseline.lines.covered === 0) {
      errors.push(`system_entrypoint_coverage_missing:${source}`);
    }
  }

  if (ratchetBaselineDigest(coveragePolicy) !== RATCHET_BASELINE_SHA256) {
    errors.push("coverage_ratchet_baseline_digest_changed");
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
  return {
    tests: allTests.length,
    unitModules: unitCatalog.modules.length,
    regressionFiles: regressionCatalog.files.length,
    characterizationFiles: characterizationCatalog.files.length,
    coverageModules: coveragePolicy.modules.length,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = verifyTestArchitecture();
  console.log(JSON.stringify(result));
}
