import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(rootDir, prefix));
}

function readWorkflow(workflow) {
  return fs.readFileSync(
    path.join(rootDir, ".github", "workflows", workflow),
    "utf8",
  );
}

function runReleaseScript(script, args, options = {}) {
  return execFileSync(
    process.execPath,
    [path.join(rootDir, "scripts", "release", script), ...args],
    {
      cwd: options.cwd || rootDir,
      stdio: "pipe",
      encoding: "utf8",
      env: options.env || process.env,
    },
  );
}

function assertReleaseScriptFails(script, args, pattern, options = {}) {
  try {
    runReleaseScript(script, args, options);
    assert.fail(`${script} unexpectedly succeeded`);
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}${error.message || ""}`;
    assert.match(output, pattern);
  }
}

test("update-release-manifest script writes stable npm tarball metadata", () => {
  const tempDir = makeTempDir(".tmp-release-script-");
  try {
    const manifestPath = path.join(tempDir, "release-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        packageName: "@hoshinorin/rin",
        repoUrl: "https://github.com/rinchan-hoshino/rin",
        train: { series: "1.2", nightlyBranch: "main" },
        stable: { version: "1.2.2", archiveUrl: "https://example.com/old.tgz" },
        beta: {
          version: "1.2.3-beta.20260420",
          archiveUrl: "https://example.com/beta.tgz",
          ref: "abc1234",
          promotionVersion: "1.2.3",
        },
        nightly: {
          version: "1.2.4-nightly.20260420+abc1234",
          archiveUrl: "https://example.com/nightly.tgz",
          ref: "abc1234",
          branch: "main",
        },
        git: { defaultBranch: "main" },
      }),
    );
    execFileSync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "update-release-manifest.ts"),
        "--manifest",
        manifestPath,
        "--channel",
        "stable",
        "--version",
        "1.2.3",
        "--ref",
        "deadbeef",
        "--from-beta-version",
        "1.2.3-beta.20260420",
        "--asset-platform",
        "linux-x64",
        "--asset-url",
        "https://github.com/rinchan-hoshino/rin/releases/download/v1.2.3/rin-1.2.3-linux-x64.tar.gz",
        "--asset-sha256",
        "abc123",
        "--asset-node-version",
        "24.18.0",
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    const next = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(next.packageName, "@hoshinorin/rin");
    assert.equal(next.stable.version, "1.2.3");
    assert.equal(next.stable.ref, "deadbeef");
    assert.equal(next.stable.promotedFromBetaVersion, "1.2.3-beta.20260420");
    assert.equal(
      next.stable.archiveUrl,
      "https://registry.npmjs.org/%40hoshinorin%2Frin/-/rin-1.2.3.tgz",
    );
    assert.equal(
      next.stable.versions["1.2.3"].archiveUrl,
      "https://registry.npmjs.org/%40hoshinorin%2Frin/-/rin-1.2.3.tgz",
    );
    assert.deepEqual(next.stable.assets["linux-x64"], {
      bundleUrl:
        "https://github.com/rinchan-hoshino/rin/releases/download/v1.2.3/rin-1.2.3-linux-x64.tar.gz",
      sha256: "abc123",
      nodeVersion: "24.18.0",
    });
    assert.deepEqual(next.stable.versions["1.2.3"].assets["linux-x64"], {
      bundleUrl:
        "https://github.com/rinchan-hoshino/rin/releases/download/v1.2.3/rin-1.2.3-linux-x64.tar.gz",
      sha256: "abc123",
      nodeVersion: "24.18.0",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("update-release-manifest script writes beta and nightly pinned ref metadata", () => {
  const tempDir = makeTempDir(".tmp-release-script-");
  try {
    const manifestPath = path.join(tempDir, "release-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        packageName: "@hoshinorin/rin",
        repoUrl: "https://github.com/rinchan-hoshino/rin",
        train: { series: "1.2", nightlyBranch: "main" },
        stable: {
          version: "1.2.3",
          archiveUrl:
            "https://registry.npmjs.org/%40hoshinorin%2Frin/-/rin-1.2.3.tgz",
        },
        beta: {},
        nightly: {},
        git: { defaultBranch: "main" },
      }),
    );
    execFileSync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "update-release-manifest.ts"),
        "--manifest",
        manifestPath,
        "--channel",
        "beta",
        "--version",
        "1.2.4-beta.20260420",
        "--ref",
        "deadbeef",
        "--promotion-version",
        "1.2.4",
        "--asset-platform",
        "linux-x64",
        "--asset-url",
        "https://github.com/rinchan-hoshino/rin/releases/download/v1.2.4-beta.20260420/rin-1.2.4-beta.20260420-linux-x64.tar.gz",
        "--asset-sha256",
        "beta123",
        "--asset-node-version",
        "24.18.0",
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    execFileSync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "update-release-manifest.ts"),
        "--manifest",
        manifestPath,
        "--channel",
        "nightly",
        "--version",
        "1.2.5-nightly.20260420+deadbee",
        "--ref",
        "deadbeef",
        "--branch",
        "main",
        "--asset-platform",
        "linux-x64",
        "--asset-url",
        "https://github.com/rinchan-hoshino/rin/releases/download/v1.2.5-nightly.20260420+deadbee/rin-1.2.5-nightly.20260420+deadbee-linux-x64.tar.gz",
        "--asset-sha256",
        "nightly123",
        "--asset-node-version",
        "24.18.0",
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    const next = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(next.beta.version, "1.2.4-beta.20260420");
    assert.equal(next.beta.ref, "deadbeef");
    assert.equal(next.beta.promotionVersion, "1.2.4");
    assert.deepEqual(next.beta.assets["linux-x64"], {
      bundleUrl:
        "https://github.com/rinchan-hoshino/rin/releases/download/v1.2.4-beta.20260420/rin-1.2.4-beta.20260420-linux-x64.tar.gz",
      sha256: "beta123",
      nodeVersion: "24.18.0",
    });
    assert.equal(
      next.beta.archiveUrl,
      "https://codeload.github.com/rinchan-hoshino/rin/tar.gz/deadbeef",
    );
    assert.equal(next.nightly.version, "1.2.5-nightly.20260420+deadbee");
    assert.equal(next.nightly.ref, "deadbeef");
    assert.equal(next.nightly.branch, "main");
    assert.deepEqual(next.nightly.assets["linux-x64"], {
      bundleUrl:
        "https://github.com/rinchan-hoshino/rin/releases/download/v1.2.5-nightly.20260420+deadbee/rin-1.2.5-nightly.20260420+deadbee-linux-x64.tar.gz",
      sha256: "nightly123",
      nodeVersion: "24.18.0",
    });
    assert.equal(
      next.nightly.archiveUrl,
      "https://codeload.github.com/rinchan-hoshino/rin/tar.gz/deadbeef",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("plan-release script computes beta nightly and stable promotion versions", () => {
  const tempDir = makeTempDir(".tmp-release-plan-");
  try {
    const manifestPath = path.join(tempDir, "release-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        train: { series: "1.2", nightlyBranch: "main" },
        stable: { version: "1.2.3" },
        beta: { version: "1.3.0-beta.20260420" },
      }),
    );
    const betaPlan = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(rootDir, "scripts", "release", "plan-release.ts"),
          "--manifest",
          manifestPath,
          "--channel",
          "beta",
          "--date",
          "20260427",
        ],
        { cwd: rootDir, stdio: "pipe", encoding: "utf8" },
      ),
    );
    assert.deepEqual(betaPlan, {
      series: "1.3",
      promotionVersion: "1.3.0",
      version: "1.3.0-beta.20260427",
    });

    const nightlyPlan = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(rootDir, "scripts", "release", "plan-release.ts"),
          "--manifest",
          manifestPath,
          "--channel",
          "nightly",
          "--date",
          "20260427",
          "--ref",
          "deadbeefcafebabe",
        ],
        { cwd: rootDir, stdio: "pipe", encoding: "utf8" },
      ),
    );
    assert.deepEqual(nightlyPlan, {
      series: "1.3",
      promotionVersion: "1.3.0",
      version: "1.3.0-nightly.20260427+deadbee",
    });

    const stablePlan = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(rootDir, "scripts", "release", "plan-release.ts"),
          "--manifest",
          manifestPath,
          "--channel",
          "stable-promotion",
          "--beta-version",
          "1.3.0-beta.20260420",
        ],
        { cwd: rootDir, stdio: "pipe", encoding: "utf8" },
      ),
    );
    assert.deepEqual(stablePlan, {
      series: "1.3",
      promotionVersion: "1.3.0",
      version: "1.3.0",
    });

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        train: { series: "1.2", nightlyBranch: "main" },
        stable: { version: "1.3.0" },
      }),
    );
    const hotfixAwareStablePlan = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(rootDir, "scripts", "release", "plan-release.ts"),
          "--manifest",
          manifestPath,
          "--channel",
          "stable-promotion",
          "--beta-version",
          "1.3.0-beta.20260420",
        ],
        { cwd: rootDir, stdio: "pipe", encoding: "utf8" },
      ),
    );
    assert.deepEqual(hotfixAwareStablePlan, {
      series: "1.3",
      promotionVersion: "1.3.0",
      version: "1.3.1",
    });

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        stable: { version: "2.3.4" },
      }),
    );
    const implicitSeriesBetaPlan = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(rootDir, "scripts", "release", "plan-release.ts"),
          "--manifest",
          manifestPath,
          "--channel",
          " beta ",
          "--date",
          "20260427",
        ],
        { cwd: rootDir, stdio: "pipe", encoding: "utf8" },
      ),
    );
    assert.deepEqual(implicitSeriesBetaPlan, {
      series: "2.4",
      promotionVersion: "2.4.0",
      version: "2.4.0-beta.20260427",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("release scripts reject value options without explicit values", () => {
  const cases = [
    ["update-release-manifest.ts", "--manifest"],
    ["update-release-manifest.ts", "--version"],
    ["plan-release.ts", "--manifest"],
    ["plan-release.ts", "--channel"],
    ["verify-changelog.ts", "--changelog"],
    ["verify-changelog.ts", "--version"],
  ];

  for (const [script, option] of cases) {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(rootDir, "scripts", "release", script), option],
          { cwd: rootDir, stdio: "pipe" },
        ),
      new RegExp(`missing_value:${option}`),
    );
  }
});

test("verify-changelog script requires a target Rin changelog heading", () => {
  const tempDir = makeTempDir(".tmp-release-changelog-");
  try {
    const changelogPath = path.join(tempDir, "CHANGELOG.md");
    fs.writeFileSync(
      changelogPath,
      ["# Rin Changelog", "", "## 1.2.3", "", "- Ready", ""].join("\n"),
      "utf8",
    );
    runReleaseScript("verify-changelog.ts", [
      "--changelog",
      changelogPath,
      "--version",
      "1.2.3",
    ]);
    assertReleaseScriptFails(
      "verify-changelog.ts",
      ["--changelog", changelogPath, "--version", "1.2.4"],
      /Missing Rin changelog entry for 1\.2\.4/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runGit(repoDir, args) {
  return execFileSync("git", args, {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Rin Release Test",
      GIT_AUTHOR_EMAIL: "rin@example.invalid",
      GIT_COMMITTER_NAME: "Rin Release Test",
      GIT_COMMITTER_EMAIL: "rin@example.invalid",
    },
  }).trim();
}

function commitAll(repoDir, message) {
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", message]);
  return runGit(repoDir, ["rev-parse", "HEAD"]);
}

test("verify-changelog script requires concrete release note bullets", () => {
  const tempDir = makeTempDir(".tmp-release-changelog-");
  try {
    const changelogPath = path.join(tempDir, "CHANGELOG.md");
    fs.writeFileSync(
      changelogPath,
      ["# Rin Changelog", "", "## 1.2.3", "", "", "## 1.2.2", ""].join("\n"),
      "utf8",
    );
    assertReleaseScriptFails(
      "verify-changelog.ts",
      ["--changelog", changelogPath, "--version", "1.2.3"],
      /Missing Rin changelog content for 1\.2\.3/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verify-changelog script checks release-note commit coverage", () => {
  const tempDir = makeTempDir(".tmp-release-coverage-");
  try {
    runGit(tempDir, ["init"]);
    fs.mkdirSync(path.join(tempDir, "docs", "release"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "docs", "release", "CHANGELOG.md"),
      ["# Rin Changelog", "", "## 1.2.3", "", "- Ready", ""].join("\n"),
      "utf8",
    );
    const baseRef = commitAll(tempDir, "chore: base");

    fs.mkdirSync(path.join(tempDir, "src", "core", "chat"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempDir, "src", "core", "chat", "delivery.ts"),
      "export const ready = true;\n",
      "utf8",
    );
    const featureRef = commitAll(tempDir, "fix(chat): improve delivery");
    const featureShort = featureRef.slice(0, 7);

    assertReleaseScriptFails(
      "verify-changelog.ts",
      ["--version", "1.2.3", "--from-ref", baseRef, "--to-ref", featureRef],
      /Missing Rin changelog coverage for 1\.2\.3:[\s\S]*fix\(chat\): improve delivery/,
      { cwd: tempDir },
    );

    fs.writeFileSync(
      path.join(tempDir, "docs", "release", "CHANGELOG.md"),
      [
        "# Rin Changelog",
        "",
        "## 1.2.3",
        "",
        "- Chat delivery is more reliable.",
        "",
        "<!-- rin-changelog-coverage",
        `- ${featureShort} fix(chat): improve delivery`,
        "-->",
        "",
      ].join("\n"),
      "utf8",
    );
    runReleaseScript(
      "verify-changelog.ts",
      ["--version", "1.2.3", "--from-ref", baseRef, "--to-ref", featureRef],
      { cwd: tempDir },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("release workflows retry main branch metadata pushes", () => {
  for (const workflow of [
    "publish-nightly.yml",
    "publish-beta.yml",
    "publish-stable.yml",
    "publish-hotfix.yml",
  ] as const) {
    const content = readWorkflow(workflow);
    assert.ok(
      content.includes(
        "if ! git push origin HEAD:main; then\n" +
          "            git fetch origin main\n" +
          "            git rebase origin/main\n" +
          "            git push origin HEAD:main",
      ),
    );
  }

  for (const [workflow, tagRef] of [
    ["publish-nightly.yml", "steps.plan.outputs.version"],
    ["publish-beta.yml", "steps.plan.outputs.version"],
    ["publish-stable.yml", "steps.plan.outputs.version"],
    ["publish-hotfix.yml", "inputs.version"],
  ] as const) {
    const content = readWorkflow(workflow);
    const tagExpression = `\${{ ${tagRef} }}`;
    assert.match(
      content,
      new RegExp(
        `tag='v${tagExpression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`,
      ),
    );
    assert.match(content, /git tag -a "\$tag" -m "Rin \$tag"/);
    assert.match(content, /git push origin "refs\/tags\/\$tag"/);
    assert.match(content, /gh release upload "\$tag"/);
  }
});

