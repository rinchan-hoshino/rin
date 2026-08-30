import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

const daemonRoot = path.resolve("src/core/rin-daemon");
const contractPath = path.join(daemonRoot, "cron-contract.ts");
const contractTypes = [
  "CronSessionInvocation",
  "CronTaskCondition",
  "CronTaskFrontendBinding",
  "CronTaskInput",
  "CronTaskRecord",
  "CronTaskTarget",
  "CronTaskTermination",
  "CronTaskTrigger",
].sort();

function parse(file: string) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function moduleSpecifiers(file: string) {
  return parse(file).statements.flatMap((statement) =>
    ts.isImportDeclaration(statement)
      ? [String(statement.moduleSpecifier.text)]
      : [],
  );
}

test("cron contract is the sole type-only DTO owner", () => {
  assert.equal(fs.existsSync(contractPath), true);
  const sourceFile = parse(contractPath);
  const declared: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      assert.equal(statement.importClause?.isTypeOnly, true);
      continue;
    }
    assert.equal(ts.isTypeAliasDeclaration(statement), true);
    const declaration = statement as ts.TypeAliasDeclaration;
    assert.ok(
      declaration.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
    );
    declared.push(declaration.name.text);
  }
  assert.deepEqual(declared.sort(), contractTypes);

  const owners = new Map<string, string[]>();
  for (const entry of fs.readdirSync(daemonRoot)) {
    if (!entry.endsWith(".ts")) continue;
    const file = path.join(daemonRoot, entry);
    for (const statement of parse(file).statements) {
      if (
        ts.isTypeAliasDeclaration(statement) &&
        contractTypes.includes(statement.name.text)
      ) {
        const paths = owners.get(statement.name.text) || [];
        paths.push(path.relative(process.cwd(), file));
        owners.set(statement.name.text, paths);
      }
    }
  }
  assert.deepEqual(
    Object.fromEntries(owners),
    Object.fromEntries(
      contractTypes.map((name) => [
        name,
        ["src/core/rin-daemon/cron-contract.ts"],
      ]),
    ),
  );
});

test("cron modules depend one-way on the DTO contract", () => {
  for (const module of [
    "cron-condition.ts",
    "cron-execution.ts",
    "cron-utils.ts",
  ]) {
    const imports = moduleSpecifiers(path.join(daemonRoot, module));
    assert.ok(imports.includes("./cron-contract.js"), module);
    assert.equal(imports.includes("./cron.js"), false, module);
  }
  const scheduler = parse(path.join(daemonRoot, "cron.ts"));
  assert.ok(
    moduleSpecifiers(path.join(daemonRoot, "cron.ts")).includes(
      "./cron-contract.js",
    ),
  );
  assert.equal(
    scheduler.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        String(statement.moduleSpecifier.text) === "./cron-contract.js",
    ),
    false,
  );
});

test("cron task contract has no task-owned execution session or runtime overrides", () => {
  const contract = fs.readFileSync(contractPath, "utf8");
  const execution = fs.readFileSync(
    path.join(daemonRoot, "cron-execution.ts"),
    "utf8",
  );
  const options = fs.readFileSync(
    path.resolve("src/core/scheduled-task-options.ts"),
    "utf8",
  );

  assert.doesNotMatch(contract, /CronTaskSessionBinding/);
  assert.doesNotMatch(contract, /dedicatedSession(File|Persistent)/);
  assert.doesNotMatch(contract, /disabledRinCapabilities/);
  assert.doesNotMatch(contract, /thinkingLevel/);
  assert.doesNotMatch(execution, /affectChatBinding/);
  assert.doesNotMatch(execution, /managedSessionLeaf/);
  assert.doesNotMatch(options, /SCHEDULED_TASK_SESSION_MODES/);
});
