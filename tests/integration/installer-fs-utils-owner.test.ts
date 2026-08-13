import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

await import("../support/register-fs-utils-owner-fixture.ts");
const fsUtils = await import(
  pathToFileURL(path.resolve("dist/core/rin-install/fs-utils.js")).href
);
const ownerGlobal = globalThis as any;
const events = ownerGlobal.__rinFsUtilsOwnerEvents as any[];
const scenario = ownerGlobal.__rinFsUtilsOwnerScenario as Record<string, any>;

function reset() {
  events.length = 0;
  for (const key of Object.keys(scenario)) delete scenario[key];
  scenario.privilegeCommand = "/owner/sudo";
}

async function sandbox(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-fs-owner-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function write(filePath: string, value = "owner") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value);
  return filePath;
}

function user(name = "owner") {
  return { name, uid: 1000, gid: 1001, home: `/home/${name}` };
}

test("installer JSON and text helpers preserve fallback, privilege, modes, and exports", async () => {
  reset();
  await sandbox(async (root) => {
    const jsonPath = await write(path.join(root, "value.json"), '{"ok":true}');
    assert.deepEqual(fsUtils.readInstallerJson(jsonPath, {}), { ok: true });
    assert.deepEqual(
      fsUtils.readInstallerJson(path.join(root, "missing"), { fallback: true }),
      { fallback: true },
    );

    scenario.exec = () => '{"privileged":true}';
    assert.deepEqual(fsUtils.readJsonFileWithPrivilege("/owner/value"), {
      privileged: true,
    });
    scenario.exec = () => {
      throw new Error("denied");
    };
    assert.throws(
      () => fsUtils.readJsonFileWithPrivilege("/owner/value"),
      /denied/,
    );

    scenario.readFileSync = () => {
      throw Object.assign(new Error("permission"), { code: "EACCES" });
    };
    assert.throws(
      () => fsUtils.readInstallerJson("/owner/locked", {}, false),
      /permission/,
    );
    scenario.exec = () => '{"elevated":true}';
    assert.deepEqual(fsUtils.readInstallerJson("/owner/locked", {}, true), {
      elevated: true,
    });
    scenario.readFileSync = () => {
      throw Object.assign(new Error("permission"), { code: "EPERM" });
    };
    assert.deepEqual(fsUtils.readInstallerJson("/owner/locked", {}, true), {
      elevated: true,
    });
    delete scenario.readFileSync;

    const textPath = path.join(root, "nested", "secret.txt");
    fsUtils.writeTextFile(textPath, "secret", 0o640);
    assert.equal(await fs.readFile(textPath, "utf8"), "secret");
    assert.equal((await fs.stat(textPath)).mode & 0o777, 0o640);
    const executable = path.join(root, "bin", "owner");
    fsUtils.writeExecutable(executable, "#!/bin/sh\n");
    assert.equal((await fs.stat(executable)).mode & 0o777, 0o755);
    assert.equal(typeof fsUtils.ensureDir, "function");
    assert.equal(typeof fsUtils.readJsonFile, "function");
    assert.equal(typeof fsUtils.writeJsonFile, "function");
  });
});

