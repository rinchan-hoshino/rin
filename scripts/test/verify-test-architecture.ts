import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  builtPathForSource,
  type CoveragePolicy,
  ratchetBaselineDigest,
  type UnitCatalog,
  validateCoveragePolicy,
} from "./coverage-ownership.js";
import { TEST_SUITES, type TestSuite } from "./run-test-suite.js";

type RepoUnitCatalog = UnitCatalog;
type NonUnitCatalog = {
  schemaVersion: 2;
  thresholds: CoveragePolicy["thresholds"];
  modules: Array<{
    source: string;
    suite: "integration" | "system";
    tests: string[];
    preloads?: string[];
    node22DynamicImportUncoveredBranches?: number;
  }>;
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
type MutationEntry = {
  id: string;
  rationale: string;
  search: string;
  replacement: string;
  tests: string[];
};
type MutationPolicy = {
  thresholds: { source: number; acceptance: number };
  source: Array<MutationEntry & { file: string }>;
  acceptance: Array<MutationEntry & { feature: string }>;
};
type TortureRiskRegister = {
  schemaVersion: number;
  risks: Array<{
    id: string;
    consequence: string;
    schedule: string;
    test: string;
  }>;
};
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const RATCHET_BASELINE_SHA256 =
  "1d77f4790deef8a7668e5217516fc900fc27f05e7df00c9f715685102f405ceb";
const ORIGINAL_COVERAGE_BASELINE_SHA256 =
  "5daf52ccc085a8a8bdecfd9b34c4a5cdcc9d9d2b2f47e028bd8370c593e54b77";

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
  /^node:(?:assert(?:\/strict)?|crypto|fs(?:\/promises)?|os|path|test|url)$/;

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

export function verifyTestArchitecture() {
  const errors: string[] = [];
  const unitCatalog = readJson<RepoUnitCatalog>("tests/unit/catalog.json");
  const nonUnitCatalog = readJson<NonUnitCatalog>(
    "tests/non-unit/catalog.json",
  );
  const regressionCatalog = readJson<RegressionCatalog>(
    "tests/regression/catalog.json",
  );
  const coveragePolicy = readJson<CoveragePolicy>("tests/coverage-policy.json");
  const mutationPolicy = readJson<MutationPolicy>("tests/mutation-policy.json");
  const tortureRisks = readJson<TortureRiskRegister>(
    "tests/torture/risk-register.json",
  );

  for (const [name, schemaVersion, expectedSchemaVersion] of [
    ["unit", unitCatalog.schemaVersion, 2],
    ["non-unit", nonUnitCatalog.schemaVersion, 2],
    ["regression", regressionCatalog.schemaVersion, 1],
  ] as const) {
    if (schemaVersion !== expectedSchemaVersion) {
      errors.push(`unsupported_schema:${name}`);
    }
  }
  const originalCoverageBaselineDigest = createHash("sha256")
    .update(fs.readFileSync(path.join(rootDir, "tests/coverage-baseline.json")))
    .digest("hex");
  if (originalCoverageBaselineDigest !== ORIGINAL_COVERAGE_BASELINE_SHA256) {
    errors.push("original_coverage_baseline_changed");
  }

  for (const retired of ["tests/e2e", "tests/interactive"]) {
    if (fs.existsSync(path.join(rootDir, retired)))
      errors.push(`retired_bucket:${retired}`);
  }

  const allTests = listFiles("tests", ".test.ts");
  const testsByDigest = new Map<string, string[]>();
  for (const file of allTests) {
    const digest = createHash("sha256")
      .update(fs.readFileSync(path.join(rootDir, file)))
      .digest("hex");
    const matchingFiles = testsByDigest.get(digest) ?? [];
    matchingFiles.push(file);
    testsByDigest.set(digest, matchingFiles);
  }
  for (const matchingFiles of testsByDigest.values()) {
    if (matchingFiles.length > 1) {
      errors.push(`duplicate_test_files:${matchingFiles.join(",")}`);
    }
  }
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

  const acceptanceTests = allTests.filter((file) =>
    file.startsWith("tests/acceptance/"),
  );
  const acceptanceFeatures = listFiles("tests/acceptance/features", ".feature");
  for (const testFile of acceptanceTests) {
    const content = fs.readFileSync(path.join(rootDir, testFile), "utf8");
    if (
      !testFile.endsWith(".acceptance.test.ts") ||
      !content.includes("runGherkinScenario")
    ) {
      errors.push(`acceptance_runner_missing:${testFile}`);
    }
  }
  for (const featureFile of acceptanceFeatures) {
    const owners = acceptanceTests.filter((testFile) =>
      fs
        .readFileSync(path.join(rootDir, testFile), "utf8")
        .includes(featureFile),
    );
    if (owners.length !== 1) {
      errors.push(
        `acceptance_feature_owner_count:${featureFile}:${owners.length}`,
      );
    }
  }

  for (const propertyFile of allTests.filter((file) =>
    file.startsWith("tests/property/"),
  )) {
    const content = fs.readFileSync(path.join(rootDir, propertyFile), "utf8");
    if (
      !content.includes("scripts/test/property-check") ||
      !/fc\.(?:asyncProperty|property)\s*\(/.test(content)
    ) {
      errors.push(`property_runner_missing:${propertyFile}`);
    }
  }

  if (
    mutationPolicy.thresholds.source !== 100 ||
    mutationPolicy.thresholds.acceptance !== 100
  ) {
    errors.push("mutation_threshold_must_be_100");
  }
  const mutations = [
    ...mutationPolicy.source.map((entry) => ({
      ...entry,
      kind: "source" as const,
      target: entry.file,
    })),
    ...mutationPolicy.acceptance.map((entry) => ({
      ...entry,
      kind: "acceptance" as const,
      target: entry.feature,
    })),
  ];
  if (
    mutationPolicy.source.length === 0 ||
    mutationPolicy.acceptance.length === 0
  ) {
    errors.push("mutation_policy_layer_empty");
  }
  try {
    assertUnique(
      mutations.map((entry) => entry.id),
      "mutation_id",
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const mutation of mutations) {
    const expectedPrefix =
      mutation.kind === "source" ? "src/" : "tests/acceptance/features/";
    if (
      !mutation.id.trim() ||
      !mutation.rationale.trim() ||
      !mutation.target.startsWith(expectedPrefix) ||
      !fs.existsSync(path.join(rootDir, mutation.target)) ||
      !mutation.search ||
      mutation.search === mutation.replacement ||
      mutation.tests.length === 0
    ) {
      errors.push(`mutation_entry_invalid:${mutation.id}`);
      continue;
    }
    const target = fs.readFileSync(path.join(rootDir, mutation.target), "utf8");
    if (target.split(mutation.search).length !== 2) {
      errors.push(`mutation_search_not_unique:${mutation.id}`);
    }
    for (const testFile of mutation.tests) {
      if (!allTests.includes(testFile)) {
        errors.push(`mutation_test_missing:${mutation.id}:${testFile}`);
      }
    }
  }
  const packageJson = readJson<{ scripts?: Record<string, string> }>(
    "package.json",
  );
  const completeGate = packageJson.scripts?.["test:inner"] ?? "";
  if (
    packageJson.scripts?.["test:mutation:run"] !==
      "tsx scripts/test/run-mutation.ts" ||
    completeGate.includes("test:mutation:run")
  ) {
    errors.push("mutation_calibration_gate_invalid");
  }

  if (
    packageJson.scripts?.["test:current:run"] !==
      "tsx scripts/test/run-commit-tests.ts" ||
    !completeGate.includes("test:current:run") ||
    completeGate.includes("test:coverage:run")
  ) {
    errors.push("current_behavior_commit_gate_invalid");
  }

  const qaTests = allTests.filter((file) => file.startsWith("tests/qa/"));
  for (const testFile of qaTests) {
    const content = fs.readFileSync(path.join(rootDir, testFile), "utf8");
    if (
      !testFile.endsWith(".ui.test.ts") ||
      !content.includes("runUiOnlyTuiJourney") ||
      /node:(?:fs|path|url)|\bdist\//.test(content)
    ) {
      errors.push(`qa_not_ui_only:${testFile}`);
    }
  }
  if (
    packageJson.scripts?.["test:qa:run"] !==
      "tsx scripts/test/run-test-suite.ts qa" ||
    !fs
      .readFileSync(
        path.join(rootDir, "scripts/test/run-commit-tests.ts"),
        "utf8",
      )
      .includes('"qa"')
  ) {
    errors.push("qa_gate_not_wired");
  }

  const tortureTests = allTests.filter((file) =>
    file.startsWith("tests/torture/"),
  );
  if (tortureRisks.schemaVersion !== 1 || tortureRisks.risks.length === 0) {
    errors.push("torture_risk_register_invalid");
  }
  try {
    assertUnique(
      tortureRisks.risks.map((risk) => risk.id),
      "torture_risk_id",
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const testFile of tortureTests) {
    const content = fs.readFileSync(path.join(rootDir, testFile), "utf8");
    if (
      !testFile.endsWith(".torture.test.ts") ||
      !content.includes("scripts/test/torture") ||
      !tortureRisks.risks.some((risk) => risk.test === testFile)
    ) {
      errors.push(`torture_test_unowned:${testFile}`);
    }
  }
  for (const risk of tortureRisks.risks) {
    if (
      !risk.id.trim() ||
      !risk.consequence.trim() ||
      !risk.schedule.trim() ||
      !tortureTests.includes(risk.test)
    ) {
      errors.push(`torture_risk_invalid:${risk.id}`);
    }
  }
  if (
    packageJson.scripts?.["test:torture:run"] !==
      "tsx scripts/test/run-test-suite.ts torture" ||
    !fs
      .readFileSync(
        path.join(rootDir, "scripts/test/run-commit-tests.ts"),
        "utf8",
      )
      .includes('"torture"')
  ) {
    errors.push("torture_gate_not_wired");
  }

  const strictNonUnit = coveragePolicy.modules.filter(
    (module) => module.status === "strict" && module.ownerSuite !== "unit",
  );
  if (
    JSON.stringify(nonUnitCatalog.thresholds) !==
    JSON.stringify(coveragePolicy.thresholds)
  ) {
    errors.push("non_unit_targets_must_match_policy");
  }
  if (
    !sameMembers(
      nonUnitCatalog.modules.map((entry) => entry.source),
      strictNonUnit.map((module) => module.source),
    )
  ) {
    errors.push("non_unit_catalog_owner_mismatch");
  }
  assertUnique(
    nonUnitCatalog.modules.map((entry) => entry.source),
    "non_unit_source",
  );
  for (const entry of nonUnitCatalog.modules) {
    const owner = strictNonUnit.find(
      (module) => module.source === entry.source,
    );
    if (
      !owner ||
      owner.ownerSuite !== entry.suite ||
      entry.tests.length === 0
    ) {
      errors.push(`non_unit_catalog_entry_invalid:${entry.source}`);
    }
    for (const testFile of entry.tests) {
      if (
        !allTests.includes(testFile) ||
        !testFile.startsWith(`tests/${entry.suite}/`)
      ) {
        errors.push(`non_unit_owner_test_invalid:${entry.source}:${testFile}`);
      }
    }
    for (const preload of entry.preloads || []) {
      if (
        !preload.startsWith("tests/support/") ||
        !fs.existsSync(path.join(rootDir, preload))
      ) {
        errors.push(
          `non_unit_owner_preload_invalid:${entry.source}:${preload}`,
        );
      }
    }
    const node22Allowance = entry.node22DynamicImportUncoveredBranches;
    if (node22Allowance !== undefined) {
      const sourceText = fs.readFileSync(
        path.join(rootDir, entry.source),
        "utf8",
      );
      const dynamicImportCount =
        sourceText.match(/\bimport\s*\(/g)?.length ?? 0;
      if (
        !Number.isInteger(node22Allowance) ||
        node22Allowance < 1 ||
        node22Allowance !== dynamicImportCount ||
        !entry.preloads?.length
      ) {
        errors.push(`node22_dynamic_import_allowance_invalid:${entry.source}`);
      }
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
  errors.push(
    ...validateCoveragePolicy(coveragePolicy, sourceFiles, unitCatalog),
  );
  for (const module of coveragePolicy.modules) {
    const built = builtPathForSource(module.source);
    if (!fs.existsSync(path.join(rootDir, built))) {
      errors.push(`coverage_built_module_missing:${built}`);
    }
  }
  for (const source of listFiles("src/app", ".ts")) {
    const module = coveragePolicy.modules.find(
      (entry) => entry.source === source,
    );
    if (module?.ownerSuite !== "system") {
      errors.push(`app_entrypoint_must_be_system_owned:${source}`);
    }
  }

  const originalCoverageBaseline = readJson<any>(
    "tests/coverage-baseline.json",
  );
  const originalCoverageBySource = new Map(
    originalCoverageBaseline.modules.map((module: any) => [
      module.source,
      module,
    ]),
  );
  const ratchetBaselineChanged = coveragePolicy.modules
    .filter((module) => module.status === "ratchet")
    .some((module) => {
      const original = originalCoverageBySource.get(module.source) as
        | any
        | undefined;
      return (
        !original ||
        original.built !== builtPathForSource(module.source) ||
        JSON.stringify(original.baseline) !== JSON.stringify(module.baseline)
      );
    });
  const strictCount = coveragePolicy.modules.filter(
    (module) => module.status === "strict",
  ).length;
  const knownRatchetCheckpointChanged =
    strictCount === 230 &&
    ratchetBaselineDigest(coveragePolicy) !== RATCHET_BASELINE_SHA256;
  if (ratchetBaselineChanged || knownRatchetCheckpointChanged) {
    errors.push("coverage_ratchet_baseline_digest_changed");
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
  return {
    tests: allTests.length,
    unitModules: unitCatalog.modules.length,
    regressionFiles: regressionCatalog.files.length,
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
