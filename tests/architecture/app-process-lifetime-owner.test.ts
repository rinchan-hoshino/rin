import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

function listTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(resolved);
    return entry.isFile() && entry.name.endsWith(".ts") ? [resolved] : [];
  });
}

function processLifetimeReferences(file: string, content: string): string[] {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const errors: string[] = [];
  const forbiddenProcessMembers = new Set(["abort", "exit", "exitCode"]);
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      forbiddenProcessMembers.has(node.name.text)
    ) {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      errors.push(
        `${path.relative(".", file)}:${line}:process.${node.name.text}`,
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "kill" &&
      node.arguments.length > 0 &&
      ts.isPropertyAccessExpression(node.arguments[0]) &&
      ts.isIdentifier(node.arguments[0].expression) &&
      node.arguments[0].expression.text === "process" &&
      node.arguments[0].name.text === "pid"
    ) {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      errors.push(
        `${path.relative(".", file)}:${line}:process.kill(process.pid)`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}

test("app entrypoints exclusively own physical process termination", () => {
  const errors: string[] = [];
  for (const file of listTypeScriptFiles(path.resolve("src/core"))) {
    const content = fs.readFileSync(file, "utf8");
    if (content.startsWith("#!")) {
      errors.push(`${path.relative(".", file)}:core_shebang`);
    }
    errors.push(...processLifetimeReferences(file, content));
  }
  assert.deepEqual(errors, []);
});
