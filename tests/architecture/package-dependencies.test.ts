import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readPackageJson() {
  return JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
  );
}

function walkSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return walkSourceFiles(entryPath);
    }
    return /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function packageNameForSpecifier(specifier: string) {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

function importDeclarationHasRuntimeBinding(node: ts.ImportDeclaration) {
  if (!node.importClause) {
    return true;
  }
  if (node.importClause.isTypeOnly) {
    return false;
  }
  if (node.importClause.name) {
    return true;
  }
  const bindings = node.importClause.namedBindings;
  return (
    !bindings ||
    ts.isNamespaceImport(bindings) ||
    bindings.elements.some((element) => !element.isTypeOnly)
  );
}

function exportDeclarationHasRuntimeBinding(node: ts.ExportDeclaration) {
  if (node.isTypeOnly) {
    return false;
  }
  return (
    !node.exportClause ||
    !ts.isNamedExports(node.exportClause) ||
    node.exportClause.elements.some((element) => !element.isTypeOnly)
  );
}

function collectProductSourceImports() {
  const imports = new Set<string>();
  for (const filePath of walkSourceFiles(path.join(rootDir, "src"))) {
    const sourceFile = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) &&
        importDeclarationHasRuntimeBinding(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        imports.add(packageNameForSpecifier(node.moduleSpecifier.text));
      }
      if (
        ts.isExportDeclaration(node) &&
        exportDeclarationHasRuntimeBinding(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        imports.add(packageNameForSpecifier(node.moduleSpecifier.text));
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require")) &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        imports.add(packageNameForSpecifier(node.arguments[0].text));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return imports;
}

function runtimePackageForTypesPackage(packageName: string) {
  const typeName = packageName.slice("@types/".length);
  if (typeName.includes("__")) {
    const [scope, name] = typeName.split("__", 2);
    return `@${scope}/${name}`;
  }
  return typeName;
}

test("runtime dependencies have a runtime product source consumer", () => {
  const packageJson = readPackageJson();
  const productImports = collectProductSourceImports();
  assert.deepEqual(
    Object.keys(packageJson.dependencies || {}).filter(
      (name) => !productImports.has(name),
    ),
    [],
  );
});

test("declaration dependencies have a corresponding runtime package", () => {
  const packageJson = readPackageJson();
  const declaredPackages = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
  ]);
  assert.deepEqual(
    Object.keys(packageJson.devDependencies || {})
      .filter((name) => name.startsWith("@types/") && name !== "@types/node")
      .filter(
        (name) => !declaredPackages.has(runtimePackageForTypesPackage(name)),
      ),
    [],
  );
});

test("runtime dependencies do not include pure TypeScript declaration packages", () => {
  const packageJson = readPackageJson();
  assert.deepEqual(
    Object.keys(packageJson.dependencies || {}).filter((name) =>
      name.startsWith("@types/"),
    ),
    [],
  );
});
