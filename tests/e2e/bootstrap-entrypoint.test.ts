import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-bootstrap-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
}

async function createSourceArchive(tempDir) {
  const sourceRoot = path.join(tempDir, "rin-main");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(
    path.join(sourceRoot, "package.json"),
    JSON.stringify(
      {
        scripts: { prepare: "node ./scripts/prepare.js" },
        dependencies: { chalk: "^5.6.2" },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await fs.mkdir(path.join(sourceRoot, "dist", "app", "rin-install"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(sourceRoot, "dist", "app", "rin-install", "main.js"),
    "export {};\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(sourceRoot, "package-lock.json"),
    "{\n}\n",
    "utf8",
  );

  const archivePath = path.join(tempDir, "rin-main.tar.gz");
  await execFileAsync("tar", ["-czf", archivePath, "-C", tempDir, "rin-main"]);
  return archivePath;
}

async function createReleaseManifest(tempDir) {
  const manifestPath = path.join(tempDir, "release-manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      repoUrl: "https://example.invalid/rin",
      bootstrapBranch: "bootstrap",
      train: {
        series: "1.2",
        nightlyBranch: "main",
      },
      stable: {
        version: "1.2.3",
        archiveUrl:
          "https://registry.npmjs.org/%40hoshinorin%2Frin/-/rin-1.2.3.tgz",
        ref: "abc1234",
      },
      beta: {
        version: "1.2.4-beta.20260420",
        archiveUrl:
          "https://example.invalid/releases/beta-1.2.4-beta.20260420.tar.gz",
        ref: "def5678",
        promotionVersion: "1.2.4",
      },
      nightly: {
        version: "1.2.5-nightly.20260420+deadbee",
        archiveUrl:
          "https://example.invalid/releases/nightly-1.2.5-nightly.20260420.tar.gz",
        ref: "deadbeef",
        branch: "main",
      },
      git: {
        defaultBranch: "main",
        repoUrl: "https://example.invalid/rin",
      },
    }),
    "utf8",
  );
  return manifestPath;
}

async function createFakeBin(fakeBin, logPath) {
  await fs.mkdir(fakeBin, { recursive: true });

  await writeExecutable(
    path.join(fakeBin, "curl"),
    `#!/bin/sh
echo "curl:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
OUT=
URL=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT=$2; shift 2 ;;
    *) URL=$1; shift ;;
  esac
done
case "$URL" in
  *scripts/bootstrap-entrypoint.sh)
    cp "$RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT" "$OUT"
    ;;
  *release-manifest.json)
    cp "$RIN_BOOTSTRAP_TEST_MANIFEST" "$OUT"
    ;;
  *)
    cp "$RIN_BOOTSTRAP_TEST_ARCHIVE" "$OUT"
    ;;
esac
`,
  );
  await writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/bin/sh
echo "npm:$PWD:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p dist/app/rin-install
  printf 'export {};\n' > dist/app/rin-install/main.js
  exit 0
fi
exit 0
`,
  );
  await writeExecutable(
    path.join(fakeBin, "node"),
    `#!${process.execPath}
import fs from "node:fs";

const logPath = process.env.RIN_BOOTSTRAP_TEST_LOG;
const args = process.argv.slice(2);
const fields = [
  "node:" + process.cwd(),
  "stdin_tty=" + (process.stdin.isTTY ? 1 : 0),
  "stdout_tty=" + (process.stdout.isTTY ? 1 : 0),
  args.join(" "),
];
fs.appendFileSync(logPath, fields.join(":") + "\\n", "utf8");

if (args[0] === "-" && String(args[1] || "").endsWith("install.json")) {
  const record = JSON.parse(fs.readFileSync(args[1], "utf8"));
  process.stdout.write(String(record.defaultInstallDir || record.installDir || ""));
} else if (args[0] === "-" && String(args[1] || "").endsWith("installer.json")) {
  const release = JSON.parse(fs.readFileSync(args[1], "utf8")).currentRelease.release;
  process.stdout.write(String(release.channel || "") + "\\n" + String(release.branch || "") + "\\n");
} else if (args[0] === "-") {
  const fixtures = {
    beta: [
      "CHANNEL='beta'",
      "ARCHIVE_URL='https://example.invalid/releases/beta-1.2.4-beta.20260420.tar.gz'",
      "VERSION='1.2.4-beta.20260420'",
      "BRANCH='beta'",
      "REF='def5678'",
      "SOURCE_LABEL='beta 1.2.4-beta.20260420'",
    ],
    nightly: [
      "CHANNEL='nightly'",
      "ARCHIVE_URL='https://example.invalid/releases/nightly-1.2.5-nightly.20260420.tar.gz'",
      "VERSION='1.2.5-nightly.20260420+deadbee'",
      "BRANCH='main'",
      "REF='deadbeef'",
      "SOURCE_LABEL='nightly 1.2.5-nightly.20260420+deadbee'",
    ],
    git: [
      "CHANNEL='git'",
      "ARCHIVE_URL='https://example.invalid/rin/archive/0123456789abcdef0123456789abcdef01234567.tar.gz'",
      "VERSION='0123456789ab'",
      "BRANCH='main'",
      "REF='0123456789abcdef0123456789abcdef01234567'",
      "SOURCE_LABEL='git main @ 0123456789ab'",
    ],
    stable: [
      "CHANNEL='stable'",
      "ARCHIVE_URL='https://registry.npmjs.org/%40hoshinorin%2Frin/-/rin-1.2.3.tgz'",
      "VERSION='1.2.3'",
      "BRANCH='stable'",
      "REF='abc1234'",
      "SOURCE_LABEL='stable 1.2.3'",
    ],
  };
  const key = args[4] || args[2] || "stable";
  process.stdout.write((fixtures[key] || fixtures.stable).join("\\n") + "\\n");
}
`,
  );
  await fs.writeFile(logPath, "", "utf8");
}

async function runBootstrapWrapper(scriptName, args, env) {
  await execFileAsync("sh", [path.join(rootDir, scriptName), ...args], {
    cwd: rootDir,
    env,
  });
}

async function assertBootstrapFails(args, pattern, envOverrides = {}) {
  await withTempDir(async (tempDir) => {
    await assert.rejects(
      execFileAsync(
        "sh",
        [path.join(rootDir, "scripts", "bootstrap-entrypoint.sh"), ...args],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            ...envOverrides,
            TMPDIR: tempDir,
          },
        },
      ),
      pattern,
    );
  });
}

test("bootstrap entrypoint rejects missing legacy selector values", async () => {
  await assertBootstrapFails(["install", "--branch", "--version"], {
    stderr: /missing value for --branch/,
  });
  await assertBootstrapFails(["install", "--version", "--beta"], {
    stderr: /missing value for --version/,
  });

  const powerShell = await fs.readFile(
    path.join(rootDir, "scripts", "bootstrap-entrypoint.ps1"),
    "utf8",
  );
  assert.match(
    powerShell,
    /\$Value\.StartsWith\("-"\).*missing value for \$DisplayName/,
  );
});

test("bootstrap entrypoint rejects Node.js versions below the supported minimum", async () => {
  await withTempDir(async (tempDir) => {
    const fakeBin = path.join(tempDir, "bin");
    await fs.mkdir(fakeBin, { recursive: true });
    await writeExecutable(
      path.join(fakeBin, "node"),
      `#!/bin/sh
if [ "$1" = "-e" ]; then exit 1; fi
exit 0
`,
    );
    await writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/bin/sh
exit 0
`,
    );

    await assertBootstrapFails(
      ["install"],
      { stderr: /rin installer requires Node\.js >= 22\.19\.0/ },
      { PATH: `${fakeBin}:${process.env.PATH}` },
    );
  });

  const powerShell = await fs.readFile(
    path.join(rootDir, "scripts", "bootstrap-entrypoint.ps1"),
    "utf8",
  );
  assert.match(powerShell, /requires Node\.js >= 22\.19\.0/);
});

