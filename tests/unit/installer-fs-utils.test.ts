import test from "node:test";
import assert from "node:assert/strict";
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

test("installer fs utils compute launcher targets and script", () => {
  const targets = fsUtils.launcherTargetsForInstallDir("/tmp/rin");
  assert.ok(
    targets.rin[0].endsWith(path.join("dist", "app", "rin", "main.js")),
  );
  assert.ok(
    targets.rinGui[0].endsWith(path.join("dist", "app", "rin-gui", "main.js")),
  );
  const script = fsUtils.launcherScript(["/tmp/a.js", "/tmp/b.js"]);
  assert.ok(script.includes("installed runtime entry not found"));
  assert.ok(script.includes("/tmp/a.js"));
  assert.ok(script.includes("PATH="));
  assert.ok(script.includes("'/usr/bin/env' 'node' '/tmp/a.js' \"$@\""));
  assert.equal(script.includes(process.execPath), false);
  const windowsScript = fsUtils.windowsCmdLauncherScript(targets.rinGui);
  assert.match(windowsScript, /^@echo off\r?$/m);
  assert.match(windowsScript, /rin-gui/);
  assert.doesNotMatch(windowsScript, /--app/);
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
  const previousRinTmpDir = process.env.RIN_TMP_DIR;
  const previousTmpDir = process.env.TMPDIR;
  try {
    process.env.RIN_TMP_DIR = "/tmp/rin-custom-root";
    process.env.TMPDIR = "/tmp/rin-custom-root";
    assert.deepEqual(fsUtils.installerTempRootCandidates().slice(0, 2), [
      path.resolve("/tmp/rin-custom-root"),
      path.resolve("/home/rin/tmp"),
    ]);
  } finally {
    if (previousRinTmpDir == null) delete process.env.RIN_TMP_DIR;
    else process.env.RIN_TMP_DIR = previousRinTmpDir;
    if (previousTmpDir == null) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  }
});

test("syncInstalledDocs copies upstream mirrors into installed doc locations", async () => {
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

test("publishInstalledRuntime no longer requires vendored pi-coding-agent sources", async () => {
  const tempRoot = await fs.mkdtemp(path.join(tempBaseDir, "rin-install-src-"));
  const installDir = await fs.mkdtemp(
    path.join(tempBaseDir, "rin-install-dst-"),
  );

  await fs.mkdir(path.join(tempRoot, "dist", "app", "rin"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(tempRoot, "dist", "app", "rin", "main.js"),
    "export {};",
    "utf8",
  );
  await fs.writeFile(path.join(tempRoot, "package.json"), "{\n}\n", "utf8");
  await fs.symlink(
    path.join(rootDir, "node_modules"),
    path.join(tempRoot, "node_modules"),
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
