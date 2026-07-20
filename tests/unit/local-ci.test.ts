import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function indexOfRequired(content: string, needle: string) {
  const index = content.indexOf(needle);
  assert.notEqual(index, -1, `missing expected content: ${needle}`);
  return index;
}

function assertOrdered(content: string, needles: string[]) {
  let previous = -1;
  for (const needle of needles) {
    const index = indexOfRequired(content, needle);
    assert.ok(
      index > previous,
      `${needle} should appear after previous marker`,
    );
    previous = index;
  }
}

test("local CI container includes install-to-TUI smoke prerequisites", () => {
  const dockerfile = readRepoFile(".ci/local-ci/Dockerfile");

  assert.match(dockerfile, /apt-get install[^\n]*\butil-linux\b/);
  assert.match(
    dockerfile,
    /COPY \.ci\/local-ci\/run-checks\.sh \/usr\/local\/bin\/rin-local-ci-runner/,
  );
  assert.match(
    dockerfile,
    /ENTRYPOINT \["\/usr\/local\/bin\/rin-local-ci-runner"\]/,
  );
});

test("local CI container includes commands required by update workflow tests", () => {
  const dockerfile = readRepoFile(".ci/local-ci/Dockerfile");

  assert.match(dockerfile, /apt-get install[^\n]*\bcurl\b/);
  assert.match(dockerfile, /apt-get install[^\n]*\btar\b/);
});

test("local CI image preloads managed npm for network-isolated update tests", () => {
  const dockerfile = readRepoFile(".ci/local-ci/Dockerfile");
  const updateWorkflow = readRepoFile(
    "src/core/rin-install/update-workflow.ts",
  );
  const version = updateWorkflow.match(/MANAGED_NPM_VERSION = "([^"]+)"/)?.[1];

  assert.ok(version, "missing managed npm version");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    dockerfile,
    new RegExp(
      `npm pack npm@${escapedVersion}\\b[^\\n]*--pack-destination /root/\\.cache/rin/node-toolchain\\b`,
    ),
  );
});

test("local CI image includes prepare hook input before npm install", () => {
  const dockerfile = readRepoFile(".ci/local-ci/Dockerfile");

  assertOrdered(dockerfile, [
    "COPY package.json package-lock.json ./",
    "COPY scripts/install-git-hooks.ts ./scripts/install-git-hooks.ts",
    "RUN npm ci",
  ]);
});

test("local CI runner reuses image dependencies before repo checks", () => {
  const runner = readRepoFile(".ci/local-ci/run-checks.sh");

  assertOrdered(runner, [
    'cd "$workdir/repo"',
    "ln -s /opt/rin/node_modules node_modules",
    'export PATH="/opt/rin/node_modules/.bin:$PATH"',
    "npm run format:check",
    "npm run lint",
    "npm test",
  ]);
});

test("repository test scripts bound default test concurrency", () => {
  const packageJson = JSON.parse(readRepoFile("package.json"));

  assert.match(packageJson.scripts["test:unit"], /--test-concurrency=4/);
  assert.match(packageJson.scripts["test:release"], /--test-concurrency=4/);
  assert.match(packageJson.scripts["test:e2e"], /--test-concurrency=2/);
  assert.match(packageJson.scripts["test:interactive"], /--test-concurrency=2/);
});

test("local CI runner enables inner install-to-TUI smoke before tests", () => {
  const runner = readRepoFile(".ci/local-ci/run-checks.sh");

  assertOrdered(runner, [
    "export RIN_INSTALL_TUI_CONTAINER_INNER=1",
    "npm test",
  ]);
});

test("local CI runner bounds the full test gate", () => {
  const runner = readRepoFile(".ci/local-ci/run-checks.sh");

  assertOrdered(runner, [
    'ci_timeout="45m"',
    'timeout --foreground "$ci_timeout" npm test',
  ]);
});

test("local CI runner preserves staged format target filtering", () => {
  const runner = readRepoFile(".ci/local-ci/run-checks.sh");

  assertOrdered(runner, [
    'if [[ "${FORMAT_TARGETS_SET:-}" == "1" ]]',
    "mapfile -t format_targets < <(printf '%s\\n' \"${FORMAT_TARGETS:-}\" | sed '/^$/d')",
    'npm run format:check -- "${format_targets[@]}"',
    "npm run lint",
  ]);
  assert.match(runner, /No staged files need format checking\./);
});

test("pre-commit runs only the bounded containerized local CI", () => {
  const hook = readRepoFile(".githooks/pre-commit");

  assertOrdered(hook, [
    'docker build -f .ci/local-ci/Dockerfile -t "$image_tag" .',
    'git archive --format=tar "$tree_id" >"$archive_file"',
    "docker run --rm --network none --memory 4g --memory-swap 4g",
  ]);
  assert.doesNotMatch(hook, /run_host_checks/);
  assert.doesNotMatch(hook, /fallback/i);
  assert.doesNotMatch(hook, /npm run lint/);
  assert.doesNotMatch(hook, /npm test/);
});