test("release workflows are manual executors without GitHub schedules", () => {
  for (const workflow of [
    "publish-nightly.yml",
    "publish-beta.yml",
    "publish-stable.yml",
    "publish-hotfix.yml",
  ]) {
    const content = readWorkflow(workflow);
    assert.match(content, /on:\n {2}workflow_dispatch:/);
    assert.doesNotMatch(content, /\n {2}schedule:\n/);
  }
});

test("release workflows require changelog content coverage before expensive publish gates", () => {
  const beta = readWorkflow("publish-beta.yml");
  assert.match(beta, /scripts\/release\/verify-changelog\.ts/);
  assert.match(
    beta,
    /--version '\$\{\{ steps\.plan\.outputs\.promotion_version \}\}'/,
  );
  assert.match(beta, /--from-ref "\$from_ref"/);
  assert.match(
    beta,
    /--to-ref '\$\{\{ steps\.plan\.outputs\.release_ref \}\}'/,
  );
  assert.ok(
    beta.indexOf("Verify Rin changelog entry") <
      beta.indexOf("npm ci --no-fund --no-audit"),
  );

  const stable = readWorkflow("publish-stable.yml");
  assert.match(stable, /scripts\/release\/verify-changelog\.ts/);
  assert.match(stable, /--version '\$\{\{ steps\.plan\.outputs\.version \}\}'/);
  assert.match(stable, /--from-ref "\$from_ref"/);
  assert.match(stable, /--to-ref '\$\{\{ steps\.plan\.outputs\.beta_ref \}\}'/);
  assert.ok(
    stable.indexOf("Verify Rin changelog entry") <
      stable.indexOf("npm ci --no-fund --no-audit"),
  );

  const hotfix = readWorkflow("publish-hotfix.yml");
  assert.match(hotfix, /scripts\/release\/verify-changelog\.ts/);
  assert.match(hotfix, /--version '\$\{\{ inputs\.version \}\}'/);
  assert.match(hotfix, /--from-ref "\$from_ref"/);
  assert.match(hotfix, /--to-ref '\$\{\{ inputs\.ref \}\}'/);
  assert.ok(
    hotfix.indexOf("Verify Rin changelog entry") <
      hotfix.indexOf("npm ci --no-fund --no-audit"),
  );
  assert.doesNotMatch(
    readWorkflow("publish-nightly.yml"),
    /verify-changelog|release:changelog/,
  );
});

