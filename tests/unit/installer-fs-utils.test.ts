import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const fsUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "fs-utils.js"),
  ).href
);
const tempBaseDir = "/home/rin/tmp";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("installer fs utils compute launcher targets and require managed node", () => {
  const targets = fsUtils.launcherTargetsForInstallDir("/tmp/rin");
  assert.ok(
    targets.rin[0].endsWith(path.join("dist", "app", "rin", "main.js")),
  );
  assert.equal(targets.rinGui, undefined);
  assert.equal(targets.rinTui, undefined);
  assert.throws(
    () => fsUtils.installedRuntimeNodeCommandArgs({ installDir: "/tmp/rin" }),
    /rin_managed_node_runtime_missing/,
  );
  const windowsScript = fsUtils.windowsCmdLauncherScript(targets.rin, [], {
    nodeCommandArgs: ["C:\\Rin\\runtime\\node\\current\\node.exe"],
    detached: false,
    missingMessage: "rin: installed runtime entry not found",
  });
  assert.match(windowsScript, /^@echo off\r?$/m);
  assert.match(windowsScript, /rin/);
  assert.match(windowsScript, /%\*/);
  assert.doesNotMatch(windowsScript, /start ""/);
  assert.doesNotMatch(windowsScript, /env node/);
  assert.equal(fsUtils.currentRuntimeLinkTypeForPlatform("win32"), "junction");
  assert.equal(fsUtils.currentRuntimeLinkTypeForPlatform("linux"), "dir");
});

test("Windows PATH helpers add the launcher directory once", () => {
  const launcherDir = "C:\\Users\\demo\\.local\\bin";
  assert.equal(
    fsUtils.buildPathValueWithDirectory("C:\\Windows", launcherDir, ";"),
    `${launcherDir};C:\\Windows`,
  );
  assert.equal(
    fsUtils.buildPathValueWithDirectory(
      `C:\\Windows;${launcherDir.toUpperCase()}`,
      launcherDir,
      ";",
    ),
    `C:\\Windows;${launcherDir.toUpperCase()}`,
  );

  let written = "";
  const result = fsUtils.ensureWindowsUserPathIncludes(launcherDir, {
    platform: "win32",
    readUserPath: () => "C:\\Windows",
    writeUserPath: (nextPath: string) => {
      written = nextPath;
    },
  });
  assert.equal(result.updated, true);
  assert.equal(written, `${launcherDir};C:\\Windows`);
});

test("writeLaunchersForUser uses the managed node runtime when present", async () => {
  const home = await fs.mkdtemp(path.join(tempBaseDir, "rin-managed-home-"));
  const installDir = path.join(home, ".rin");
  const nodePath = path.join(
    installDir,
    "runtime",
    "node",
    "current",
    "bin",
    "node",
  );
  await fs.mkdir(path.dirname(nodePath), { recursive: true });
  await fs.writeFile(nodePath, "#!/bin/sh\n", "utf8");
  await fs.chmod(nodePath, 0o755);

  const launchers = fsUtils.writeLaunchersForUser(
    "demo",
    installDir,
    () => home,
  );
  const rinScript = await fs.readFile(launchers.rinPath, "utf8");
  assert.ok(rinScript.includes(`'${nodePath}'`));
  assert.equal(rinScript.includes("'/usr/bin/env' 'node'"), false);

  await fs.rm(home, { recursive: true, force: true });
});

test("writeLaunchersForUser writes native Windows rin command launchers", async () => {
  const home = await fs.mkdtemp(path.join(tempBaseDir, "rin-win-home-"));
  const installDir = path.join(home, ".rin");
  const managedNode = path.join(
    installDir,
    "runtime",
    "node",
    "current",
    "node.exe",
  );
  await fs.mkdir(path.dirname(managedNode), { recursive: true });
  await fs.writeFile(managedNode, "", { mode: 0o755 });

  const launchers = fsUtils.writeLaunchersForUser(
    "demo",
    installDir,
    () => home,
    {
      platform: "win32",
    },
  );

  assert.equal(launchers.rinPath, path.join(home, ".local", "bin", "rin.cmd"));
  assert.equal(
    launchers.rinInstallPath,
    path.join(home, ".local", "bin", "rin-install.cmd"),
  );
  assert.equal(launchers.rinTuiPath, undefined);
  assert.equal(launchers.rinGuiPath, undefined);
  assert.equal(launchers.windowsGuiShortcutPaths, undefined);
  assert.equal(launchers.windowsPathUpdate.skipped, true);
  const rinScript = await fs.readFile(launchers.rinPath, "utf8");
  assert.match(rinScript, /dist[\\/]app[\\/]rin[\\/]main\.js/);
  assert.match(rinScript, new RegExp(escapeRegex(managedNode)));
  assert.match(rinScript, /%\*/);
  assert.doesNotMatch(rinScript, /env node/);
  assert.doesNotMatch(rinScript, /start ""/);
  await assert.rejects(
    fs.access(path.join(home, ".local", "bin", "rin-tui.cmd")),
  );
  await assert.rejects(fs.access(path.join(home, "Desktop", "Rin GUI.cmd")));

  await fs.rm(home, { recursive: true, force: true });
});

