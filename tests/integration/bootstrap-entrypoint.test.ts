import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
        dependencies: { "better-sqlite3": "12.11.1", chalk: "^5.6.2" },
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

async function createPlatformBundleArchive(tempDir, options: any = {}) {
  const bundleRoot = path.join(tempDir, "rin-platform-bundle");
  const nodePath = path.join(
    bundleRoot,
    "runtime",
    "node",
    "current",
    "bin",
    "node",
  );
  await fs.mkdir(path.dirname(nodePath), { recursive: true });
  await fs.mkdir(path.join(bundleRoot, "dist", "app", "rin-install"), {
    recursive: true,
  });
  await writeExecutable(
    nodePath,
    `#!/bin/sh
echo "bundled-node:$PWD:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
case "$1" in
  *npm-cli.js)
    if [ "\${PATH%%:*}" != "$(dirname "$0")" ]; then exit 46; fi
    exit ${options.failNpm ? 44 : 0}
    ;;
  -e) exit ${options.failNative ? 45 : 0} ;;
esac
if [ ! -f "$1" ]; then
  echo "missing-entry:$PWD:$1" >>"$RIN_BOOTSTRAP_TEST_LOG"
  exit 43
fi
exit 0
`,
  );
  const npmCliPath = path.join(
    bundleRoot,
    "runtime",
    "node",
    "current",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  await fs.mkdir(path.dirname(npmCliPath), { recursive: true });
  await fs.writeFile(npmCliPath, "export {};\n");
  await fs.mkdir(path.join(bundleRoot, "node_modules", "better-sqlite3"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(bundleRoot, "node_modules", "better-sqlite3", "package.json"),
    JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }),
  );
  await fs.writeFile(
    path.join(bundleRoot, "dist", "app", "rin-install", "main.js"),
    "export {};\n",
    "utf8",
  );
  const archivePath = path.join(tempDir, "rin-platform-bundle.tar.gz");
  await execFileAsync("tar", [
    "-czf",
    archivePath,
    "-C",
    tempDir,
    "rin-platform-bundle",
  ]);
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
  const fakeNpmRoot = path.join(
    path.dirname(fakeBin),
    "lib",
    "node_modules",
    "npm",
  );
  const fakeNpmCli = path.join(fakeNpmRoot, "bin", "npm-cli.js");
  await fs.mkdir(path.dirname(fakeNpmCli), { recursive: true });
  await fs.writeFile(
    path.join(fakeNpmRoot, "package.json"),
    JSON.stringify({ name: "npm", version: "10.0.0" }),
  );
  await writeExecutable(fakeNpmCli, "export {};\n");
  await fs.writeFile(
    path.join(fakeNpmRoot, "bin", "npx-cli.js"),
    "export {};\n",
  );
  await fs.symlink(
    path.relative(fakeBin, fakeNpmCli),
    path.join(fakeBin, "npm"),
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

if (String(args[0] || "").endsWith("npm-cli.js")) {
  const npmArgs = args.slice(1);
  fs.appendFileSync(logPath, "npm:" + process.cwd() + ":" + npmArgs.join(" ") + "\\n", "utf8");
  if (npmArgs[0] === "install" || npmArgs[0] === "ci") {
    fs.mkdirSync("node_modules/better-sqlite3", { recursive: true });
    fs.writeFileSync(
      "node_modules/better-sqlite3/package.json",
      JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }),
    );
  }
  if (npmArgs[0] === "run" && npmArgs[1] === "build") {
    fs.mkdirSync("dist/app/rin-install", { recursive: true });
    fs.writeFileSync("dist/app/rin-install/main.js", "export {};\\n");
  }
  process.exit(0);
}

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
    await writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/bin/sh
OUT=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT=$2; shift 2 ;;
    *) shift ;;
  esac
done
printf '{"schemaVersion":2,"stable":{"version":"1.2.3"}}\n' >"$OUT"
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