test("runtime node and launcher contracts select managed executables on Unix and Windows", async () => {
  reset();
  await sandbox(async (root) => {
    assert.match(
      fsUtils.installedRuntimePathValue("/home/owner", ["/owner/bin"]),
      /^\/owner\/bin:/,
    );
    assert.match(fsUtils.installedRuntimePathValue(), /\/usr\/bin/);
    assert.deepEqual(fsUtils.installedRuntimeNodePathDirs(), []);
    assert.deepEqual(fsUtils.installedRuntimeNodePathDirs("win32"), []);
    assert.deepEqual(
      fsUtils.installedRuntimeNodePathDirs({ installDir: root }),
      [],
    );
    assert.throws(
      () => fsUtils.installedRuntimeNodeCommandArgs(),
      /missing:install_dir/,
    );
    assert.throws(
      () => fsUtils.installedRuntimeNodeCommandArgs("win32"),
      /missing:install_dir/,
    );
    assert.throws(
      () => fsUtils.windowsCmdLauncherScript(["owner"]),
      /missing:install_dir/,
    );

    const unixNode = await write(
      path.join(root, "runtime", "node", "current", "bin", "node"),
    );
    const windowsNode = await write(
      path.join(root, "runtime", "node", "current", "node.exe"),
    );
    assert.deepEqual(
      fsUtils.installedRuntimeNodePathDirs({
        installDir: root,
        platform: "linux",
      }),
      [path.dirname(unixNode)],
    );
    assert.deepEqual(
      fsUtils.installedRuntimeNodeCommandArgs({
        installDir: root,
        platform: "win32",
      }),
      [windowsNode],
    );

    const unixScript = fsUtils.launcherScript(
      ["/missing", "/owner/main.js"],
      [unixNode, "--flag"],
    );
    assert.match(unixScript, /if \[ -f '\/owner\/main.js' \]/);
    assert.match(unixScript, /installed runtime entry not found/);
    const windowsScript = fsUtils.windowsCmdLauncherScript(
      ["C:\\owner\\main.js"],
      ["fixed"],
      {
        nodeCommandArgs: [windowsNode],
        detached: true,
        missingMessage: "owner missing",
      },
    );
    assert.match(windowsScript, /start ""/);
    assert.match(windowsScript, /"fixed" %\*/);
    assert.match(windowsScript, /owner missing/);
    assert.doesNotMatch(
      fsUtils.windowsCmdLauncherScript(["C:\\owner\\main.js"], [], {
        nodeCommandArgs: [windowsNode],
      }),
      /start ""/,
    );

    const targets = fsUtils.launcherTargetsForInstallDir(root);
    assert.match(targets.rin[0], /dist[\\/]app[\\/]rin[\\/]main\.js/);
    assert.match(targets.rinInstall[0], /rin-install/);
    assert.equal(
      fsUtils.currentRuntimeLinkTypeForPlatform("win32"),
      "junction",
    );
    assert.equal(fsUtils.currentRuntimeLinkTypeForPlatform("linux"), "dir");
    assert.equal(fsUtils.currentRuntimeLinkTypeForPlatform(), "dir");
    assert.equal(fsUtils.releaseIdNow(), "20260718-010203");
    assert.equal(fsUtils.installerTempRootCandidates().length > 0, true);
  });
});

test("Windows PATH and launcher writers handle updates, deduplication, skips, and elevated ownership", async () => {
  reset();
  const launcherDir = "C:\\Users\\Owner\\.local\\bin";
  assert.equal(fsUtils.pathValueIncludesDirectory("", ""), true);
  assert.equal(
    fsUtils.pathValueIncludesDirectory(
      `C:\\Windows;${launcherDir.toUpperCase()}`,
      launcherDir,
      ";",
    ),
    true,
  );
  assert.equal(
    fsUtils.pathValueIncludesDirectory("C:\\Windows", launcherDir, ";"),
    false,
  );
  assert.equal(
    fsUtils.buildPathValueWithDirectory(" C:\\Windows ;; ", launcherDir, ";"),
    `${launcherDir};C:\\Windows`,
  );
  assert.equal(fsUtils.buildPathValueWithDirectory("owner", "", ";"), "owner");

  assert.deepEqual(
    fsUtils.ensureWindowsUserPathIncludes("", { platform: "win32" }),
    {
      updated: false,
      skipped: true,
      launcherDir: "",
    },
  );
  assert.equal(
    fsUtils.ensureWindowsUserPathIncludes(launcherDir, { platform: "linux" })
      .skipped,
    true,
  );
  let written = "";
  const updated = fsUtils.ensureWindowsUserPathIncludes(launcherDir, {
    platform: "win32",
    readUserPath: () => "C:\\Windows",
    writeUserPath: (value: string) => {
      written = value;
    },
  });
  assert.equal(updated.updated, true);
  assert.equal(written, `${launcherDir};C:\\Windows`);
  assert.equal(
    fsUtils.ensureWindowsUserPathIncludes(launcherDir, {
      platform: "win32",
      readUserPath: () => launcherDir,
    }).updated,
    false,
  );
  assert.match(
    fsUtils.ensureWindowsUserPathIncludes(launcherDir, {
      platform: "win32",
      readUserPath: () => {
        throw new Error("path failed");
      },
    }).error,
    /path failed/,
  );

  await sandbox(async (root) => {
    const installDir = path.join(root, "install");
    const home = path.join(root, "home");
    await write(
      path.join(installDir, "runtime", "node", "current", "bin", "node"),
    );
    const unix = fsUtils.writeLaunchersForUser("owner", installDir, () => home);
    assert.match(await fs.readFile(unix.rinPath, "utf8"), /exec/);
    assert.equal(unix.windowsPathUpdate.skipped, true);

    await write(
      path.join(installDir, "runtime", "node", "current", "node.exe"),
    );
    const windows = fsUtils.writeLaunchersForUser(
      "owner",
      installDir,
      () => home,
      { platform: "win32" },
    );
    assert.match(await fs.readFile(windows.rinPath, "utf8"), /@echo off/);

    scenario.exec = () => Buffer.from("");
    const elevatedHome = path.join(root, "elevated-home");
    const elevated = fsUtils.writeLaunchersForUser(
      "owner",
      installDir,
      () => elevatedHome,
      {
        elevated: true,
        platform: "linux",
        findSystemUser: () => user(),
      },
    );
    assert.match(elevated.rinPath, /elevated-home/);
    assert.equal(
      events.some(
        ([name, , args]) => name === "exec" && args?.includes("install"),
      ),
      true,
    );
  });
});

