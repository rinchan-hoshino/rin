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

test("local CI runner enables inner install-to-TUI smoke before tests", () => {
  const runner = readRepoFile(".ci/local-ci/run-checks.sh");
  const envIndex = runner.indexOf("export RIN_INSTALL_TUI_CONTAINER_INNER=1");
  const testIndex = runner.indexOf("npm test");

  assert.notEqual(envIndex, -1);
  assert.notEqual(testIndex, -1);
  assert.ok(envIndex < testIndex);
});

test("local CI runner preserves staged format target filtering", () => {
  const runner = readRepoFile(".ci/local-ci/run-checks.sh");
  const targetBranchIndex = runner.indexOf('if [[ -n "${FORMAT_TARGETS:-}" ]]');
  const targetFilterIndex = runner.indexOf(
    "mapfile -t format_targets < <(printf '%s\\n' \"$FORMAT_TARGETS\" | sed '/^$/d')",
  );
  const targetedCheckIndex = runner.indexOf(
    'npm run format:check -- "${format_targets[@]}"',
  );
  const lintIndex = runner.indexOf("npm run lint");

  assert.notEqual(targetBranchIndex, -1);
  assert.notEqual(targetFilterIndex, -1);
  assert.notEqual(targetedCheckIndex, -1);
  assert.notEqual(lintIndex, -1);
  assert.ok(targetBranchIndex < targetFilterIndex);
  assert.ok(targetFilterIndex < targetedCheckIndex);
  assert.ok(targetedCheckIndex < lintIndex);
  assert.match(runner, /No staged files need format checking\./);
});
