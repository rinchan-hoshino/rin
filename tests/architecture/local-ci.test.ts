import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { networkIsolatedNodeInvocation } from "../../scripts/test/network-isolated-process.js";
import { requireTestContainer } from "../../scripts/test/require-test-container.js";
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

  assert.match(
    dockerfile,
    /^FROM node:22\.19\.0-bookworm-slim AS dependencies$/m,
  );
  assert.match(dockerfile, /^FROM dependencies AS test-runner$/m);
  assert.match(dockerfile, /apt-get install[^\n]*\butil-linux\b/);
  assert.match(dockerfile, /COPY --chown=node:node \. \/opt\/rin\/source/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(
    dockerfile,
    /ENTRYPOINT \["\/opt\/rin\/source\/\.ci\/local-ci\/run-checks\.sh"\]/,
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
    "cd /opt/rin/source",
    'export PATH="/opt/rin/node_modules/.bin:$PATH"',
    "npm run format:check",
    "npm run lint",
    "npm run build",
    "npm run test:types:run",
    "npm run test:inner",
  ]);
  assert.doesNotMatch(
    runner,
    /npm run test:(?:regression|integration|system):run/,
  );
  const packageJson = JSON.parse(readRepoFile("package.json")) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(packageJson.scripts["test:inner"], /npm run build/);
});

test("the commit gate runs isolated suites concurrently and keeps slow calibration explicit", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as {
    scripts: Record<string, string>;
  };
  const commitRunner = readRepoFile("scripts/test/run-commit-tests.ts");

  assert.equal(
    packageJson.scripts["test:current:run"],
    "tsx scripts/test/run-commit-tests.ts",
  );
  for (const suite of [
    "architecture",
    "unit",
    "acceptance",
    "property",
    "regression",
    "integration",
    "system",
    "qa",
    "torture",
  ]) {
    assert.match(commitRunner, new RegExp(`"${suite}"`));
  }
  assert.match(commitRunner, /mapWithConcurrency\(suites, 3/);
  assert.match(packageJson.scripts["test:inner"], /test:current:run/);
  assert.doesNotMatch(
    packageJson.scripts["test:inner"],
    /test:coverage:run|test:mutation:run/,
  );
  assert.equal(
    packageJson.scripts["test:coverage"],
    "npm run test:container -- --suite coverage",
  );
  assert.equal(
    packageJson.scripts["test:mutation"],
    "npm run test:container -- --suite mutation",
  );
});

test("repository test scripts route classified buckets through the shared runner", () => {
  const packageJson = JSON.parse(readRepoFile("package.json"));
  const runner = readRepoFile("scripts/test/run-test-suite.ts");

  for (const bucket of [
    "architecture",
    "unit",
    "regression",
    "integration",
    "system",
  ]) {
    assert.equal(
      packageJson.scripts[`test:${bucket}:run`],
      `tsx scripts/test/run-test-suite.ts ${bucket}`,
    );
  }
  assert.match(packageJson.scripts["test:release:run"], /--concurrency=4/);
  assert.match(
    packageJson.scripts["test:release:run"],
    /tests\/integration\/rin-cli\.test\.ts/,
  );
  for (const [name, command] of Object.entries<string>(packageJson.scripts)) {
    if (name.startsWith("test:")) {
      assert.doesNotMatch(command, /(^|\s)node\b[^&]*--test\b/);
    }
  }
  assert.match(runner, /suites\.includes\("system"\) \? 2 : 4/);
});