test("candidate-only release workflows run main-tree release scripts without local deps", () => {
  for (const workflow of ["publish-stable.yml", "publish-hotfix.yml"]) {
    const content = readWorkflow(workflow);
    assert.match(
      content,
      /npx --yes tsx scripts\/release\/update-release-manifest\.ts/,
    );
    assert.match(
      content,
      /npx --yes tsx scripts\/release\/export-bootstrap-branch\.ts/,
    );
    assert.doesNotMatch(content, /npm run release:(?:manifest|bootstrap)/);
  }
});

test("release workflows publish linux platform bundle metadata for every channel", () => {
  for (const workflow of [
    "publish-nightly.yml",
    "publish-beta.yml",
    "publish-stable.yml",
    "publish-hotfix.yml",
  ]) {
    const content = readWorkflow(workflow);
    assert.match(content, /Build .* linux-x64 platform bundle/);
    assert.match(content, /npm run --silent release:bundle/);
    assert.match(content, /--asset-platform linux-x64/);
    assert.match(
      content,
      /--asset-url 'https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/releases\/download\/v/,
    );
    assert.match(content, /--asset-sha256/);
    assert.match(content, /--asset-node-version/);
    assert.match(content, /gh release upload "\$tag"/);
  }
});

test("release workflows publish the public bootstrap branch", () => {
  for (const workflow of [
    "publish-nightly.yml",
    "publish-beta.yml",
    "publish-stable.yml",
    "publish-hotfix.yml",
  ]) {
    const content = readWorkflow(workflow);
    assert.match(content, /bootstrap_branch=bootstrap/);
    if (
      workflow === "publish-stable.yml" ||
      workflow === "publish-hotfix.yml"
    ) {
      assert.match(
        content,
        /npx --yes tsx scripts\/release\/export-bootstrap-branch\.ts --output "\$bootstrap_dir" --branch "\$bootstrap_branch"/,
      );
    } else {
      assert.match(
        content,
        /npm run release:bootstrap -- --output "\$bootstrap_dir" --branch "\$bootstrap_branch"/,
      );
    }
    assert.match(
      content,
      /git -C "\$bootstrap_dir" push origin "HEAD:\$bootstrap_branch"/,
    );
    assert.match(
      content,
      /git -C "\$bootstrap_dir" fetch origin "\$bootstrap_branch"/,
    );
    assert.match(
      content,
      /git -C "\$bootstrap_dir" rebase "origin\/\$bootstrap_branch"/,
    );
    assert.doesNotMatch(content, /stable-bootstrap/);
  }
});

