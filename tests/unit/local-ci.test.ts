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

test("local CI runner enables inner install-to-TUI smoke before tests", () => {
  const runner = readRepoFile(".ci/local-ci/run-checks.sh");

  assertOrdered(runner, [
    "export RIN_INSTALL_TUI_CONTAINER_INNER=1",
    "npm test",
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

test("pre-commit falls back to host checks when docker cannot start containers", () => {
  const hook = readRepoFile(".githooks/pre-commit");

  assertOrdered(hook, [
    "run_host_checks()",
    "npm run format:check",
    "npm run lint",
    "npm test",
  ]);
  assert.match(hook, /failed to create TTRPC connection/);
  assert.match(
    hook,
    /docker cannot start containers in this environment; falling back to host checks/,
  );
});