test("package scripts reference only existing explicit test targets", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as {
    scripts: Record<string, string>;
  };
  const explicitTargets = new Set(
    Object.values(packageJson.scripts).flatMap((command) =>
      [...command.matchAll(/\btests\/[^\s"'&|;]+\.test\.[cm]?[jt]s\b/g)].map(
        (match) => match[0],
      ),
    ),
  );

  for (const target of explicitTargets) {
    const targetPath = path.join(rootDir, target);
    assert.equal(
      fs.existsSync(targetPath),
      true,
      `missing package-script test target: ${target}`,
    );
    assert.equal(
      fs.statSync(targetPath).isFile(),
      true,
      `package-script test target is not a file: ${target}`,
    );
  }
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

test("test launchers fail closed outside the local CI container", () => {
  assert.throws(
    () => requireTestContainer({ RIN_SYSTEM_TEST_CONTAINER_INNER: "1" }, false),
    /test_container_required:use_npm_run_test_container/,
  );

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/test/run-test-files.ts",
      "tests/architecture/socket-sandbox.test.ts",
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        RIN_INSTALL_TUI_CONTAINER_INNER: undefined,
        RIN_SYSTEM_TEST_CONTAINER_INNER: undefined,
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /test_container_required:use_npm_run_test_container/,
  );
});

test("node test wrapper accepts behavior output larger than the spawn default", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-node-test-buffer-owner-"),
  );
  const testFile = path.join(tempDir, "large-output.test.mjs");
  fs.writeFileSync(
    testFile,
    `import test from "node:test";\ntest("large output", () => console.log("x".repeat(2 * 1024 * 1024)));\n`,
  );
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/test/run-node-tests.ts", "--test", testFile],
      {
        cwd: rootDir,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => name !== "NODE_TEST_CONTEXT",
          ),
        ),
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /# tests 1/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("node test wrapper rejects missing explicit test targets before spawning", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-missing-test-target-"),
  );
  const existingFile = path.join(tempDir, "existing.test.mjs");
  const missingFile = path.join(tempDir, "missing.test.mjs");
  fs.writeFileSync(
    existingFile,
    'import test from "node:test"; test("must not start", () => {});\n',
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/test/run-node-tests.ts",
        "--test",
        existingFile,
        missingFile,
      ],
      {
        cwd: rootDir,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => name !== "NODE_TEST_CONTEXT",
          ),
        ),
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test_file_missing:/);
    assert.doesNotMatch(result.stdout, /# tests 1/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("node test wrapper rejects explicit targets that are not regular files", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-non-file-test-target-"),
  );
  const directoryTarget = path.join(tempDir, "directory.test.mjs");
  fs.mkdirSync(directoryTarget);
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/test/run-node-tests.ts",
        "--test",
        directoryTarget,
      ],
      {
        cwd: rootDir,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => name !== "NODE_TEST_CONTEXT",
          ),
        ),
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test_file_not_regular:/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("working-tree test wrapper enters a networkless container without host mounts", () => {
  const wrapper = readRepoFile("scripts/test/run-containerized.sh");

  assert.match(wrapper, /GIT_INDEX_FILE/);
  assert.match(wrapper, /git archive --format=tar[\s\\]+--mtime=/);
  assert.match(
    readRepoFile("scripts/test/require-test-container.ts"),
    /\.dockerenv/,
  );
  assert.match(
    wrapper,
    /scripts\/test\/build-test-image\.sh "\$archive_file" "\$image_tag"/,
  );
  const imageBuilder = readRepoFile("scripts/test/build-test-image.sh");
  assert.match(imageBuilder, /--target dependencies/);
  assert.match(imageBuilder, /--cache-from "\$dependency_tag"/);
  assert.match(imageBuilder, /image inspect "\$dependency_tag"/);
  assert.match(imageBuilder, /image inspect "\$image_tag"/);
  assert.match(wrapper, /archive_fingerprint=.*sha256sum/);
  assert.match(wrapper, /rin-local-ci:source-/);
  assert.doesNotMatch(wrapper, /docker image rm/);
  assert.match(wrapper, /docker_args=\(run --rm --network none/);
  assert.match(wrapper, /docker "\$\{docker_args\[@\]\}"/);
  assert.doesNotMatch(wrapper, /--volume|^\s+-v(?:\s|=)|\/run\/user|\.rin:/m);
  const dockerfile = readRepoFile(".ci/local-ci/Dockerfile");
  assert.match(dockerfile, /COPY --chown=node:node \. \/opt\/rin\/source/);
  assert.match(dockerfile, /ENTRYPOINT \["\/opt\/rin\/source\//);
  assert.doesNotMatch(readRepoFile(".ci/local-ci/run-checks.sh"), /tar -xf/);
  assert.doesNotMatch(readRepoFile(".ci/local-ci/run-selected.sh"), /tar -xf/);

  const packageJson = JSON.parse(readRepoFile("package.json")) as {
    scripts: Record<string, string>;
  };
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (
      (name === "test" || name.startsWith("test:")) &&
      name !== "test:container" &&
      name !== "test:inner" &&
      !name.endsWith(":run")
    ) {
      assert.match(command, /npm run test:container/, name);
    }
  }
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
    "npm run test:inner",
  ]);
});

test("local CI delegates the complete ordinary gate to one runner", () => {
  const runner = readRepoFile(".ci/local-ci/run-checks.sh");

  assert.doesNotMatch(
    runner,
    /npm run test:(?:release|architecture|acceptance|property):run/,
  );
  assert.match(runner, /npm run test:inner/);
});

test("local CI runner bounds the full test gate", () => {
  const runner = readRepoFile(".ci/local-ci/run-checks.sh");

  assertOrdered(runner, [
    'ci_timeout="45m"',
    'timeout --foreground "$ci_timeout" bash -c',
    "npm run test:inner",
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

test("pre-commit delegates staged file type decisions to Prettier", () => {
  const hook = readRepoFile(".githooks/pre-commit");

  assert.match(hook, /git diff --cached --name-only --diff-filter=ACMR\s*\)/);
  assert.doesNotMatch(hook, /grep -E|ts\|md\|json\|yml\|yaml/);
});

test("pre-commit is the sole complete repository gate", () => {
  const hook = readRepoFile(".githooks/pre-commit");

  assertOrdered(hook, [
    'tree_id="$(git write-tree)"',
    'image_tag="rin-local-ci:staged-${tree_id}"',
    "git archive --format=tar --mtime=1970-01-01T00:00:00Z",
    'scripts/test/build-test-image.sh "$archive_file" "$image_tag"',
    'image_id="$(docker image inspect --format \'{{.Id}}\' "$image_tag")"',
    "docker run --rm --network none --memory 4g --memory-swap 4g",
  ]);
  assert.doesNotMatch(hook, /--volume|^\s+-v(?:\s|=)/m);
  assert.doesNotMatch(hook, /run-staged|STAGED_FILES|fallback/i);
  assert.equal(
    fs.existsSync(path.join(rootDir, ".githooks", "pre-push")),
    false,
  );
});
