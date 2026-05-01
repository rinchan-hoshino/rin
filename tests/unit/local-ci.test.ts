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