test("commandAsUserInvocation prefers runuser for root", () => {
  const invocation = fsUtils.commandAsUserInvocation(
    "demo",
    "node",
    ["--version"],
    { DEMO_ENV: "hello world" },
    {
      isRoot: true,
      hasRunuser: true,
      privilegeCommand: "/usr/bin/sudo",
    },
  );

  assert.equal(invocation.command, "/usr/sbin/runuser");
  assert.deepEqual(invocation.args, [
    "-u",
    "demo",
    "--",
    "sh",
    "-lc",
    "DEMO_ENV='hello world' 'node' '--version'",
  ]);
});

test("commandAsUserInvocation uses sudo style user switch when needed", () => {
  const invocation = fsUtils.commandAsUserInvocation(
    "demo",
    "node",
    ["-e", "console.log($HOME)"],
    {},
    {
      isRoot: false,
      hasRunuser: false,
      privilegeCommand: "/usr/bin/sudo",
    },
  );

  assert.equal(invocation.command, "/usr/bin/sudo");
  assert.deepEqual(invocation.args, [
    "-u",
    "demo",
    "sh",
    "-lc",
    "'node' '-e' 'console.log($HOME)'",
  ]);
});

test("commandAsUserInvocation falls back to plain privilege shell command", () => {
  const invocation = fsUtils.commandAsUserInvocation(
    "demo",
    "node",
    ["--version"],
    {},
    {
      isRoot: false,
      hasRunuser: false,
      privilegeCommand: "/usr/bin/pkexec",
    },
  );

  assert.equal(invocation.command, "/usr/bin/pkexec");
  assert.deepEqual(invocation.args, ["sh", "-lc", "'node' '--version'"]);
});

test("installer fs utils prefer Rin temp roots deterministically", () => {
  const previousTmpDir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = "/tmp/rin-custom-root";
    assert.deepEqual(fsUtils.installerTempRootCandidates().slice(0, 2), [
      path.resolve("/tmp/rin-custom-root"),
      path.resolve("/home/rin/tmp"),
    ]);
  } finally {
    if (previousTmpDir == null) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  }
});

test("elevated install writes create target-owned parent directories", () => {
  const source = fsSync.readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "fs-utils.ts"),
    "utf8",
  );

  assert.match(source, /function ensurePrivilegedOwnedDir/);
  assert.match(
    source,
    /ensurePrivilegedOwnedDir\(path\.dirname\(filePath\), ownerUser, ownerGroup\)/,
  );
  assert.match(
    source,
    /ensurePrivilegedOwnedDir\(path\.dirname\(destDir\), target\?\.name, targetGroup\)/,
  );
  assert.match(
    source,
    /ensurePrivilegedOwnedDir\(\s*path\.dirname\(releaseRoot\),\s*target\?\.name,\s*targetGroup,?\s*\)/,
  );
  assert.doesNotMatch(
    source,
    /runPrivileged\("mkdir", \["-p", path\.dirname\(filePath\)\]\)/,
  );
});