test("bootstrap entrypoint reports unresolved git selectors without continuing", async () => {
  await withTempDir(async (tempDir) => {
    const manifestPath = await createReleaseManifest(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.mkdir(workRoot, { recursive: true });
    await fs.writeFile(logPath, "", "utf8");
    await writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/bin/sh
echo "curl:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
OUT=
URL=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT=$2; shift 2 ;;
    -*) shift ;;
    *) URL=$1; shift ;;
  esac
done
case "$URL" in
  *release-manifest.json)
    cp "$RIN_BOOTSTRAP_TEST_MANIFEST" "$OUT"
    ;;
  *)
    exit 22
    ;;
esac
`,
    );
    await writeExecutable(
      path.join(fakeBin, "git"),
      `#!/bin/sh
echo "git:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
if [ "$1" = "ls-remote" ]; then exit 0; fi
exit 1
`,
    );

    await assert.rejects(
      execFileAsync(
        "sh",
        [
          path.join(rootDir, "scripts", "bootstrap-entrypoint.sh"),
          "install",
          "--git",
          "mains",
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH}`,
            RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
            TMPDIR: workRoot,
            RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
            RIN_BOOTSTRAP_TEST_LOG: logPath,
          },
        },
      ),
      (error) => {
        const stderr = String(error.stderr || "");
        assert.match(stderr, /failed to resolve git ref: mains/);
        assert.doesNotMatch(
          stderr,
          /\[stdin\]|Node\.js v|REF:|unbound variable/,
        );
        return true;
      },
    );

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/rin\/bootstrap\/release-manifest\.json -o /,
    );
    assert.match(
      log,
      /git:ls-remote https:\/\/example\.invalid\/rin refs\/heads\/mains/,
    );
    assert.match(log, /git:ls-remote https:\/\/example\.invalid\/rin mains/);
    assert.deepEqual(await fs.readdir(workRoot), []);
  });
});

