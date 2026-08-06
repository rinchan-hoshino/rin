import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { networkIsolatedNodeInvocation } from "./network-isolated-process.js";
import { requireTestContainer } from "./require-test-container.js";
import { createTestProcessEnvironment } from "./test-process-environment.js";

type Mutation = {
  id: string;
  rationale: string;
  search: string;
  replacement: string;
  tests: string[];
};

type SourceMutation = Mutation & { file: string };
type AcceptanceMutation = Mutation & { feature: string };
type MutationPolicy = {
  thresholds: { source: number; acceptance: number };
  source: SourceMutation[];
  acceptance: AcceptanceMutation[];
};

type TestResult = {
  status: number;
  output: string;
};

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const policy = JSON.parse(
  fs.readFileSync(path.join(rootDir, "tests/mutation-policy.json"), "utf8"),
) as MutationPolicy;

function replaceExactlyOnce(
  source: string,
  search: string,
  replacement: string,
) {
  if (!search || search === replacement) throw new Error("mutation_noop");
  const first = source.indexOf(search);
  if (first < 0) throw new Error("mutation_search_missing");
  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error("mutation_search_ambiguous");
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

function runTests(
  tests: string[],
  overrides: NodeJS.ProcessEnv = {},
): TestResult {
  const sandbox = createTestProcessEnvironment("mutation");
  try {
    const env = { ...sandbox.env, ...overrides };
    const invocation = networkIsolatedNodeInvocation(
      [
        "--import",
        "tsx",
        "scripts/test/run-node-tests.ts",
        "--import",
        "tsx",
        "--test",
        "--test-reporter=tap",
        "--test-concurrency=1",
        ...tests,
      ],
      env,
    );
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: rootDir,
      env: invocation.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    };
  } finally {
    sandbox.cleanup();
  }
}

function tapCount(output: string, field: string) {
  const matches = [...output.matchAll(new RegExp(`^# ${field} (\\d+)$`, "gm"))];
  return matches.length ? Number(matches.at(-1)?.[1]) : undefined;
}

function isBehavioralKill(result: TestResult) {
  const tests = tapCount(result.output, "tests");
  const failed = tapCount(result.output, "fail");
  const assertionEvidence =
    result.output.includes("ERR_ASSERTION") ||
    result.output.includes("Expected values to be") ||
    result.output.includes("Property failed after");
  const infrastructureFailure =
    /ERR_MODULE_NOT_FOUND|SyntaxError:|test_summary_missing|network_isolation_/.test(
      result.output,
    );
  return (
    result.status !== 0 &&
    Number(tests) > 0 &&
    Number(failed) > 0 &&
    assertionEvidence &&
    !infrastructureFailure
  );
}

function compileSourceMutation(mutation: SourceMutation) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), `rin-source-mutant-${mutation.id}-`),
  );
  const sourceDir = path.join(workspace, "src");
  const outputDir = path.join(workspace, "dist");
  fs.cpSync(path.join(rootDir, "src"), sourceDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"module"}\n');
  fs.symlinkSync(
    path.join(rootDir, "node_modules"),
    path.join(workspace, "node_modules"),
    "dir",
  );

  const target = path.join(workspace, mutation.file);
  const original = fs.readFileSync(target, "utf8");
  fs.writeFileSync(
    target,
    replaceExactlyOnce(original, mutation.search, mutation.replacement),
  );
  const tsconfigPath = path.join(workspace, "tsconfig.json");
  fs.writeFileSync(
    tsconfigPath,
    JSON.stringify({
      extends: path.join(rootDir, "tsconfig.json"),
      compilerOptions: { rootDir: sourceDir, outDir: outputDir },
      include: [path.join(sourceDir, "**/*.ts")],
    }),
  );
  const compiled = spawnSync(
    process.execPath,
    [
      path.join(rootDir, "node_modules/typescript/bin/tsc"),
      "-p",
      tsconfigPath,
      "--pretty",
      "false",
    ],
    { cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) {
    fs.rmSync(workspace, { recursive: true, force: true });
    throw new Error(
      `source_mutant_compile_failed:${mutation.id}\n${compiled.stdout}${compiled.stderr}`,
    );
  }
  return { workspace, outputDir };
}

function assertBaseline() {
  const tests = [...policy.source, ...policy.acceptance].flatMap(
    (mutation) => mutation.tests,
  );
  const result = runTests([...new Set(tests)]);
  if (result.status !== 0) {
    throw new Error(`mutation_baseline_failed\n${result.output}`);
  }
  console.log("mutation baseline passed");
}

function runSourceMutations() {
  let killed = 0;
  for (const mutation of policy.source) {
    const { workspace, outputDir } = compileSourceMutation(mutation);
    try {
      const result = runTests(mutation.tests, {
        RIN_MUTATION_DIST_ROOT: outputDir,
      });
      if (isBehavioralKill(result)) {
        killed += 1;
        console.log(`KILLED source/${mutation.id}`);
      } else {
        console.error(`SURVIVED source/${mutation.id}\n${result.output}`);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
  return assertMutationScore("source", killed, policy.source.length);
}

function runAcceptanceMutations() {
  let killed = 0;
  for (const mutation of policy.acceptance) {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), `rin-acceptance-mutant-${mutation.id}-`),
    );
    try {
      const featurePath = path.join(rootDir, mutation.feature);
      const mutatedPath = path.join(workspace, path.basename(featurePath));
      fs.writeFileSync(
        mutatedPath,
        replaceExactlyOnce(
          fs.readFileSync(featurePath, "utf8"),
          mutation.search,
          mutation.replacement,
        ),
      );
      const result = runTests(mutation.tests, {
        RIN_ACCEPTANCE_FEATURE_PATH: mutatedPath,
      });
      if (isBehavioralKill(result)) {
        killed += 1;
        console.log(`KILLED acceptance/${mutation.id}`);
      } else {
        console.error(`SURVIVED acceptance/${mutation.id}\n${result.output}`);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
  return assertMutationScore("acceptance", killed, policy.acceptance.length);
}

function assertMutationScore(
  kind: keyof MutationPolicy["thresholds"],
  killed: number,
  total: number,
) {
  if (total === 0) throw new Error(`mutation_policy_empty:${kind}`);
  const score = (killed / total) * 100;
  const threshold = policy.thresholds[kind];
  console.log(
    `${kind} mutation score: ${killed}/${total} (${score.toFixed(1)}%, required ${threshold}%)`,
  );
  if (score < threshold) {
    throw new Error(
      `mutation_score_below_threshold:${kind}:${score}:${threshold}`,
    );
  }
}

requireTestContainer();
assertBaseline();
runSourceMutations();
runAcceptanceMutations();