test("POSIX bootstrap rejects invalid release manifests without inventing 0.0.0", async (t) => {
  for (const fixture of [
    { name: "malformed JSON", content: "{\n" },
    { name: "empty object", content: "{}\n" },
    {
      name: "missing selected channel",
      content: `${JSON.stringify({ schemaVersion: 2, beta: { version: "1.2.3-beta.1" } })}\n`,
    },
    {
      name: "missing stable identity",
      content: `${JSON.stringify({ schemaVersion: 2, stable: {} })}\n`,
    },
  ]) {
    await t.test(fixture.name, async () => {
      await withTempDir(async (tempDir) => {
        const fakeBin = path.join(tempDir, "bin");
        const manifestPath = path.join(tempDir, "release-manifest.json");
        const logPath = path.join(tempDir, "fetch.log");
        const workRoot = path.join(tempDir, "work");
        await fs.mkdir(fakeBin, { recursive: true });
        await fs.mkdir(workRoot, { recursive: true });
        await fs.writeFile(manifestPath, fixture.content, "utf8");
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
  *release-manifest.json) cp "$RIN_BOOTSTRAP_TEST_MANIFEST" "$OUT" ;;
  *) exit 22 ;;
esac
`,
        );
        await writeExecutable(
          path.join(fakeBin, "wget"),
          "#!/bin/sh\nexit 1\n",
        );

        await assert.rejects(
          execFileAsync(
            "sh",
            [
              path.join(rootDir, "scripts", "bootstrap-entrypoint.sh"),
              "install",
            ],
            {
              cwd: rootDir,
              env: {
                ...process.env,
                PATH: `${fakeBin}:${process.env.PATH}`,
                RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
                RIN_BOOTSTRAP_TEST_LOG: logPath,
                RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
                TMPDIR: workRoot,
              },
            },
          ),
          (error) => {
            assert.match(
              String(error.stderr || ""),
              /invalid Rin release manifest/,
            );
            return true;
          },
        );

        const fetchLog = await fs.readFile(logPath, "utf8");
        assert.doesNotMatch(fetchLog, /0\.0\.0|registry\.npmjs\.org/);
      });
    });
  }
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

test("bootstrap source selection never falls back to mutable main", async () => {
  const [installSh, installPs1, entrypointSh, entrypointPs1] =
    await Promise.all(
      [
        "install.sh",
        "install.ps1",
        "scripts/bootstrap-entrypoint.sh",
        "scripts/bootstrap-entrypoint.ps1",
      ].map((relativePath) =>
        fs.readFile(path.join(rootDir, relativePath), "utf8"),
      ),
    );
  assert.doesNotMatch(installSh, /MAIN_BOOTSTRAP_SCRIPT_URL|FALLBACK_URL/);
  assert.doesNotMatch(installPs1, /mainBootstrapScriptUrl|FALLBACK_URL/);
  assert.doesNotMatch(entrypointSh, /FALLBACK_URL=.*\/main\//);
  assert.doesNotMatch(entrypointPs1, /\$fallbackUrl = .*\/main\//);
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
  assert.match(entrypoint, /\$arg -ieq "install"/);
  assert.doesNotMatch(entrypoint, /\$arg -ieq "update"/);
  assert.match(entrypoint, /Parse-Args \$parseArgs/);
  assert.match(
    entrypoint,
    /\$nodeVersionOutput = & node -p "process\.versions\.node"/,
  );
  assert.match(entrypoint, /\$nodeExitCode = \$LASTEXITCODE/);
  assert.match(entrypoint, /if \(\$nodeExitCode -ne 0 -or -not \$rawVersion\)/);
  assert.match(entrypoint, /\$logFile = Join-Path \$workDir \$logName/);
  assert.match(entrypoint, /Add-BootstrapLog \$jobOutput/);
  assert.match(entrypoint, /Show-RecentBootstrapLog/);
  assert.match(entrypoint, /Receive-Job -Job \$job -Wait \*>&1/);
  assert.match(entrypoint, /if \(\$job\.State -eq "Failed"\)/);
  assert.match(entrypoint, /Rin bootstrap debug directory preserved:/);
  assert.match(entrypoint, /ERROR: \$message/);
  assert.match(entrypoint, /function Provision-SourceManagedNode/);
  const powerShellProvision = entrypoint.slice(
    entrypoint.indexOf("function Provision-SourceManagedNode"),
    entrypoint.indexOf(
      "\ntry {",
      entrypoint.indexOf("function Provision-SourceManagedNode"),
    ),
  );
  assert.match(
    powerShellProvision,
    /\$managedNodeExists = Test-Path -LiteralPath \$managedNode -PathType Leaf/,
  );
  assert.match(
    powerShellProvision,
    /if \(-not \$managedNodeExists\) \{[\s\S]*Remove-Item -LiteralPath \$managedRoot[\s\S]*Copy-Item -LiteralPath \$sourceNode -Destination \$managedNode[\s\S]*\$copiedSourceNode = \$true[\s\S]*\}/,
  );
  assert.match(
    powerShellProvision,
    /if \(\$copiedSourceNode -and \(Test-Path[\s\S]*\$sourceNpmRoot[\s\S]*Copy-Item -LiteralPath \$sourceNpmRoot/,
  );
  assert.match(
    entrypoint,
    /& \$using:managedNode \$using:managedNpmCli (?:install|ci)/,
  );
  const stableDependencyJob = entrypoint.slice(
    entrypoint.indexOf('if ($release.Channel -eq "stable")'),
    entrypoint.indexOf('} elseif (Test-Path -LiteralPath "package-lock.json")'),
  );
  assert.match(
    stableDependencyJob,
    /\.PSObject\.Properties\.Name -contains "prepare"/,
  );
  assert.doesNotMatch(stableDependencyJob, /Get-Property/);
  assert.doesNotMatch(stableDependencyJob, /catch\s*\{\s*\}/);
  assert.match(entrypoint, /& \$managedNode @installerArgs/);
  assert.doesNotMatch(entrypoint, /^\s*npm (?:install|ci|run|prune)/m);
  assert.doesNotMatch(
    entrypoint,
    /Receive-Job -Job \$job -Wait -ErrorAction Stop/,
  );
  assert.doesNotMatch(
    entrypoint,
    /Receive-Job -Job \$job -Wait -ErrorAction SilentlyContinue \| Out-Null/,
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
  const shellProvision = shell.slice(
    shell.indexOf("provision_source_managed_node()"),
    shell.indexOf(
      "\nresolve_release()",
      shell.indexOf("provision_source_managed_node()"),
    ),
  );
  assert.match(
    shellProvision,
    /if \[ ! -x "\$target_node" \]; then[\s\S]*rm -rf "\$target_root"[\s\S]*cp "\$node_path" "\$target_node"[\s\S]*copied_source_node=1/,
  );
  assert.match(
    shellProvision,
    /if \[ -n "\$copied_source_node" \]; then[\s\S]*npm_root="\$node_root\/lib\/node_modules\/npm"[\s\S]*cp -RL "\$npm_root" "\$target_npm_root"/,
  );
});

test("install wrapper can launch a platform bundle without system node or npm", async (t) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    t.skip("fixture targets linux-x64 bootstrap detection");
    return;
  }
  await withTempDir(async (tempDir) => {
    const archivePath = await createPlatformBundleArchive(tempDir);
    const archiveSha256 = createHash("sha256")
      .update(await fs.readFile(archivePath))
      .digest("hex");
    const manifestPath = await createReleaseManifest(tempDir);
    const assetsPath = path.join(tempDir, "release-assets.env");
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.mkdir(workRoot, { recursive: true });
    await fs.writeFile(logPath, "", "utf8");
    await fs.writeFile(
      assetsPath,
      [
        "RIN_ASSET_STABLE_LINUX_X64_URL='https://example.invalid/releases/rin-1.2.3-linux-x64.tar.gz'",
        `RIN_ASSET_STABLE_LINUX_X64_SHA256='${archiveSha256}'`,
        "RIN_ASSET_STABLE_LINUX_X64_VERSION='1.2.3'",
        "RIN_ASSET_STABLE_LINUX_X64_BRANCH='stable'",
        "RIN_ASSET_STABLE_LINUX_X64_REF='abc1234'",
        "RIN_ASSET_STABLE_LINUX_X64_SOURCE_LABEL='stable 1.2.3'",
        "",
      ].join("\n"),
      "utf8",
    );
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
  *scripts/bootstrap-entrypoint.sh) cp "$RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT" "$OUT" ;;
  *release-manifest.json) cp "$RIN_BOOTSTRAP_TEST_MANIFEST" "$OUT" ;;
  *release-assets.env) cp "$RIN_BOOTSTRAP_TEST_ASSETS" "$OUT" ;;
  *) cp "$RIN_BOOTSTRAP_TEST_ARCHIVE" "$OUT" ;;
esac
`,
    );
    await writeExecutable(
      path.join(fakeBin, "node"),
      `#!/bin/sh
echo "system-node:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
exit 42
`,
    );
    await writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/bin/sh
echo "npm:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
exit 42
`,
    );

    const env = {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
      TMPDIR: workRoot,
      RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
      RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
      RIN_BOOTSTRAP_TEST_ASSETS: assetsPath,
      RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT: path.join(
        rootDir,
        "scripts",
        "bootstrap-entrypoint.sh",
      ),
      RIN_BOOTSTRAP_TEST_LOG: logPath,
    };

    await runBootstrapWrapper("install.sh", [], env);

    const log = await fs.readFile(logPath, "utf8");
    assert.match(log, /release-assets\.env/);
    assert.match(log, /rin-1\.2\.3-linux-x64\.tar\.gz/);
    assert.match(log, /bundled-node:.*npm-cli\.js --version/);
    assert.match(
      log,
      /bundled-node:.*-e const Database=require\('better-sqlite3'\)/,
    );
    assert.match(
      log,
      /bundled-node:.*dist\/app\/rin-install\/main\.js --release-file /,
    );
    assert.doesNotMatch(log, /system-node:/);
    assert.doesNotMatch(log, /npm:/);
    assert.deepEqual(await fs.readdir(workRoot), []);
  });
});

test("platform bundle bootstrap rejects broken managed npm and native dependencies before launch", async (t) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    t.skip("fixture targets linux-x64 bootstrap detection");
    return;
  }
  for (const failure of ["npm", "native"]) {
    await withTempDir(async (tempDir) => {
      const archivePath = await createPlatformBundleArchive(tempDir, {
        failNpm: failure === "npm",
        failNative: failure === "native",
      });
      const archiveSha256 = createHash("sha256")
        .update(await fs.readFile(archivePath))
        .digest("hex");
      const manifestPath = await createReleaseManifest(tempDir);
      const assetsPath = path.join(tempDir, "release-assets.env");
      const fakeBin = path.join(tempDir, "bin");
      const logPath = path.join(tempDir, "invocations.log");
      const workRoot = path.join(tempDir, "work");
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.mkdir(workRoot, { recursive: true });
      await fs.writeFile(logPath, "", "utf8");
      await fs.writeFile(
        assetsPath,
        [
          "RIN_ASSET_STABLE_LINUX_X64_URL='https://example.invalid/releases/rin-1.2.3-linux-x64.tar.gz'",
          `RIN_ASSET_STABLE_LINUX_X64_SHA256='${archiveSha256}'`,
          "RIN_ASSET_STABLE_LINUX_X64_VERSION='1.2.3'",
          "RIN_ASSET_STABLE_LINUX_X64_BRANCH='stable'",
          "RIN_ASSET_STABLE_LINUX_X64_REF='abc1234'",
          "RIN_ASSET_STABLE_LINUX_X64_SOURCE_LABEL='stable 1.2.3'",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/bin/sh
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
  *scripts/bootstrap-entrypoint.sh) cp "$RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT" "$OUT" ;;
  *release-manifest.json) cp "$RIN_BOOTSTRAP_TEST_MANIFEST" "$OUT" ;;
  *release-assets.env) cp "$RIN_BOOTSTRAP_TEST_ASSETS" "$OUT" ;;
  *) cp "$RIN_BOOTSTRAP_TEST_ARCHIVE" "$OUT" ;;
esac
`,
      );

      await assert.rejects(
        runBootstrapWrapper("install.sh", [], {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
          TMPDIR: workRoot,
          RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
          RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
          RIN_BOOTSTRAP_TEST_ASSETS: assetsPath,
          RIN_BOOTSTRAP_TEST_BOOTSTRAP_SCRIPT: path.join(
            rootDir,
            "scripts",
            "bootstrap-entrypoint.sh",
          ),
          RIN_BOOTSTRAP_TEST_LOG: logPath,
        }),
      );
      const log = await fs.readFile(logPath, "utf8");
      assert.doesNotMatch(
        log,
        /dist\/app\/rin-install\/main\.js --release-file /,
      );
      assert.match(log, /npm-cli\.js --version/);
      if (failure === "native") {
        assert.match(log, /-e const Database=require\('better-sqlite3'\)/);
      }
    });
  }
});

