import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { networkIsolatedNodeInvocation } from "../../scripts/test/network-isolated-process.js";
import {
  sourceUsesAmbientNetwork,
  sourceWritesFixedHostPath,
} from "../../scripts/test/verify-test-architecture.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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

  assert.match(dockerfile, /^FROM node:22\.19\.0-bookworm-slim$/m);
  assert.match(dockerfile, /apt-get install[^\n]*\butil-linux\b/);
  assert.match(
    dockerfile,
    /COPY \.ci\/local-ci\/run-checks\.sh \/usr\/local\/bin\/rin-local-ci-runner/,
  );
  assert.match(dockerfile, /^USER node$/m);
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

test("repository test scripts route classified buckets through the shared runner", () => {
  const packageJson = JSON.parse(readRepoFile("package.json"));
  const runner = readRepoFile("scripts/test/run-test-suite.ts");

  for (const bucket of [
    "architecture",
    "unit",
    "regression",
    "characterization",
    "integration",
    "system",
  ]) {
    assert.equal(
      packageJson.scripts[`test:${bucket}:run`],
      `tsx scripts/test/run-test-suite.ts ${bucket}`,
    );
  }
  assert.match(packageJson.scripts["test:release:run"], /--concurrency=4/);
  for (const [name, command] of Object.entries<string>(packageJson.scripts)) {
    if (name.startsWith("test:")) {
      assert.doesNotMatch(command, /(^|\s)node\b[^&]*--test\b/);
    }
  }
  assert.match(runner, /suites\.includes\("system"\) \? 2 : 4/);
});

test("all automated test launchers use the isolated process environment", () => {
  for (const file of [
    "scripts/test/run-test-suite.ts",
    "scripts/test/run-test-files.ts",
    "scripts/test/run-coverage.ts",
  ]) {
    const launcher = readRepoFile(file);
    assert.match(launcher, /createTestProcessEnvironment/);
    assert.match(launcher, /networkIsolatedNodeInvocation/);
    assert.match(launcher, /scripts\/test\/run-node-tests\.ts/);
    assert.match(launcher, /--test-reporter=tap/);
  }
  const resultWrapper = readRepoFile("scripts/test/run-node-tests.ts");
  assert.match(resultWrapper, /test_summary_missing/);
  assert.match(resultWrapper, /test_summary_rejected/);
});