test("bootstrap scripts render progress without rin-install log prefixes", async () => {
  for (const scriptName of [
    "install.sh",
    "scripts/bootstrap-entrypoint.sh",
    "scripts/bootstrap-entrypoint.ps1",
  ]) {
    const content = await fs.readFile(path.join(rootDir, scriptName), "utf8");
    assert.doesNotMatch(content, /\[rin-(?:install|update)\]/);
  }
  for (const scriptName of [
    "install.ps1",
    "update.ps1",
    "scripts/bootstrap-entrypoint.ps1",
  ]) {
    const bytes = await fs.readFile(path.join(rootDir, scriptName));
    assert.equal(
      bytes.every((byte) => byte < 0x80),
      true,
      `${scriptName} must stay ASCII-only so Windows PowerShell 5.1 can run the downloaded UTF-8-without-BOM file`,
    );
  }
  assert.match(
    await fs.readFile(
      path.join(rootDir, "scripts", "bootstrap-entrypoint.sh"),
      "utf8",
    ),
    /render_spinner/,
  );
  assert.match(
    await fs.readFile(
      path.join(rootDir, "scripts", "bootstrap-entrypoint.ps1"),
      "utf8",
    ),
    /Invoke-WithSpinner/,
  );
});

test("PowerShell install wrapper passes mode as parser args", async () => {
  const powerShell = await fs.readFile(
    path.join(rootDir, "install.ps1"),
    "utf8",
  );
  assert.match(powerShell, /^\$defaultBootstrapBranch = "main"$/m);
  assert.match(
    powerShell,
    /& \$localBootstrapScript "--mode" \$mode @bootstrapArgs/,
  );
  assert.match(
    powerShell,
    /& \$bootstrapScript "--mode" \$mode @bootstrapArgs/,
  );
  assert.match(powerShell, /return \$result/);
  assert.doesNotMatch(powerShell, /return ,\$result/);
  assert.doesNotMatch(
    powerShell,
    /& \$(?:localBootstrapScript|bootstrapScript) -Mode \$mode/,
  );

  const entrypoint = await fs.readFile(
    path.join(rootDir, "scripts", "bootstrap-entrypoint.ps1"),
    "utf8",
  );
  assert.match(entrypoint, /^param\(/);
  assert.match(entrypoint, /\[Alias\("Mode"\)\]/);
  assert.match(entrypoint, /channel = \[string\]\$Release\.Channel/);
  assert.match(entrypoint, /archiveUrl = \[string\]\$Release\.ArchiveUrl/);
  assert.match(entrypoint, /version = \[string\]\$Release\.Version/);
  assert.match(entrypoint, /Resolve-Git-Commit/);
  assert.match(entrypoint, /git ls-remote \$RepoUrl/);
  assert.match(entrypoint, /rin_git_ref_not_resolved/);
  assert.doesNotMatch(
    entrypoint,
    /\$Release \| ConvertTo-Json -Compress \| Set-Content -LiteralPath \$script:releaseFile/,
  );
  assert.match(entrypoint, /\$mode = "install"/);
  assert.match(entrypoint, /\$RequestedMode -ieq "--mode"/);
  assert.match(entrypoint, /\$arg -ieq "install" -or \$arg -ieq "update"/);
  assert.match(entrypoint, /Parse-Args \$parseArgs/);
  assert.match(
    entrypoint,
    /\$nodeVersionOutput = & node -p "process\.versions\.node"/,
  );
  assert.match(entrypoint, /\$nodeExitCode = \$LASTEXITCODE/);
  assert.match(entrypoint, /if \(\$nodeExitCode -ne 0 -or -not \$rawVersion\)/);
  assert.match(
    entrypoint,
    /Receive-Job -Job \$job -Wait -ErrorAction SilentlyContinue/,
  );
  assert.match(entrypoint, /if \(\$job\.State -eq "Failed"\)/);
  assert.doesNotMatch(
    entrypoint,
    /Receive-Job -Job \$job -Wait -ErrorAction Stop/,
  );
  assert.doesNotMatch(entrypoint, /Remove-Item -LiteralPath "node_modules"/);
  assert.doesNotMatch(
    entrypoint,
    /Remove-Item -LiteralPath "package-lock\.json"/,
  );
  assert.doesNotMatch(
    entrypoint,
    /& node -p "process\.versions\.node" 2>\$null \| Select-Object -First 1/,
  );

  const shell = await fs.readFile(
    path.join(rootDir, "scripts", "bootstrap-entrypoint.sh"),
    "utf8",
  );
  assert.match(shell, /resolveGitCommit/);
  assert.match(shell, /git', \['ls-remote'/);
  assert.match(shell, /rin_git_ref_not_resolved/);
});

test("stable install and update wrappers resolve release metadata then npm-install package runtime dependencies", async () => {
  await withTempDir(async (tempDir) => {
    const archivePath = await createSourceArchive(tempDir);
    const manifestPath = await createReleaseManifest(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    await createFakeBin(fakeBin, logPath);
    await fs.mkdir(workRoot, { recursive: true });
    const installDir = path.join(tempDir, "install");
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "installer.json"),
      JSON.stringify({ currentRelease: { release: { channel: "stable" } } }),
      "utf8",
    );

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
      RIN_DIR: installDir,
      TMPDIR: workRoot,
      RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
      RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
      RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT: path.join(
        rootDir,
        "scripts",
        "bootstrap-entrypoint.sh",
      ),
      RIN_BOOTSTRAP_TEST_LOG: logPath,
    };

    await runBootstrapWrapper("install.sh", [], env);
    await runBootstrapWrapper("update.sh", [], env);

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/rin\/bootstrap\/release-manifest\.json -o /,
    );
    assert.match(log, /curl:-fsSL https:\/\/registry\.npmjs\.org\//);
    assert.equal(/npm:.*:ci --no-fund --no-audit/.test(log), false);
    assert.equal(/npm:.*:run build/.test(log), false);
    assert.equal(/npm:.*:exec --yes --package/.test(log), false);
    assert.match(log, /npm:.*:install --omit=dev --no-fund --no-audit\n/);

    assert.deepEqual(await fs.readdir(workRoot), []);
  });
});