test("user command and privileged write contracts quote environments and select executors", async () => {
  reset();
  assert.deepEqual(
    fsUtils.commandAsUserInvocation(
      "owner",
      "node",
      ["a'b"],
      { OWNER: "hello world" },
      {
        isRoot: true,
        hasRunuser: true,
      },
    ),
    {
      command: "/usr/sbin/runuser",
      args: [
        "-u",
        "owner",
        "--",
        "sh",
        "-lc",
        "OWNER='hello world' 'node' 'a'\"'\"'b'",
      ],
    },
  );
  for (const privilegeCommand of ["/usr/bin/sudo", "/usr/bin/doas"]) {
    assert.deepEqual(
      fsUtils
        .commandAsUserInvocation(
          "owner",
          "node",
          [],
          {},
          {
            isRoot: false,
            hasRunuser: false,
            privilegeCommand,
          },
        )
        .args.slice(0, 2),
      ["-u", "owner"],
    );
  }
  assert.deepEqual(
    fsUtils.commandAsUserInvocation(
      "owner",
      "node",
      [],
      {},
      {
        isRoot: false,
        hasRunuser: false,
        privilegeCommand: "/owner/pkexec",
      },
    ).args,
    ["sh", "-lc", "'node'"],
  );

  scenario.exec = (_command: string, _args: string[], options: any) =>
    options?.encoding ? "captured" : Buffer.from("");
  fsUtils.runPrivileged("install", ["owner"]);
  fsUtils.runCommandAsUser("owner", "node", ["--version"]);
  assert.equal(
    fsUtils.captureCommandAsUser("owner", "node", ["--version"]),
    "captured",
  );

  await sandbox(async (root) => {
    scenario.exec = () => Buffer.from("");
    fsUtils.writeTextFileWithPrivilege(
      path.join(root, "target", "value"),
      "owner",
      "owner",
      1001,
      0o640,
    );
    fsUtils.writeTextFileWithPrivilege(
      path.join(root, "target", "nogroup"),
      "owner",
      "owner",
      "",
      0o600,
    );
    fsUtils.writeJsonFileWithPrivilege(
      path.join(root, "target", "value.json"),
      { ok: true },
    );
    assert.equal(
      events.some(
        ([name, , args]) => name === "exec" && args?.includes("chown"),
      ),
      true,
    );
  });
});

test("tree and documentation synchronization replace stale state and model elevated ownership", async () => {
  reset();
  await sandbox(async (root) => {
    const source = path.join(root, "source");
    const dest = path.join(root, "dest");
    await write(path.join(source, "nested", "new.txt"), "new");
    await write(path.join(source, "link-target"), "target");
    await fs.symlink("link-target", path.join(source, "link"));
    await write(path.join(dest, "old.txt"), "old");
    fsUtils.syncTree(source, dest);
    assert.equal(
      await fs.readFile(path.join(dest, "nested", "new.txt"), "utf8"),
      "new",
    );
    await assert.rejects(fs.access(path.join(dest, "old.txt")));
    assert.equal(await fs.readlink(path.join(dest, "link")), "link-target");

    assert.equal(
      fsUtils.syncInstalledDocTree(
        path.join(root, "missing"),
        dest,
        "owner",
        false,
        { findSystemUser: () => user() },
      ),
      null,
    );
    const copied = fsUtils.syncInstalledDocTree(
      source,
      path.join(root, "docs"),
      "owner",
      false,
      { findSystemUser: () => user() },
    );
    assert.equal(copied, path.join(root, "docs"));

    scenario.exec = () => Buffer.from("");
    assert.equal(
      fsUtils.syncInstalledDocTree(source, "/owner/docs", "owner", true, {
        findSystemUser: () => user(),
      }),
      "/owner/docs",
    );
    assert.equal(
      events.some(([name, , args]) => name === "exec" && args?.includes("cp")),
      true,
    );
  });
});