test(
  "build-platform-bundle script creates app and managed node layout",
  { skip: process.platform === "win32" ? "POSIX fake node fixture" : false },
  () => {
    const tempDir = makeTempDir(".tmp-release-script-");
    try {
      const fakeRepo = path.join(tempDir, "repo");
      const outputDir = path.join(tempDir, "out");
      const nodeRuntime = path.join(tempDir, "node-runtime");
      const hostileBin = path.join(tempDir, "hostile-bin");
      const invocationLog = path.join(tempDir, "managed-node.log");
      fs.mkdirSync(path.join(fakeRepo, "dist", "app", "rin-install"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(fakeRepo, "dist", "app", "rin"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(fakeRepo, "node_modules", "better-sqlite3"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(fakeRepo, "node_modules", "better-sqlite3", "package.json"),
        JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }),
      );
      fs.writeFileSync(
        path.join(fakeRepo, "package.json"),
        JSON.stringify({
          name: "@hoshinorin/rin",
          version: "1.2.3",
          dependencies: { "better-sqlite3": "12.11.1" },
        }),
      );
      fs.writeFileSync(
        path.join(fakeRepo, "dist", "app", "rin-install", "main.js"),
        "console.log('install')\n",
      );
      fs.writeFileSync(
        path.join(fakeRepo, "dist", "app", "rin", "main.js"),
        "console.log('rin')\n",
      );
      fs.mkdirSync(path.join(nodeRuntime, "bin"), { recursive: true });
      const nodePath = path.join(nodeRuntime, "bin", "node");
      fs.writeFileSync(
        nodePath,
        `#!/bin/sh
echo "$*" >>"$RIN_RELEASE_TEST_LOG"
if [ "$1" = "--version" ]; then echo v24.18.0; exit 0; fi
case "$1" in
  *npm-cli.js)
    if [ "\${PATH%%:*}" != "$(dirname "$0")" ]; then exit 91; fi
    echo 10.9.3
    exit 0
    ;;
  -e)
    test -f node_modules/better-sqlite3/package.json || exit 92
    exit 0
    ;;
esac
exit 0
`,
      );
      fs.chmodSync(nodePath, 0o755);
      const npmCliPath = path.join(
        nodeRuntime,
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      fs.mkdirSync(path.dirname(npmCliPath), { recursive: true });
      fs.writeFileSync(npmCliPath, "export {};\n");
      fs.mkdirSync(hostileBin, { recursive: true });
      const hostileNode = path.join(hostileBin, "node");
      fs.writeFileSync(hostileNode, "#!/bin/sh\nexit 93\n", { mode: 0o755 });

      const output = runReleaseScript(
        "build-platform-bundle.ts",
        [
          "--repo-root",
          fakeRepo,
          "--output",
          outputDir,
          "--platform",
          "linux-x64",
          "--version",
          "1.2.4-beta.20260420",
          "--node-runtime",
          nodeRuntime,
          "--node-version",
          "24.18.0",
        ],
        {
          env: {
            ...process.env,
            PATH: `${hostileBin}${path.delimiter}${process.env.PATH}`,
            RIN_RELEASE_TEST_LOG: invocationLog,
          },
        },
      );
      const result = JSON.parse(output);
      assert.equal(result.platform, "linux-x64");
      assert.equal(result.nodeVersion, "24.18.0");
      assert.match(result.sha256, /^[a-f0-9]{64}$/);
      assert.equal(
        path.basename(result.bundlePath),
        "rin-1.2.4-beta.20260420-linux-x64.tar.gz",
      );
      const managedInvocations = fs.readFileSync(invocationLog, "utf8");
      assert.match(managedInvocations, /npm-cli\.js prune/);
      assert.match(managedInvocations, /npm-cli\.js --version/);
      assert.match(managedInvocations, /better-sqlite3/);
      const extractDir = path.join(tempDir, "extract");
      fs.mkdirSync(extractDir, { recursive: true });
      execFileSync("tar", ["-xzf", result.bundlePath, "-C", extractDir]);
      const bundleRoot = path.join(
        extractDir,
        "rin-1.2.4-beta.20260420-linux-x64",
      );
      assert.equal(
        JSON.parse(
          fs.readFileSync(path.join(bundleRoot, "package.json"), "utf8"),
        ).version,
        "1.2.4-beta.20260420",
      );
      assert.deepEqual(fs.readdirSync(path.join(bundleRoot, "extensions")), []);
      for (const relativePath of [
        path.join("dist", "app", "rin-install", "main.js"),
        path.join("dist", "app", "rin", "main.js"),
        "extensions",
        "node_modules",
        "package.json",
        path.join("runtime", "node", "current", "bin", "node"),
        path.join(
          "runtime",
          "node",
          "current",
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      ]) {
        assert.equal(
          fs.existsSync(path.join(bundleRoot, relativePath)),
          true,
          relativePath,
        );
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test("export-bootstrap-branch script exports bootstrap payload", () => {
  const tempDir = makeTempDir(".tmp-bootstrap-export-");
  try {
    fs.writeFileSync(path.join(tempDir, "stale.txt"), "stale", "utf8");
    execFileSync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "export-bootstrap-branch.ts"),
        "--output",
        tempDir,
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    for (const relativePath of [
      "install.sh",
      "update.sh",
      "install.ps1",
      "update.ps1",
      path.join("scripts", "bootstrap-entrypoint.sh"),
      path.join("scripts", "bootstrap-entrypoint.ps1"),
      "release-manifest.json",
      path.join("docs", "release", "CHANGELOG.md"),
      "README.md",
    ]) {
      assert.equal(
        fs.existsSync(path.join(tempDir, relativePath)),
        true,
        relativePath,
      );
    }
    const readme = fs.readFileSync(path.join(tempDir, "README.md"), "utf8");
    const installWrapper = fs.readFileSync(
      path.join(tempDir, "install.sh"),
      "utf8",
    );
    const installPowerShellWrapper = fs.readFileSync(
      path.join(tempDir, "install.ps1"),
      "utf8",
    );
    const bootstrapPowerShell = fs.readFileSync(
      path.join(tempDir, "scripts", "bootstrap-entrypoint.ps1"),
      "utf8",
    );
    assert.match(readme, /bootstrap branch/);
    assert.match(installWrapper, /^DEFAULT_BOOTSTRAP_BRANCH=bootstrap$/m);
    assert.match(
      installPowerShellWrapper,
      /^\$defaultBootstrapBranch = "bootstrap"$/m,
    );
    assert.doesNotMatch(
      installPowerShellWrapper,
      /\[CmdletBinding\(PositionalBinding = \$false\)\]/,
    );
    assert.match(installPowerShellWrapper, /return \$result/);
    assert.doesNotMatch(installPowerShellWrapper, /return ,\$result/);
    assert.match(
      installPowerShellWrapper,
      /\$bootstrapArgs = @\(Build-BootstrapArgs \$args\)/,
    );
    assert.doesNotMatch(bootstrapPowerShell, /\[switch\]\$Git/);
    assert.match(bootstrapPowerShell, /function Is-Flag/);
    assert.match(bootstrapPowerShell, /Is-Flag \$arg "git"/);
    assert.match(bootstrapPowerShell, /Is-Flag \$arg "mode"/);
    assert.match(bootstrapPowerShell, /AppData\/Roaming\/rin\/install\.json/);
    assert.match(bootstrapPowerShell, /^param\(/);
    assert.match(bootstrapPowerShell, /\[Alias\("Mode"\)\]/);
    assert.match(bootstrapPowerShell, /\$RequestedMode -ieq "--mode"/);
    assert.match(
      bootstrapPowerShell,
      /\$arg -ieq "install" -or \$arg -ieq "update"/,
    );
    assert.match(bootstrapPowerShell, /Parse-Args \$parseArgs/);
    assert.match(
      bootstrapPowerShell,
      /\$nodeVersionOutput = & node -p "process\.versions\.node"/,
    );
    assert.match(bootstrapPowerShell, /\$nodeExitCode = \$LASTEXITCODE/);
    assert.match(bootstrapPowerShell, /Receive-Job -Job \$job -Wait \*>&1/);
    assert.match(bootstrapPowerShell, /if \(\$job\.State -eq "Failed"\)/);
    assert.doesNotMatch(
      bootstrapPowerShell,
      /Receive-Job -Job \$job -Wait -ErrorAction Stop/,
    );
    assert.doesNotMatch(
      bootstrapPowerShell,
      /Remove-Item -LiteralPath "node_modules"/,
    );
    assert.doesNotMatch(
      bootstrapPowerShell,
      /Remove-Item -LiteralPath "package-lock\.json"/,
    );
    assert.doesNotMatch(
      bootstrapPowerShell,
      /& node -p "process\.versions\.node" 2>\$null \| Select-Object -First 1/,
    );
    assert.equal(fs.existsSync(path.join(tempDir, "stale.txt")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