test("syncTree warns when a replaced backup cannot be removed", async () => {
  const tempRoot = await fs.mkdtemp(path.join(tempBaseDir, "rin-sync-tree-"));
  const source = path.join(tempRoot, "source");
  const dest = path.join(tempRoot, "dest");
  const fakeBin = path.join(tempRoot, "bin");

  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "NEW.md"), "new\n", "utf8");
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, "OLD.md"), "old\n", "utf8");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeRm = path.join(fakeBin, "rm");
  await fs.writeFile(
    fakeRm,
    "#!/bin/sh\necho fake rm failure >&2\nexit 1\n",
    "utf8",
  );
  await fs.chmod(fakeRm, 0o755);

  const previousPath = process.env.PATH;
  const originalStderrWrite = process.stderr.write;
  let stderr = "";
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
    process.stderr.write = ((chunk: any, ...args: any[]) => {
      stderr += String(chunk);
      return (originalStderrWrite as any).call(process.stderr, chunk, ...args);
    }) as typeof process.stderr.write;

    fsUtils.syncTree(source, dest);
  } finally {
    process.stderr.write = originalStderrWrite;
    if (previousPath == null) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  await fs.access(path.join(dest, "NEW.md"));
  await assert.rejects(fs.access(path.join(dest, "OLD.md")));
  const leftovers = (await fs.readdir(tempRoot)).filter((name) =>
    name.startsWith(".dest.backup-"),
  );
  assert.equal(leftovers.length, 1);
  assert.match(stderr, /rin update warning: replaced old tree/);
  assert.match(stderr, /could not remove backup/);
  assert.doesNotMatch(stderr, /root-owned|sudo rm -rf|cleanup needs/);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("syncInstalledDocs installs Rin-owned and selected upstream builtin skills", async () => {
  const tempRoot = await fs.mkdtemp(path.join(tempBaseDir, "rin-install-src-"));
  const installDir = await fs.mkdtemp(
    path.join(tempBaseDir, "rin-install-dst-"),
  );

  await fs.mkdir(path.join(tempRoot, "docs", "agent"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "docs", "agent", "README.md"),
    "# Rin agent docs\n",
    "utf8",
  );
  await fs.mkdir(
    path.join(
      tempRoot,
      "docs",
      "agent",
      "builtin-skills",
      "rin-prompt-engineering",
    ),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      tempRoot,
      "docs",
      "agent",
      "builtin-skills",
      "rin-prompt-engineering",
      "SKILL.md",
    ),
    "# Rin Prompt Engineering\n",
    "utf8",
  );
  await fs.mkdir(path.join(tempRoot, "docs", "release"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "docs", "release", "CHANGELOG.md"),
    "# Rin changelog\n",
    "utf8",
  );
  await fs.mkdir(path.join(tempRoot, "upstream", "pi", "docs"), {
    recursive: true,
  });
  await fs.mkdir(path.join(tempRoot, "upstream", "pi", "examples"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(tempRoot, "upstream", "pi", "README.md"),
    "# Pi docs\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "upstream", "pi", "CHANGELOG.md"),
    "# Changelog\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "upstream", "pi", "docs", "models.md"),
    "# Models\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "upstream", "pi", "examples", "README.md"),
    "# Examples\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "upstream", "pi", "_upstream.json"),
    "{}\n",
    "utf8",
  );
  await fs.mkdir(path.join(tempRoot, "upstream", "skill-creator"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(tempRoot, "upstream", "skill-creator", "SKILL.md"),
    "# Skill\n",
    "utf8",
  );
  await fs.mkdir(
    path.join(installDir, "docs", "rin", "builtin-skills", "legacy"),
    {
      recursive: true,
    },
  );
  await fs.writeFile(
    path.join(installDir, "docs", "rin", "builtin-skills", "legacy", "OLD.md"),
    "# Old\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(installDir, "docs", "rin", "obsolete.md"),
    "obsolete\n",
    "utf8",
  );

  const installedDocs = fsUtils.syncInstalledDocs(
    tempRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );

  assert.equal(installedDocs.pi.length, 5);
  await fs.access(path.join(installDir, "docs", "rin", "README.md"));
  await fs.access(path.join(installDir, "docs", "release", "CHANGELOG.md"));
  await fs.access(path.join(installDir, "docs", "pi", "README.md"));
  await fs.access(path.join(installDir, "docs", "pi", "CHANGELOG.md"));
  await fs.access(path.join(installDir, "docs", "pi", "docs", "models.md"));
  await fs.access(path.join(installDir, "docs", "pi", "examples", "README.md"));
  await fs.access(path.join(installDir, "docs", "pi", "_upstream.json"));
  await fs.access(
    path.join(
      installDir,
      "docs",
      "rin",
      "builtin-skills",
      "rin-prompt-engineering",
      "SKILL.md",
    ),
  );
  await fs.access(
    path.join(
      installDir,
      "docs",
      "rin",
      "builtin-skills",
      "skill-creator",
      "SKILL.md",
    ),
  );
  await assert.rejects(
    fs.access(
      path.join(
        installDir,
        "docs",
        "rin",
        "builtin-skills",
        "legacy",
        "OLD.md",
      ),
    ),
  );
  await assert.rejects(
    fs.access(path.join(installDir, "docs", "rin", "obsolete.md")),
  );
});

async function makeRuntimeSource(version = "0.0.0") {
  const tempRoot = await fs.mkdtemp(path.join(tempBaseDir, "rin-install-src-"));
  await fs.mkdir(path.join(tempRoot, "dist", "app", "rin"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(tempRoot, "dist", "app", "rin", "main.js"),
    "export {};",
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify({ version }, null, 2)}\n`,
    "utf8",
  );
  await fs.symlink(
    path.join(rootDir, "node_modules"),
    path.join(tempRoot, "node_modules"),
  );
  return tempRoot;
}

function packageDir(nodeModules: string, name: string) {
  return path.join(nodeModules, ...name.split("/"));
}

async function writePackage(
  nodeModules: string,
  name: string,
  version: string,
) {
  const dir = packageDir(nodeModules, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name, version })}\n`,
    "utf8",
  );
}

async function makeRuntimeSourceWithRealNodeModules(version = "0.0.0") {
  const tempRoot = await makeRuntimeSource(version);
  await fs.rm(path.join(tempRoot, "node_modules"), { force: true });
  const rootNodeModules = path.join(tempRoot, "node_modules");
  const piNodeModules = path.join(
    rootNodeModules,
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
  );
  await writePackage(rootNodeModules, "same", "1.0.0");
  await writePackage(rootNodeModules, "different", "2.0.0");
  await writePackage(piNodeModules, "same", "1.0.0");
  await writePackage(piNodeModules, "different", "1.0.0");
  return tempRoot;
}

test("installedRuntimeReleaseId names git releases from a short commit hash", async () => {
  const tempRoot = await makeRuntimeSource();

  assert.equal(
    fsUtils.installedRuntimeReleaseId(tempRoot, {
      channel: "git",
      version: "main",
      branch: "main",
      ref: "0123456789abcdef0123456789abcdef01234567",
      sourceLabel: "git branch main @ 0123456789ab",
      archiveUrl: "https://example.invalid/main.tar.gz",
    }),
    "0123456789ab",
  );

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("publishInstalledRuntime names releases from release version metadata", async () => {
  const tempRoot = await makeRuntimeSource();
  const installDir = await fs.mkdtemp(
    path.join(tempBaseDir, "rin-install-dst-"),
  );

  const published = fsUtils.publishInstalledRuntime(
    tempRoot,
    installDir,
    "rin",
    false,
    {
      findSystemUser: () => null,
      release: {
        channel: "stable",
        version: "1.2.3",
        branch: "stable",
        ref: "v1.2.3",
        sourceLabel: "stable 1.2.3",
        archiveUrl: "https://example.invalid/rin-1.2.3.tgz",
      },
    },
  );

  assert.equal(path.basename(published.releaseRoot), "1.2.3");
  await fs.access(
    path.join(published.releaseRoot, "dist", "app", "rin", "main.js"),
  );
});

test("publishManagedNodeRuntime provisions current node for source installs", async () => {
  const sourceRoot = await fs.mkdtemp(
    path.join(tempBaseDir, "rin-source-no-node-"),
  );
  const installDir = await fs.mkdtemp(
    path.join(tempBaseDir, "rin-install-dst-"),
  );

  const published = fsUtils.publishManagedNodeRuntime(
    sourceRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );

  assert.equal(
    published.nodeExecutable,
    path.join(installDir, "runtime", "node", "current", "bin", "node"),
  );
  const copied = await fs.readFile(published.nodeExecutable);
  const current = await fs.readFile(process.execPath);
  assert.deepEqual(copied, current);

  await fs.writeFile(published.nodeExecutable, "existing-managed-node\n");
  const preserved = fsUtils.publishManagedNodeRuntime(
    sourceRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );
  assert.equal(preserved.nodeExecutable, published.nodeExecutable);
  assert.equal(
    await fs.readFile(published.nodeExecutable, "utf8"),
    "existing-managed-node\n",
  );

  if (process.platform !== "win32") {
    await fs.writeFile(published.nodeExecutable, "not-executable\n", {
      mode: 0o644,
    });
    await fs.chmod(published.nodeExecutable, 0o644);
    fsUtils.publishManagedNodeRuntime(sourceRoot, installDir, "rin", false, {
      findSystemUser: () => null,
    });
    assert.deepEqual(
      await fs.readFile(published.nodeExecutable),
      await fs.readFile(process.execPath),
    );

    const badSourceRoot = await fs.mkdtemp(
      path.join(tempBaseDir, "rin-source-bad-node-"),
    );
    const badInstallDir = await fs.mkdtemp(
      path.join(tempBaseDir, "rin-install-bad-node-"),
    );
    const badSourceNode = path.join(
      badSourceRoot,
      "runtime",
      "node",
      "current",
      "bin",
      "node",
    );
    await fs.mkdir(path.dirname(badSourceNode), { recursive: true });
    await fs.writeFile(badSourceNode, "bad-source-node\n", { mode: 0o644 });
    const repaired = fsUtils.publishManagedNodeRuntime(
      badSourceRoot,
      badInstallDir,
      "rin",
      false,
      { findSystemUser: () => null },
    );
    assert.deepEqual(
      await fs.readFile(repaired.nodeExecutable),
      await fs.readFile(process.execPath),
    );
  }
});

test("publishInstalledRuntime prunes exact duplicate Pi shrinkwrap dependencies", async () => {
  const tempRoot = await makeRuntimeSourceWithRealNodeModules();
  const installDir = await fs.mkdtemp(
    path.join(tempBaseDir, "rin-install-dst-"),
  );

  const published = fsUtils.publishInstalledRuntime(
    tempRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );
  const piNodeModules = path.join(
    published.releaseRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
  );

  await assert.rejects(fs.access(packageDir(piNodeModules, "same")));
  await fs.access(packageDir(piNodeModules, "different"));
  await fs.access(path.join(published.releaseRoot, "node_modules", "same"));
});

test("publishInstalledRuntime no longer requires vendored pi-coding-agent sources", async () => {
  const tempRoot = await makeRuntimeSource();
  const installDir = await fs.mkdtemp(
    path.join(tempBaseDir, "rin-install-dst-"),
  );

  const published = fsUtils.publishInstalledRuntime(
    tempRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );

  await fs.access(
    path.join(published.releaseRoot, "dist", "app", "rin", "main.js"),
  );
  await fs.access(path.join(published.releaseRoot, "package.json"));
  await assert.rejects(
    fs.access(path.join(published.releaseRoot, "third_party")),
  );
});

async function seedRuntimeReleases(
  installDir: string,
  releaseNames: string[],
  currentName: string,
) {
  const releasesRoot = path.join(installDir, "app", "releases");
  for (const [index, name] of releaseNames.entries()) {
    const releaseRoot = path.join(releasesRoot, name);
    await fs.mkdir(releaseRoot, { recursive: true });
    await fs.writeFile(path.join(releaseRoot, "package.json"), "{}\n", "utf8");
    const time = new Date(1_700_000_000_000 + index * 1_000);
    await fs.utimes(releaseRoot, time, time);
  }
  await fs.symlink(
    path.join(releasesRoot, currentName),
    path.join(installDir, "app", "current"),
  );
  return releasesRoot;
}

test("pruneInstalledReleases keeps current plus newest releases within the limit", async () => {
  const installDir = await fs.mkdtemp(
    path.join(tempBaseDir, "rin-install-dst-"),
  );
  const releasesRoot = await seedRuntimeReleases(
    installDir,
    ["1.0.0", "1.1.0", "1.2.0", "1.3.0"],
    "1.0.0",
  );

  fsUtils.pruneInstalledReleases(
    installDir,
    3,
    path.join(releasesRoot, "1.0.0"),
    false,
  );

  assert.deepEqual(
    fsUtils.listInstalledReleaseNames(installDir, false).sort(),
    ["1.0.0", "1.2.0", "1.3.0"],
  );
});