test("update wrapper inherits release channel from launcher metadata install dir", async () => {
  await withTempDir(async (tempDir) => {
    const archivePath = await createSourceArchive(tempDir);
    const manifestPath = await createReleaseManifest(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    const currentHome = path.join(tempDir, "operator-home");
    const installDir = path.join(tempDir, "target-install");
    await createFakeBin(fakeBin, logPath);
    await fs.mkdir(workRoot, { recursive: true });
    await fs.mkdir(path.join(currentHome, ".config", "rin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(currentHome, ".config", "rin", "install.json"),
      JSON.stringify({
        defaultTargetUser: "rin",
        defaultInstallDir: installDir,
      }),
      "utf8",
    );
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "installer.json"),
      JSON.stringify({
        currentRelease: {
          release: { channel: "git", branch: "main" },
        },
      }),
      "utf8",
    );

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: currentHome,
      RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
      TMPDIR: workRoot,
      RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
      RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
      RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT: path.join(
        rootDir,
        "scripts",
        "bootstrap-entrypoint.sh",
      ),
      RIN_BOOTSTRAP_TEST_LOG: logPath,
    };
    delete env.RIN_DIR;

    await runBootstrapWrapper("update.sh", [], env);

    const log = await fs.readFile(logPath, "utf8");
    assert.match(log, /node:.*\.config\/rin\/install\.json/);
    assert.match(log, /node:.*target-install\/installer\.json/);
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/rin\/archive\/0123456789abcdef0123456789abcdef01234567\.tar\.gz -o /,
    );
    assert.match(log, /npm:.*:ci --no-fund --no-audit/);
  });
});