test("managed-file manifests and documentation publishing include only existing owned trees", async () => {
  reset();
  await sandbox(async (root) => {
    await write(path.join(root, "docs", "agent", "README.md"));
    await write(path.join(root, "docs", "release", "CHANGELOG.md"));
    await write(path.join(root, "upstream", "skill-creator", "SKILL.md"));
    await write(path.join(root, "upstream", "pi", "README.md"));
    await write(path.join(root, "upstream", "pi", "docs", "guide.md"));
    await write(path.join(root, "single.txt"));
    const manifest = fsUtils.buildInstalledManagedFilesManifest(root);
    assert.deepEqual(manifest.trees["docs/rin"], [
      "README.md",
      "builtin-skills/skill-creator/SKILL.md",
    ]);
    assert.deepEqual(manifest.trees["docs/release"], ["CHANGELOG.md"]);
    assert.deepEqual(manifest.trees["docs/pi"], ["README.md", "docs/guide.md"]);
    assert.deepEqual(
      fsUtils.buildInstalledManagedFilesManifest(path.join(root, "empty")),
      { trees: {} },
    );

    const installDir = path.join(root, "install");
    const installed = fsUtils.syncInstalledDocs(
      root,
      installDir,
      "owner",
      false,
      { findSystemUser: () => user() },
    );
    assert.equal(installed.rin?.endsWith(path.join("docs", "rin")), true);
    assert.equal(
      installed.release?.endsWith(path.join("docs", "release")),
      true,
    );
    assert.equal(installed.pi.length, 2);
    assert.equal(
      await fs.readFile(
        path.join(
          installDir,
          "docs",
          "rin",
          "builtin-skills",
          "skill-creator",
          "SKILL.md",
        ),
        "utf8",
      ),
      "owner",
    );
  });
});

test("release identity sanitizes stable, git, package, repository, and unknown sources", async () => {
  reset();
  await sandbox(async (root) => {
    await write(
      path.join(root, "package.json"),
      JSON.stringify({ version: "2.3.4" }),
    );
    assert.equal(
      fsUtils.installedRuntimeReleaseId(root, {
        channel: "stable",
        version: "1.2.3",
      }),
      "1.2.3",
    );
    assert.equal(
      fsUtils.installedRuntimeReleaseId(root, {
        channel: "git",
        version: "0123456789abcdef",
      }),
      "0123456789ab",
    );
    assert.equal(
      fsUtils.installedRuntimeReleaseId(root, {
        channel: "git",
        version: "main",
        ref: "abcdef0123456789",
      }),
      "abcdef012345",
    );
    assert.equal(fsUtils.installedRuntimeReleaseId(root), "2.3.4");
    await fs.writeFile(path.join(root, "package.json"), "{");
    assert.equal(
      fsUtils.installedRuntimeReleaseId(root, {
        channel: "stable",
        version: "owner release!",
      }),
      "owner-release",
    );
  });
  assert.equal(
    fsUtils.installedRuntimeReleaseId("/definitely/missing"),
    "unknown",
  );
});

async function seedReleases(
  installDir: string,
  names: string[],
  current?: string,
) {
  const releases = path.join(installDir, "app", "releases");
  for (const [index, name] of names.entries()) {
    const dir = path.join(releases, name);
    await write(path.join(dir, "package.json"), "{}");
    const time = new Date(1_700_000_000_000 + index * 1000);
    await fs.utimes(dir, time, time);
  }
  if (current) {
    await fs.mkdir(path.join(installDir, "app"), { recursive: true });
    await fs.symlink(
      path.join(releases, current),
      path.join(installDir, "app", "current"),
      "dir",
    );
  }
  return releases;
}

test("managed Node publication copies bundled, existing, current, and elevated executables", async () => {
  reset();
  await sandbox(async (root) => {
    const source = path.join(root, "source");
    const install = path.join(root, "install");
    const bundled = fsUtils.publishManagedNodeRuntime(
      source,
      install,
      "owner",
      false,
      { findSystemUser: () => user() },
    );
    await fs.access(bundled.nodeExecutable, fsSync.constants.X_OK);

    await fs.rm(path.join(source, "runtime"), { recursive: true, force: true });
    assert.equal(
      fsUtils.publishManagedNodeRuntime(source, install, "owner", false, {
        findSystemUser: () => user(),
      }).nodeExecutable,
      bundled.nodeExecutable,
    );
    await fs.chmod(bundled.nodeExecutable, 0o644);
    const current = fsUtils.publishManagedNodeRuntime(
      source,
      install,
      "owner",
      false,
      { findSystemUser: () => user() },
    );
    assert.equal((await fs.stat(current.nodeExecutable)).mode & 0o111, 0o111);

    scenario.exec = () => Buffer.from("");
    const elevated = fsUtils.publishManagedNodeRuntime(
      source,
      "/owner/install",
      "owner",
      true,
      { findSystemUser: () => user() },
    );
    assert.equal(
      elevated.nodeExecutable.endsWith(path.join("current", "bin", "node")),
      true,
    );
  });
});

