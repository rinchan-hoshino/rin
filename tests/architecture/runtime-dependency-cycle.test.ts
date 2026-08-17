import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

const root = path.resolve("src/core");

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  });
}

function relativeTarget(source: string, specifier: string) {
  if (!specifier.startsWith(".")) return undefined;
  return path.resolve(path.dirname(source), specifier.replace(/\.js$/, ".ts"));
}

function importGraph() {
  const files = sourceFiles(root);
  const known = new Set(files);
  const graph = new Map(files.map((file) => [file, new Set<string>()]));
  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const add = (specifier: string) => {
      const target = relativeTarget(file, specifier);
      if (target && known.has(target)) graph.get(file)?.add(target);
    };
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        add(String(statement.moduleSpecifier.text));
      }
    }
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return graph;
}

function stronglyConnectedComponents(graph: Map<string, Set<string>>) {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string) => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    stacked.add(node);
    for (const target of graph.get(node) || []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, lowLinks.get(target)!),
        );
      } else if (stacked.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let current = "";
    do {
      current = stack.pop()!;
      stacked.delete(current);
      component.push(path.relative(process.cwd(), current));
    } while (current !== node);
    if (component.length > 1) components.push(component.sort());
  };
  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node);
  }
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

test("core static imports form an acyclic graph", () => {
  assert.deepEqual(stronglyConnectedComponents(importGraph()), []);
});

test("maintenance queue is the terminal self-improve enqueue owner", () => {
  const queuePath = path.join(root, "self-improve", "maintenance-queue.ts");
  assert.equal(fs.existsSync(queuePath), true);
  const queueSource = fs.readFileSync(queuePath, "utf8");
  for (const forbidden of [
    "./async-jobs.js",
    "./maintainer.js",
    "../session/",
    "../rin-lib/runtime.js",
  ]) {
    assert.equal(queueSource.includes(forbidden), false, forbidden);
  }
  const indexSource = fs.readFileSync(
    path.join(root, "self-improve", "index.ts"),
    "utf8",
  );
  assert.match(indexSource, /from "\.\/maintenance-queue\.js"/);
  assert.doesNotMatch(indexSource, /from "\.\/async-jobs\.js"/);
});

test("session factory statically owns one configured runtime call", () => {
  const factoryPath = path.join(root, "session", "factory.ts");
  const factorySource = fs.readFileSync(factoryPath, "utf8");
  assert.match(
    factorySource,
    /import \{ createConfiguredAgentSession \} from "\.\.\/rin-lib\/runtime\.js";/,
  );
  assert.doesNotMatch(factorySource, /import\("\.\.\/rin-lib\/runtime\.js"\)/);
  let declarations = 0;
  for (const file of sourceFiles(root)) {
    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of sourceFile.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "openBoundSession"
      ) {
        declarations += 1;
      }
    }
  }
  assert.equal(declarations, 1);
});