test("wrapper-only main install script fetches the shared entrypoint from main", async () => {
  await withTempDir(async (tempDir) => {
    const archivePath = await createSourceArchive(tempDir);
    const manifestPath = await createReleaseManifest(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    const wrapperDir = path.join(tempDir, "main-wrapper");
    await createFakeBin(fakeBin, logPath);
    await fs.mkdir(workRoot, { recursive: true });
    await fs.mkdir(wrapperDir, { recursive: true });
    await fs.copyFile(
      path.join(rootDir, "install.sh"),
      path.join(wrapperDir, "install.sh"),
    );

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
      TMPDIR: workRoot,
      RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
      RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
      RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT: path.join(
        rootDir,
        "scripts",
        "bootstrap-entrypoint.sh",
      ),
      RIN_BOOTSTRAP_TEST_LOG: logPath,
    };

    await execFileAsync(
      "sh",
      [path.join(wrapperDir, "install.sh"), "--git", "--quick-run"],
      {
        cwd: wrapperDir,
        env,
      },
    );

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/rin\/main\/scripts\/bootstrap-entrypoint\.sh -o /,
    );
    assert.equal(
      /curl:-fsSL https:\/\/example\.invalid\/rin\/bootstrap\/scripts\/bootstrap-entrypoint\.sh -o /.test(
        log,
      ),
      false,
    );
    assert.match(
      log,
      /dist\/app\/rin-install\/main\.js --release-file [^\s]+ --quick-run/,
    );
  });
});

test("wrapper-only bootstrap exports fetch the entrypoint from bootstrap first", async () => {
  await withTempDir(async (tempDir) => {
    const archivePath = await createSourceArchive(tempDir);
    const manifestPath = await createReleaseManifest(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    const bootstrapDir = path.join(tempDir, "bootstrap");
    await createFakeBin(fakeBin, logPath);
    await fs.mkdir(workRoot, { recursive: true });

    await execFileAsync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "export-bootstrap-branch.ts"),
        "--output",
        bootstrapDir,
      ],
      { cwd: rootDir },
    );
    assert.equal(
      await fs
        .stat(path.join(bootstrapDir, "scripts", "bootstrap-entrypoint.sh"))
        .then(() => true),
      true,
    );
    await fs.rm(path.join(bootstrapDir, "scripts"), {
      recursive: true,
      force: true,
    });
    const installDir = path.join(tempDir, "install");
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "installer.json"),
      JSON.stringify({ currentRelease: { release: { channel: "stable" } } }),
      "utf8",
    );

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
      RIN_DIR: installDir,
      TMPDIR: workRoot,
      RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
      RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
      RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT: path.join(
        rootDir,
        "scripts",
        "bootstrap-entrypoint.sh",
      ),
      RIN_BOOTSTRAP_TEST_LOG: logPath,
    };

    await execFileAsync("sh", [path.join(bootstrapDir, "install.sh")], {
      cwd: bootstrapDir,
      env,
    });
    await execFileAsync("sh", [path.join(bootstrapDir, "update.sh")], {
      cwd: bootstrapDir,
      env,
    });

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/rin\/bootstrap\/scripts\/bootstrap-entrypoint\.sh -o /,
    );
    assert.equal(
      /curl:-fsSL https:\/\/example\.invalid\/rin\/main\/scripts\/bootstrap-entrypoint\.sh -o /.test(
        log,
      ),
      false,
    );
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/rin\/bootstrap\/release-manifest\.json -o /,
    );
    assert.equal(/npm:.*:exec --yes --package/.test(log), false);
    assert.match(log, /npm:.*:install --omit=dev --no-fund --no-audit\n/);
    assert.deepEqual(await fs.readdir(workRoot), []);
  });
});