test("runtime publication and release switching preserve current-link ownership", async () => {
  reset();
  await sandbox(async (root) => {
    const source = path.join(root, "source");
    const install = path.join(root, "install");
    await write(path.join(source, "dist", "main.js"));
    await write(path.join(source, "extensions", "owner", "index.js"));
    await write(path.join(source, "node_modules", "owner", "package.json"));
    await write(
      path.join(source, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    const first = fsUtils.publishInstalledRuntime(
      source,
      install,
      "owner",
      false,
      { findSystemUser: () => user() },
    );
    assert.equal(path.basename(first.releaseRoot), "1.0.0");
    assert.equal(fsSync.realpathSync(first.currentLink), first.releaseRoot);
    assert.equal(
      events.some(([name]) => name === "prune"),
      true,
    );

    const releases = await seedReleases(install, ["2.0.0", "3.0.0"]);
    const switched = fsUtils.switchInstalledCurrentRelease(
      install,
      "2.0.0",
      "owner",
      false,
      { findSystemUser: () => user() },
    );
    assert.equal(
      fsSync.realpathSync(switched.currentLink),
      path.join(releases, "2.0.0"),
    );
    assert.throws(
      () =>
        fsUtils.switchInstalledCurrentRelease(
          install,
          "missing",
          "owner",
          false,
          { findSystemUser: () => user() },
        ),
      /rin_release_not_found/,
    );

    scenario.exec = () => Buffer.from("");
    const elevated = fsUtils.publishInstalledRuntime(
      source,
      "/owner/install",
      "owner",
      true,
      { findSystemUser: () => user() },
    );
    assert.equal(
      elevated.currentLink,
      path.join("/owner/install", "app", "current"),
    );
  });
});

test("remaining installer branches preserve defaults and failure isolation", async () => {
  reset();
  scenario.exec = () => "";
  assert.throws(() => fsUtils.readJsonFileWithPrivilege("/empty"), SyntaxError);
  scenario.readFileSync = () => {
    throw new Error("plain failure");
  };
  assert.throws(
    () => fsUtils.readInstallerJson("/plain", { plain: true }),
    /plain failure/,
  );
  delete scenario.readFileSync;
  assert.throws(
    () => fsUtils.launcherScript(["/owner"]),
    /missing:install_dir/,
  );
  assert.equal(fsUtils.pathValueIncludesDirectory("/owner", "/owner"), true);
  assert.equal(fsUtils.pathValueIncludesDirectory("", ""), true);
  assert.equal(fsUtils.buildPathValueWithDirectory("", "/owner"), "/owner");
  assert.equal(
    fsUtils.buildPathValueWithDirectory("/owner", "/owner"),
    "/owner",
  );

  const previousPath = process.env.Path;
  try {
    process.env.Path = "C:\\Windows";
    scenario.exec = (_command: string, args: string[]) =>
      args.some((value) => String(value).includes("GetEnvironmentVariable"))
        ? "C:\\Windows\n"
        : Buffer.from("");
    assert.equal(
      fsUtils.ensureWindowsUserPathIncludes("C:\\Owner", { platform: "win32" })
        .updated,
      true,
    );
  } finally {
    if (previousPath == null) delete process.env.Path;
    else process.env.Path = previousPath;
  }
  assert.equal(
    fsUtils.ensureWindowsUserPathIncludes("C:\\Owner", {
      platform: "win32",
      readUserPath: () => {
        throw "scalar failure";
      },
    }).error,
    "scalar failure",
  );
  assert.match(
    fsUtils.appConfigDirForUser("owner", () => "/home/owner"),
    /\.config|Library|AppData/,
  );
  assert.equal(
    fsUtils.launcherMetadataPathForUser("owner", () => "/home/owner"),
    "/home/owner/.config/rin/install.json",
  );
  assert.equal(
    fsUtils.commandAsUserInvocation(
      "owner",
      "node",
      [],
      {},
      {
        isRoot: false,
        hasRunuser: false,
        privilegeCommand: "/owner/sudo",
      },
    ).command,
    "/owner/sudo",
  );
  assert.deepEqual(
    fsUtils.commandAsUserInvocation(
      "owner",
      "node",
      ["--version"],
      {},
      {
        isRoot: true,
        hasRunuser: true,
      },
    ),
    {
      command: "/usr/sbin/runuser",
      args: ["-u", "owner", "--", "sh", "-lc", "'node' '--version'"],
    },
  );
  assert.equal(fsUtils.ensureWindowsUserPathIncludes("/owner").skipped, true);

  await sandbox(async (root) => {
    const install = path.join(root, "install");
    const home = path.join(root, "home");
    await write(
      path.join(install, "runtime", "node", "current", "bin", "node"),
    );
    scenario.exec = () => Buffer.from("");
    fsUtils.writeLaunchersForUser("fallback-owner", install, () => home, {
      elevated: true,
      findSystemUser: () => undefined,
    });
    fsUtils.writeLaunchersForUser("fallback-owner", install, () => home, {
      elevated: true,
    });
    fsUtils.writeTextFileWithPrivilege(
      path.join(root, "no-owner", "file"),
      "owner",
    );

    const source = path.join(root, "source");
    await write(path.join(source, "only.txt"));
    fsUtils.syncTree(source, path.join(root, "new-dest"));
    assert.equal(
      await fs.readFile(path.join(root, "new-dest", "only.txt"), "utf8"),
      "owner",
    );
    const warningDest = path.join(root, "warning-dest");
    await write(path.join(warningDest, "old.txt"));
    scenario.exec = (command: string) => {
      if (command === "rm") throw new Error("owner cleanup failure");
      return Buffer.from("");
    };
    fsUtils.syncTree(source, warningDest);
    assert.equal(
      await fs.readFile(path.join(warningDest, "only.txt"), "utf8"),
      "owner",
    );
    scenario.exec = () => Buffer.from("");
    fsUtils.syncInstalledDocTree(source, "/owner/no-user-docs", "owner", true, {
      findSystemUser: () => undefined,
    });

    const fileManifestRoot = path.join(root, "file-manifest");
    await fs.mkdir(path.join(fileManifestRoot, "docs"), { recursive: true });
    await write(path.join(fileManifestRoot, "docs", "agent"));
    assert.deepEqual(
      fsUtils.buildInstalledManagedFilesManifest(fileManifestRoot).trees[
        "docs/rin"
      ],
      ["agent"],
    );

    assert.equal(
      fsUtils.installedRuntimeReleaseId(root, {
        channel: "git",
        version: "abcdef1234567890",
        ref: "abcdef1234567890",
      }),
      "abcdef123456",
    );
    assert.equal(
      fsUtils.installedRuntimeReleaseId(root, {
        channel: "git",
        version: "1234567890abcdef",
      }),
      "1234567890ab",
    );
    await fs.writeFile(path.join(root, "package.json"), "{}");
    assert.equal(
      fsUtils.installedRuntimeReleaseId(root, { ref: "fallback-ref" }),
      "fallback-ref",
    );

    const bundledSource = path.join(root, "bundled-source");
    const elevatedNode = fsUtils.publishManagedNodeRuntime(
      bundledSource,
      "/owner/bundled-install",
      "owner",
      true,
      { findSystemUser: () => undefined },
    );
    assert.match(elevatedNode.nodeExecutable, /bundled-install/);

    const minimalRuntime = path.join(root, "minimal-runtime");
    await write(
      path.join(minimalRuntime, "package.json"),
      JSON.stringify({ version: "4.0.0" }),
    );
    const elevatedRuntime = fsUtils.publishInstalledRuntime(
      minimalRuntime,
      "/owner/minimal-install",
      "owner",
      true,
      { findSystemUser: () => undefined },
    );
    assert.match(elevatedRuntime.releaseRoot, /4\.0\.0$/);

    const elevatedList = (_command: string, args: string[]) =>
      args.includes("-e") &&
      String(args[args.indexOf("-e") + 1]).includes("readdirSync")
        ? JSON.stringify([
            { name: "a", path: "/owner/a", mtimeMs: 1 },
            { name: "b", path: "/owner/b", mtimeMs: 1 },
          ])
        : Buffer.from("");
    scenario.exec = elevatedList;
    assert.deepEqual(
      fsUtils
        .listInstalledReleaseEntries("/owner", true)
        .map((entry: any) => entry.name),
      ["a", "b"],
    );
    scenario.exec = () => JSON.stringify({ not: "an array" });
    assert.deepEqual(fsUtils.listInstalledReleaseEntries("/owner", true), []);
    scenario.exec = () => "";
    assert.deepEqual(fsUtils.listInstalledReleaseEntries("/owner", true), []);
    scenario.exec = () => JSON.stringify([{}]);
    assert.deepEqual(fsUtils.listInstalledReleaseEntries("/owner", true), [
      { name: "", path: "", mtimeMs: 0 },
    ]);

    const releases = await seedReleases(install, ["a", "b"], "a");
    await fs.utimes(path.join(releases, "a"), new Date(1), new Date(1));
    await fs.utimes(path.join(releases, "b"), new Date(1), new Date(1));
    scenario.exec = elevatedList;
    const switched = fsUtils.switchInstalledCurrentRelease(
      install,
      "b",
      "owner",
      true,
      {
        findSystemUser: () => undefined,
      },
    );
    assert.equal(switched.releaseRoot, path.join(releases, "b"));
    const pruned = fsUtils.pruneInstalledReleases(
      "/owner",
      1,
      "/owner/a",
      true,
    );
    assert.equal(pruned.removed.includes("/owner/b"), true);
  });
});

test("direct edge contracts isolate absent runtimes and privileged cleanup failures", async () => {
  reset();
  await sandbox(async (root) => {
    const missingInstall = path.join(root, "missing-runtime");
    assert.throws(
      () =>
        fsUtils.installedRuntimeNodeCommandArgs({
          installDir: missingInstall,
          platform: "linux",
        }),
      /rin_managed_node_runtime_missing:.*missing-runtime/,
    );
    assert.throws(
      () =>
        fsUtils.installedRuntimeReleaseId(path.join(root, "missing-source"), {
          channel: "git",
        }),
      /rin_git_ref_not_resolved:unknown/,
    );

    const source = path.join(root, "source");
    const install = path.join(root, "install");
    const home = path.join(root, "home");
    await fs.mkdir(source, { recursive: true });
    await write(
      path.join(install, "runtime", "node", "current", "bin", "node"),
    );
    scenario.exec = () => Buffer.from("");
    fsUtils.writeLaunchersForUser("owner", install, () => home, {
      elevated: true,
      findSystemUser: () => ({ name: "owner" }),
    });
    assert.equal(
      events.some(
        ([name, , args]) =>
          name === "exec" && args?.[0] === "chown" && args?.[1] === "owner",
      ),
      true,
    );

    events.length = 0;
    const localNode = fsUtils.publishManagedNodeRuntime(
      source,
      path.join(root, "fallback-node"),
      "owner",
      false,
      { findSystemUser: () => undefined },
    );
    assert.equal((await fs.stat(localNode.nodeExecutable)).mode & 0o111, 0o111);

    const elevatedNode = fsUtils.publishManagedNodeRuntime(
      source,
      "/owner/fallback-node",
      "owner",
      true,
      { findSystemUser: () => ({ name: "owner" }) },
    );
    assert.equal(
      elevatedNode.nodeExecutable,
      path.join(
        "/owner/fallback-node",
        "runtime",
        "node",
        "current",
        "bin",
        "node",
      ),
    );
    assert.equal(
      events.some(
        ([name, , args]) =>
          name === "exec" &&
          args?.[0] === "chown" &&
          args?.[1] === "-R" &&
          args?.[2] === "owner",
      ),
      true,
    );

    const elevatedInstall = "/owner/cleanup-install";
    scenario.exec = (_command: string, args: string[]) => {
      const operation = args[0];
      const target = String(args.at(-1) || "");
      if (
        operation === "rm" &&
        (target.endsWith("current.tmp") || target.endsWith("app/current"))
      ) {
        throw new Error("cleanup denied");
      }
      if (operation === "chown" && args.includes("-h")) {
        throw new Error("link ownership denied");
      }
      return Buffer.from("");
    };
    assert.deepEqual(
      fsUtils.publishInstalledRuntime(source, elevatedInstall, "owner", true, {
        findSystemUser: () => ({ name: "owner" }),
      }),
      {
        releaseRoot: path.join(elevatedInstall, "app", "releases", "unknown"),
        stagedReleaseRoot: undefined,
        currentLink: path.join(elevatedInstall, "app", "current"),
      },
    );

    const elevatedSwitchInstall = "/owner/cleanup-switch";
    scenario.exec = (_command: string, args: string[]) => {
      if (
        args.includes("-e") &&
        String(args[args.indexOf("-e") + 1]).includes("readdirSync")
      ) {
        return JSON.stringify([
          {
            name: "edge",
            path: path.join(elevatedSwitchInstall, "app", "releases", "edge"),
            mtimeMs: 1,
          },
        ]);
      }
      const operation = args[0];
      const target = String(args.at(-1) || "");
      if (
        operation === "rm" &&
        (target.endsWith("current.tmp") || target.endsWith("app/current"))
      ) {
        throw new Error("switch cleanup denied");
      }
      if (operation === "chown" && args.includes("-h")) {
        throw new Error("switch ownership denied");
      }
      return Buffer.from("");
    };
    assert.equal(
      fsUtils.switchInstalledCurrentRelease(
        elevatedSwitchInstall,
        "edge",
        "owner",
        true,
        { findSystemUser: () => ({ name: "owner" }) },
      ).releaseRoot,
      path.join(elevatedSwitchInstall, "app", "releases", "edge"),
    );

    scenario.exec = () => "";
    assert.equal(
      fsUtils.currentInstalledReleaseName(elevatedSwitchInstall, true),
      "",
    );

    const docsSource = path.join(root, "docs-source");
    await write(path.join(docsSource, "README.md"));
    scenario.exec = () => Buffer.from("");
    assert.equal(
      fsUtils.syncInstalledDocTree(
        docsSource,
        "/owner/docs-without-group",
        "owner",
        true,
        { findSystemUser: () => ({ name: "owner" }) },
      ),
      "/owner/docs-without-group",
    );

    const scalarWarningDest = path.join(root, "scalar-warning-dest");
    await write(path.join(scalarWarningDest, "stale.txt"));
    scenario.exec = () => {
      throw "cleanup denied";
    };
    fsUtils.syncTree(docsSource, scalarWarningDest);
    assert.equal(
      await fs.readFile(path.join(scalarWarningDest, "README.md"), "utf8"),
      "owner",
    );

    const pruneInstall = path.join(root, "prune-install");
    await seedReleases(pruneInstall, ["old", "middle", "new"]);
    const pruned = fsUtils.pruneInstalledReleases(pruneInstall, 2, "", false);
    assert.deepEqual(pruned.kept, ["new", "middle"]);
    assert.deepEqual(pruned.removed, [
      path.join(pruneInstall, "app", "releases", "old"),
    ]);
  });
});

test("release listing, current resolution, elevated readers, switching, and pruning handle malformed state", async () => {
  reset();
  assert.deepEqual(fsUtils.listInstalledReleaseEntries("/missing"), []);
  assert.deepEqual(fsUtils.listInstalledReleaseNames("/missing"), []);
  assert.equal(fsUtils.currentInstalledReleaseName("/missing"), "");

  await sandbox(async (root) => {
    const releases = await seedReleases(
      root,
      ["1.0.0", "1.1.0", "1.2.0"],
      "1.0.0",
    );
    await write(path.join(releases, "not-directory.txt"));
    assert.deepEqual(fsUtils.listInstalledReleaseNames(root).sort(), [
      "1.0.0",
      "1.1.0",
      "1.2.0",
    ]);
    assert.equal(fsUtils.currentInstalledReleaseName(root), "1.0.0");

    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.rm(path.join(root, "app", "current"));
    await fs.symlink(outside, path.join(root, "app", "current"), "dir");
    assert.equal(fsUtils.currentInstalledReleaseName(root), "");

    scenario.exec = (_command: string, args: string[]) => {
      if (
        args.includes("-e") &&
        String(args[args.indexOf("-e") + 1]).includes("readdirSync")
      ) {
        return JSON.stringify([
          { name: "elevated", path: "/owner/elevated", mtimeMs: 1 },
        ]);
      }
      if (
        args.includes("-e") &&
        String(args[args.indexOf("-e") + 1]).includes("realpathSync")
      ) {
        return path.join(root, "app", "releases", "1.1.0");
      }
      return Buffer.from("");
    };
    assert.deepEqual(fsUtils.listInstalledReleaseNames(root, true), [
      "elevated",
    ]);
    assert.equal(fsUtils.currentInstalledReleaseName(root, true), "1.1.0");

    scenario.exec = () => "not-json";
    assert.deepEqual(fsUtils.listInstalledReleaseEntries(root, true), []);
    scenario.exec = (_command: string, args: string[]) =>
      args.includes("-e") &&
      String(args[args.indexOf("-e") + 1]).includes("readdirSync")
        ? JSON.stringify([
            { name: "1.1.0", path: path.join(releases, "1.1.0"), mtimeMs: 1 },
          ])
        : Buffer.from("");
    const elevatedSwitch = fsUtils.switchInstalledCurrentRelease(
      root,
      "1.1.0",
      "owner",
      true,
      { findSystemUser: () => user() },
    );
    assert.equal(elevatedSwitch.releaseRoot, path.join(releases, "1.1.0"));

    const result = fsUtils.pruneInstalledReleases(
      root,
      0,
      path.join(releases, "1.0.0"),
      false,
    );
    assert.equal(result.keepCount, 1);
    assert.deepEqual(result.kept, ["1.0.0"]);
    assert.equal(result.removed.length, 2);
  });
});