test("system gate cannot silently skip when the container runtime is absent", () => {
  const systemTest = readRepoFile(
    "tests/system/install-to-tui-user-flow.test.ts",
  );
  const harness = readRepoFile("tests/support/install-to-tui-harness.ts");

  assert.doesNotMatch(systemTest, /\.skip\s*\(/);
  assert.doesNotMatch(systemTest, /result\.skipped/);
  assert.match(harness, /missing docker or podman[^\n]*install-to-TUI smoke/);
});

test("test launcher creates a loopback-only network namespace", () => {
  const invocation = networkIsolatedNodeInvocation(
    ["-e", ""],
    {
      ...process.env,
      RIN_TEST_NETWORK_NAMESPACE_INNER: undefined,
      RIN_SYSTEM_TEST_CONTAINER_INNER: undefined,
    },
    { commandExists: () => true },
  );
  assert.equal(invocation.command, "unshare");
  assert.ok(invocation.args.includes("--net"));
  assert.ok(invocation.args.includes('ip link set lo up && exec "$@"'));
  assert.equal(invocation.env.RIN_TEST_NETWORK_NAMESPACE_INNER, "1");
  assert.throws(
    () =>
      networkIsolatedNodeInvocation(
        ["-e", ""],
        {
          ...process.env,
          RIN_TEST_NETWORK_NAMESPACE_INNER: undefined,
          RIN_SYSTEM_TEST_CONTAINER_INNER: undefined,
        },
        { commandExists: (command) => command !== "ip" },
      ),
    /network_isolation_command_missing:ip/,
  );
});

test("test result wrapper rejects skips and todos", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rin-skip-probe-"));
  const probe = path.join(directory, "skip.test.mjs");
  try {
    fs.writeFileSync(
      probe,
      'import test from "node:test"; test.skip("must fail closed", () => {});',
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/test/run-node-tests.ts",
        "--test",
        "--test-reporter=tap",
        probe,
      ],
      {
        cwd: rootDir,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test_summary_rejected:skipped=1:todo=0/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("strict unit boundary rejects ambient network APIs and clients", () => {
  for (const source of [
    'fetch("https://example.invalid")',
    'new WebSocket("wss://example.invalid")',
    'globalThis["EventSource"]("https://example.invalid")',
    "globalThis[`fetch`]('https://example.invalid')",
    'import axios from "axios"',
    'const client = await import("undici")',
    "const templateClient = await import(`undici`)",
    'const socket = require("ws")',
    "const templateSocket = require(`axios`)",
    'import legacyClient = require("axios")',
    'import dns from "node:dns"',
  ]) {
    assert.equal(sourceUsesAmbientNetwork(source), true, source);
  }
  assert.equal(
    sourceUsesAmbientNetwork(
      'import test from "node:test"; import value from "../fixture.js";',
    ),
    false,
  );
});

test("fixed host path gate recognizes every fs module loading form", () => {
  for (const source of [
    "const fs = require(`node:fs`); fs.writeFileSync('/home/user/.rin/state', 'x')",
    "const fs = require('fs'); fs.writeFileSync('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; fs.writeFileSync('/home/user/.rin/state', 'x')",
    "import fs = require('fs/promises'); fs.writeFile('/Users/user/.rin/state', 'x')",
    "require('fs').writeFileSync('/home/user/.rin/state', 'x')",
    "require('fs')[`writeFileSync`]('/home/user/.rin/state', 'x')",
    "(await import('node:fs/promises')).writeFile('/home/user/.rin/state', 'x')",
    "(require('fs').writeFileSync)('/home/user/.rin/state', 'x')",
    "(await import('fs'))[`promises`][`writeFile`]('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; (fs satisfies typeof import('fs')).writeFileSync('/home/user/.rin/state', 'x')",
    "const write = require('fs').writeFileSync; write('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; const write = fs.writeFileSync; const alias = write; alias('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; const fsp = fs[`promises`]; fsp.writeFile('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; const alias = fs; alias.writeFileSync('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; const fsp = fs.promises; const alias = fsp; alias.writeFile('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; const { promises: fsp } = fs; fsp.writeFile('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; const { writeFileSync: write } = fs; write('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; const { promises: { writeFile } } = fs; writeFile('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; const { promises: { 'writeFile': write } } = fs; write('/home/user/.rin/state', 'x')",
    "import fs from 'fs'; const { promises: { [`writeFile`]: write } } = fs; write('/home/user/.rin/state', 'x')",
  ]) {
    assert.equal(sourceWritesFixedHostPath(source), true, source);
  }
});

test("local CI runner enables inner install-to-TUI smoke before tests", () => {
  const runner = readRepoFile(".ci/local-ci/run-checks.sh");

  assertOrdered(runner, [
    "export RIN_INSTALL_TUI_CONTAINER_INNER=1",
    "export RIN_SYSTEM_TEST_CONTAINER_INNER=1",
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

test("publish workflows build the isolated system-test image before release validation", () => {
  for (const file of [
    ".github/workflows/publish-beta.yml",
    ".github/workflows/publish-hotfix.yml",
    ".github/workflows/publish-nightly.yml",
    ".github/workflows/publish-stable.yml",
  ]) {
    assertOrdered(readRepoFile(file), [
      "docker build -f .ci/local-ci/Dockerfile -t rin-local-ci:latest .",
      "npm run test:release",
    ]);
  }
});

test("pre-commit runs only the bounded containerized local CI", () => {
  const hook = readRepoFile(".githooks/pre-commit");

  assertOrdered(hook, [
    'tree_id="$(git write-tree)"',
    'image_tag="rin-local-ci:staged-${tree_id}-$$"',
    'git archive --format=tar "$tree_id" >"$archive_file"',
    'docker build -f .ci/local-ci/Dockerfile -t "$image_tag" - <"$archive_file"',
    'image_id="$(docker image inspect --format \'{{.Id}}\' "$image_tag")"',
    "docker run --rm --network none --memory 4g --memory-swap 4g",
  ]);
  assert.match(hook, /-i "\$image_id" <"\$archive_file"/);
  assert.doesNotMatch(hook, /run_host_checks/);
  assert.doesNotMatch(hook, /fallback/i);
  assert.doesNotMatch(hook, /npm run lint/);
  assert.doesNotMatch(hook, /npm test/);
});