test("install wrapper forwards quick-run while preserving release channel selection", async () => {
  await withTempDir(async (tempDir) => {
    const archivePath = await createSourceArchive(tempDir);
    const manifestPath = await createReleaseManifest(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    await createFakeBin(fakeBin, logPath);
    await fs.mkdir(workRoot, { recursive: true });

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
      TMPDIR: workRoot,
      RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
      RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
      RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT: path.join(
        rootDir,
        "scripts",
        "bootstrap-entrypoint.sh",
      ),
      RIN_BOOTSTRAP_TEST_LOG: logPath,
    };

    await runBootstrapWrapper("install.sh", ["--quick-run", "--beta"], env);

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/releases\/beta-1\.2\.4-beta\.20260420\.tar\.gz -o /,
    );
    assert.match(log, /npm:.*:ci --no-fund --no-audit/);
    assert.match(log, /npm:.*:run build/);
    assert.match(
      log,
      /node:.*:stdin_tty=0:stdout_tty=0:dist\/app\/rin-install\/main\.js --release-file [^\s]+ --quick-run/,
    );
  });
});

test("update bootstrap rejects quick-run", async () => {
  await assertBootstrapFails(["update", "--quick-run"], {
    stderr: /--quick-run is only supported by install\.sh/,
  });
});

test("bootstrap wrappers forward beta nightly and git channel selections", async () => {
  await withTempDir(async (tempDir) => {
    const archivePath = await createSourceArchive(tempDir);
    const manifestPath = await createReleaseManifest(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    await createFakeBin(fakeBin, logPath);
    await fs.mkdir(workRoot, { recursive: true });

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
      TMPDIR: workRoot,
      RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
      RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
      RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT: path.join(
        rootDir,
        "scripts",
        "bootstrap-entrypoint.sh",
      ),
      RIN_BOOTSTRAP_TEST_LOG: logPath,
    };

    await runBootstrapWrapper("install.sh", ["--beta"], env);
    await runBootstrapWrapper("install.sh", ["--nightly"], env);
    await runBootstrapWrapper("update.sh", ["--git", "main"], env);

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /node:.*:stdin_tty=0:stdout_tty=0:dist\/app\/rin-install\/main\.js --release-file [^\s]+/,
    );
    assert.match(
      log,
      /node:.*:stdin_tty=0:stdout_tty=0:dist\/app\/rin-install\/main\.js --release-file [^\s]+/,
    );
    assert.match(
      log,
      /node:.*:stdin_tty=0:stdout_tty=0:dist\/app\/rin-install\/main\.js --release-file [^\s]+ --update/,
    );
  });
});

test("piped install wrapper reattaches the installer to /dev/tty", async (t) => {
  if (process.platform === "win32") {
    t.skip("requires a POSIX tty");
    return;
  }

  const scriptPath = (
    await execFileAsync("sh", ["-lc", "command -v script || true"])
  ).stdout.trim();
  if (!scriptPath) {
    t.skip("script command is unavailable");
    return;
  }

  await withTempDir(async (tempDir) => {
    const archivePath = await createSourceArchive(tempDir);
    const manifestPath = await createReleaseManifest(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    await createFakeBin(fakeBin, logPath);
    await fs.mkdir(workRoot, { recursive: true });

    const runnerPath = path.join(tempDir, "run-piped-install.sh");
    await writeExecutable(
      runnerPath,
      `#!/bin/sh
printf x | sh "${path.join(rootDir, "install.sh")}" --git
`,
    );

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
      TMPDIR: workRoot,
      RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
      RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
      RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT: path.join(
        rootDir,
        "scripts",
        "bootstrap-entrypoint.sh",
      ),
      RIN_BOOTSTRAP_TEST_LOG: logPath,
    };

    await execFileAsync(scriptPath, ["-qec", runnerPath, "/dev/null"], {
      cwd: rootDir,
      env,
    });

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /node:.*:stdin_tty=1:stdout_tty=1:dist\/app\/rin-install\/main\.js --release-file [^\s]+/,
    );
  });
});