test("platform bundle bootstrap rejects missing or mismatched checksums", async (t) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    t.skip("fixture targets linux-x64 bootstrap detection");
    return;
  }
  await withTempDir(async (tempDir) => {
    const archivePath = await createPlatformBundleArchive(tempDir);
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
  *release-manifest.json) cp "$RIN_BOOTSTRAP_TEST_MANIFEST" "$OUT" ;;
  *release-assets.env) cp "$RIN_BOOTSTRAP_TEST_ASSETS" "$OUT" ;;
  *) cp "$RIN_BOOTSTRAP_TEST_ARCHIVE" "$OUT" ;;
esac
`,
    );

    async function assertAssetsFail(lines, pattern) {
      const assetsPath = path.join(
        tempDir,
        `release-assets-${Math.random().toString(16).slice(2)}.env`,
      );
      await fs.writeFile(assetsPath, `${lines.join("\n")}\n`, "utf8");
      await assert.rejects(
        execFileAsync(
          "sh",
          [path.join(rootDir, "scripts", "bootstrap-entrypoint.sh"), "install"],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              PATH: `${fakeBin}:/usr/bin:/bin`,
              RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
              TMPDIR: workRoot,
              RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
              RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
              RIN_BOOTSTRAP_TEST_ASSETS: assetsPath,
              RIN_BOOTSTRAP_TEST_LOG: logPath,
            },
          },
        ),
        { stderr: pattern },
      );
    }

    const baseAssets = [
      "RIN_ASSET_STABLE_LINUX_X64_URL='https://example.invalid/releases/rin-1.2.3-linux-x64.tar.gz'",
      "RIN_ASSET_STABLE_LINUX_X64_VERSION='1.2.3'",
      "RIN_ASSET_STABLE_LINUX_X64_BRANCH='stable'",
      "RIN_ASSET_STABLE_LINUX_X64_REF='abc1234'",
      "RIN_ASSET_STABLE_LINUX_X64_SOURCE_LABEL='stable 1.2.3'",
    ];
    await assertAssetsFail(
      baseAssets,
      /rin bootstrap platform bundle checksum is missing/,
    );
    await assertAssetsFail(
      [
        baseAssets[0],
        "RIN_ASSET_STABLE_LINUX_X64_SHA256='0000000000000000000000000000000000000000000000000000000000000000'",
        ...baseAssets.slice(1),
      ],
      /rin bootstrap platform bundle checksum mismatch/,
    );
  });
});

test("stable install wrapper resolves release metadata then npm-installs package runtime dependencies", async () => {
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
    assert.match(log, /node:.*:-e const Database=require\('better-sqlite3'\)/);

    assert.deepEqual(await fs.readdir(workRoot), []);
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

test("wrapper-only bootstrap exports fail closed when their selected entrypoint is unavailable", async () => {
  await withTempDir(async (tempDir) => {
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    const bootstrapDir = path.join(tempDir, "bootstrap");
    await fs.mkdir(fakeBin, { recursive: true });
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
    await fs.rm(path.join(bootstrapDir, "scripts"), {
      recursive: true,
      force: true,
    });
    await writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/bin/sh
echo "curl:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
case "$*" in
  */bootstrap/scripts/bootstrap-entrypoint.sh*) exit 22 ;;
  */main/scripts/bootstrap-entrypoint.sh*) exit 0 ;;
  *) exit 22 ;;
esac
`,
    );

    await assert.rejects(
      execFileAsync("sh", [path.join(bootstrapDir, "install.sh")], {
        cwd: bootstrapDir,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
          RIN_INSTALL_TMPDIR: workRoot,
          RIN_BOOTSTRAP_TEST_LOG: logPath,
        },
      }),
    );

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/rin\/bootstrap\/scripts\/bootstrap-entrypoint\.sh -o /,
    );
    assert.doesNotMatch(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/rin\/main\/scripts\/bootstrap-entrypoint\.sh -o /,
    );
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
    assert.match(log, /npm:.*:prune --omit=dev --no-fund --no-audit/);
    assert.match(
      log,
      /node:.*:stdin_tty=0:stdout_tty=0:dist\/app\/rin-install\/main\.js --release-file [^\s]+ --quick-run/,
    );
  });
});

test("install wrapper forwards beta nightly and git channel selections", async () => {
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
    await runBootstrapWrapper("install.sh", ["--git", "main"], env);

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /node:.*:stdin_tty=0:stdout_tty=0:dist\/app\/rin-install\/main\.js --release-file [^\s]+/,
    );
    assert.match(
      log,
      /node:.*:stdin_tty=0:stdout_tty=0:dist\/app\/rin-install\/main\.js --release-file [^\s]+/,
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
