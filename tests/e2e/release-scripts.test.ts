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

test("update-release-manifest script writes stable npm tarball metadata", () => {
  const tempDir = makeTempDir(".tmp-release-script-");
  try {
    const manifestPath = path.join(tempDir, "release-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        packageName: "@rinchanai20260422/rin",
        repoUrl: "https://github.com/rinchanai/rin",
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
        path.join(rootDir, "scripts", "release", "update-release-manifest.mjs"),
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
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    const next = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(next.packageName, "@rinchanai20260422/rin");
    assert.equal(next.stable.version, "1.2.3");
    assert.equal(next.stable.ref, "deadbeef");
    assert.equal(next.stable.promotedFromBetaVersion, "1.2.3-beta.20260420");
    assert.equal(
      next.stable.archiveUrl,
      "https://registry.npmjs.org/%40rinchanai20260422%2Frin/-/rin-1.2.3.tgz",
    );
    assert.equal(
      next.stable.versions["1.2.3"].archiveUrl,
      "https://registry.npmjs.org/%40rinchanai20260422%2Frin/-/rin-1.2.3.tgz",
    );
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
        packageName: "@rinchanai20260422/rin",
        repoUrl: "https://github.com/rinchanai/rin",
        train: { series: "1.2", nightlyBranch: "main" },
        stable: {
          version: "1.2.3",
          archiveUrl:
            "https://registry.npmjs.org/%40rinchanai20260422%2Frin/-/rin-1.2.3.tgz",
        },
        beta: {},
        nightly: {},
        git: { defaultBranch: "main" },
      }),
    );
    execFileSync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "update-release-manifest.mjs"),
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
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    execFileSync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "update-release-manifest.mjs"),
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
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    const next = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(next.beta.version, "1.2.4-beta.20260420");
    assert.equal(next.beta.ref, "deadbeef");
    assert.equal(next.beta.promotionVersion, "1.2.4");
    assert.equal(
      next.beta.archiveUrl,
      "https://github.com/rinchanai/rin/archive/deadbeef.tar.gz",
    );
    assert.equal(next.nightly.version, "1.2.5-nightly.20260420+deadbee");
    assert.equal(next.nightly.ref, "deadbeef");
    assert.equal(next.nightly.branch, "main");
    assert.equal(
      next.nightly.archiveUrl,
      "https://github.com/rinchanai/rin/archive/deadbeef.tar.gz",
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
          path.join(rootDir, "scripts", "release", "plan-release.mjs"),
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
          path.join(rootDir, "scripts", "release", "plan-release.mjs"),
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
          path.join(rootDir, "scripts", "release", "plan-release.mjs"),
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
          path.join(rootDir, "scripts", "release", "plan-release.mjs"),
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
          path.join(rootDir, "scripts", "release", "plan-release.mjs"),
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

test("verify-changelog script requires a target Rin changelog heading", () => {
  const tempDir = makeTempDir(".tmp-release-changelog-");
  try {
    const changelogPath = path.join(tempDir, "CHANGELOG.md");
    fs.writeFileSync(
      changelogPath,
      ["# Rin Changelog", "", "## 1.2.3", "", "- Ready", ""].join("\n"),
      "utf8",
    );
    execFileSync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "verify-changelog.mjs"),
        "--changelog",
        changelogPath,
        "--version",
        "1.2.3",
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          path.join(rootDir, "scripts", "release", "verify-changelog.mjs"),
          "--changelog",
          changelogPath,
          "--version",
          "1.2.4",
        ],
        { cwd: rootDir, stdio: "pipe" },
      ),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("release workflows retry main branch metadata pushes", () => {
  for (const [workflow, followTags] of [
    ["publish-nightly.yml", false],
    ["publish-beta.yml", false],
    ["publish-stable.yml", true],
    ["publish-hotfix.yml", true],
  ] as const) {
    const content = readWorkflow(workflow);
    const tagSuffix = followTags ? " --follow-tags" : "";
    assert.match(
      content,
      new RegExp(
        `if ! git push origin HEAD:main${tagSuffix}; then\\n` +
          `            git fetch origin main\\n` +
          `            git rebase origin/main\\n` +
          `            git push origin HEAD:main${tagSuffix}`,
      ),
    );
  }
});

test("release workflows require changelog entries for user-facing releases", () => {
  const beta = readWorkflow("publish-beta.yml");
  assert.match(
    beta,
    /npm run release:changelog -- --version '\$\{\{ steps\.plan\.outputs\.promotion_version \}\}'/,
  );
  const stable = readWorkflow("publish-stable.yml");
  assert.match(
    stable,
    /npm run release:changelog -- --version '\$\{\{ steps\.plan\.outputs\.version \}\}'/,
  );
  const hotfix = readWorkflow("publish-hotfix.yml");
  assert.match(
    hotfix,
    /npm run release:changelog -- --version '\$\{\{ inputs\.version \}\}'/,
  );
  assert.doesNotMatch(readWorkflow("publish-nightly.yml"), /release:changelog/);
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
    assert.match(
      content,
      /npm run release:bootstrap -- --output "\$bootstrap_dir" --branch "\$bootstrap_branch"/,
    );
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

test("export-bootstrap-branch script exports bootstrap payload", () => {
  const tempDir = makeTempDir(".tmp-bootstrap-export-");
  try {
    fs.writeFileSync(path.join(tempDir, "stale.txt"), "stale", "utf8");
    execFileSync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "export-bootstrap-branch.mjs"),
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
    assert.match(installPowerShellWrapper, /return ,\$result/);
    assert.match(
      installPowerShellWrapper,
      /\$bootstrapArgs = @\(Build-BootstrapArgs \$args\)/,
    );
    assert.doesNotMatch(bootstrapPowerShell, /\[switch\]\$Git/);
    assert.match(bootstrapPowerShell, /function Is-Flag/);
    assert.match(bootstrapPowerShell, /Is-Flag \$arg "git"/);
    assert.match(bootstrapPowerShell, /Is-Flag \$arg "mode"/);
    assert.match(bootstrapPowerShell, /Parse-Args @\(\$args/);
    assert.equal(fs.existsSync(path.join(tempDir, "stale.txt")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
