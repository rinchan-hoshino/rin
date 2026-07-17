import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

await import("../support/register-update-workflow-owner-fixture.ts");
const rootDir = path.resolve(".");
const workflow = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "update-workflow.js"),
  ).href
);
const releaseHelpers = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "release.js"))
    .href
);
const ownerGlobal = globalThis as any;
const scenario = ownerGlobal.__rinUpdateWorkflowScenario as Record<string, any>;
const events = ownerGlobal.__rinUpdateWorkflowEvents as any[];

function i18n() {
  return {
    fetchingUpdateSourceMessage: "fetch source",
    preparingUpdateSourceMessage: "prepare source",
    installingUpdateDependenciesMessage: "install dependencies",
    buildingUpdateRuntimeMessage: "build runtime",
    pruningUpdateDependenciesMessage: "prune dependencies",
    buildUpdateCommandFailureHeader: (label: string) => `FAILED ${label}`,
  };
}

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-owner-"));
  events.length = 0;
  scenario.hideDownloadTools = false;
  try {
    await run(root);
  } finally {
    scenario.hideDownloadTools = false;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function release(overrides: Record<string, any> = {}) {
  return {
    channel: "stable",
    archiveUrl: "https://example.invalid/rin.tar.gz",
    version: "1.2.3",
    branch: "stable",
    ref: "stable-v1.2.3",
    sourceLabel: "stable 1.2.3",
    ...overrides,
  };
}

function sha256(filePath: string) {
  return createHash("sha256")
    .update(fsSync.readFileSync(filePath))
    .digest("hex");
}

function createTar(
  sourceParent: string,
  sourceName: string,
  archivePath: string,
) {
  execFileSync("tar", ["-czf", archivePath, "-C", sourceParent, sourceName]);
}

function createZip(sourceRoot: string, archivePath: string) {
  const script = String.raw`
import os, sys, zipfile
source, output = sys.argv[1], sys.argv[2]
base = os.path.basename(source)
with zipfile.ZipFile(output, "w") as archive:
    for current, _, files in os.walk(source):
        for name in files:
            full = os.path.join(current, name)
            archive.write(full, os.path.join(base, os.path.relpath(full, source)))
`;
  execFileSync("python3", ["-c", script, sourceRoot, archivePath]);
}

async function createSourcePackage(
  parent: string,
  name: string,
  options: { lock?: boolean; prepare?: boolean } = {},
) {
  const source = path.join(parent, name);
  await fs.mkdir(source, { recursive: true });
  const scripts: Record<string, string> = {
    build: "node -e \"require('fs').writeFileSync('built.txt','built')\"",
  };
  if (options.prepare) {
    scripts.prepare =
      "node -e \"require('fs').writeFileSync('prepare-ran.txt','bad')\"";
  }
  const packageJson = {
    name: `owner-${name}`,
    version: "1.0.0",
    private: true,
    scripts,
  };
  await fs.writeFile(
    path.join(source, "package.json"),
    JSON.stringify(packageJson),
  );
  await fs.writeFile(path.join(source, "payload.txt"), name);
  if (options.lock) {
    await fs.writeFile(
      path.join(source, "package-lock.json"),
      JSON.stringify({
        name: packageJson.name,
        version: packageJson.version,
        lockfileVersion: 3,
        requires: true,
        packages: { "": packageJson },
      }),
    );
  }
  return source;
}

test("update commands preserve exit, signal, logging, and listener behavior", async () => {
  const before = Object.fromEntries(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
      signal,
      process.listenerCount(signal),
    ]),
  );
  await workflow.runUpdateCommand(
    process.execPath,
    ["-e", "process.stdout.write('owner command')"],
    { stdio: "ignore" },
  );
  await assert.rejects(
    workflow.runUpdateCommand(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    }),
    (error: any) => {
      assert.equal(error.message, "rin_update_command_failed:7");
      assert.equal(error.status, 7);
      return true;
    },
  );
  await assert.rejects(
    workflow.runUpdateCommand("/missing/owner-command", []),
    /ENOENT/,
  );

  const originalExit = process.exit;
  (process as any).exit = (code: number) => {
    throw new Error(`owner-exit:${code}`);
  };
  try {
    for (const [signal, exitCode] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      await assert.rejects(
        workflow.runUpdateCommand(
          process.execPath,
          ["-e", `process.kill(process.pid, '${signal}')`],
          { stdio: "ignore" },
        ),
        new RegExp(`owner-exit:${exitCode}`),
      );
    }
    const forwarded = workflow.runUpdateCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { stdio: "ignore" },
    );
    setTimeout(() => process.emit("SIGHUP"), 20);
    await assert.rejects(forwarded, /owner-exit:129/);
  } finally {
    (process as any).exit = originalExit;
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(process.listenerCount(signal), before[signal]);
  }

  await withTempRoot(async (root) => {
    const logFile = path.join(root, "update.log");
    await fs.writeFile(logFile, "");
    const ttyDescriptor = Object.getOwnPropertyDescriptor(
      process.stderr,
      "isTTY",
    );
    const originalWrite = process.stderr.write;
    let diagnostic = "";
    Object.defineProperty(process.stderr, "isTTY", {
      configurable: true,
      value: true,
    });
    (process.stderr as any).write = (chunk: unknown) => {
      diagnostic += String(chunk);
      return true;
    };
    try {
      await workflow.runLoggedUpdateCommandSync(
        process.execPath,
        ["-e", "process.stdout.write('owner log')"],
        "owner success",
        logFile,
      );
      await assert.rejects(
        workflow.runLoggedUpdateCommandSync(
          process.execPath,
          ["-e", "process.stderr.write('owner failure');process.exit(4)"],
          "owner failure",
          logFile,
          {},
          (label: string) => `CUSTOM ${label}`,
        ),
        /rin_update_command_failed:4/,
      );
      await assert.rejects(
        workflow.runLoggedUpdateCommandSync(
          process.execPath,
          ["-e", "process.stderr.write('default failure');process.exit(5)"],
          "default header",
          logFile,
        ),
        /rin_update_command_failed:5/,
      );
    } finally {
      (process.stderr as any).write = originalWrite;
      if (ttyDescriptor)
        Object.defineProperty(process.stderr, "isTTY", ttyDescriptor);
    }
    const log = await fs.readFile(logFile, "utf8");
    assert.match(log, /\$ .*node .*owner log/);
    assert.match(log, /owner failure/);
    assert.match(diagnostic, /CUSTOM owner failure/);
    assert.match(diagnostic, /default header failed; recent log:/);

    Object.defineProperty(process.stderr, "isTTY", {
      configurable: true,
      value: false,
    });
    try {
      await workflow.runLoggedUpdateCommandSync(
        process.execPath,
        ["-e", ""],
        "non tty",
        logFile,
        { stdio: "ignore" },
      );
    } finally {
      if (ttyDescriptor)
        Object.defineProperty(process.stderr, "isTTY", ttyDescriptor);
    }
  });
});

test("update release and workspace helpers retain concrete identity and bounded cleanup", async () => {
  await withTempRoot(async (root) => {
    const oldCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    try {
      assert.equal(
        workflow.updateWorkRoot(),
        path.join(root, "cache", "rin-update"),
      );
    } finally {
      if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = oldCache;
    }

    const explicit = path.join(root, "owner-tool");
    await fs.writeFile(explicit, "owner");
    assert.equal(workflow.requireTool("ignored", ["", explicit]), explicit);
    assert.match(workflow.requireTool("git"), /git$/);
    assert.throws(
      () => workflow.requireTool("rin-owner-tool-that-does-not-exist"),
      /rin_missing_required_tool:/,
    );

    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "owner", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "user.email",
      "owner@example.invalid",
    ]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Owner Fixture"]);
    await fs.writeFile(path.join(repo, "README.md"), "owner\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "owner"]);
    const hash = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const resolved = workflow.resolveGitCommitForRelease(
      repo,
      release({ channel: "git", branch: "owner", ref: "refs/heads/owner" }),
    );
    assert.equal(resolved.ref, hash);
    assert.equal(resolved.version, hash.slice(0, 12));
    assert.match(resolved.archiveUrl, new RegExp(hash));
    const pinned = release({ channel: "git", ref: hash });
    assert.equal(workflow.resolveGitCommitForRelease(repo, pinned), pinned);
    const stable = release();
    assert.equal(workflow.resolveGitCommitForRelease(repo, stable), stable);
    const unresolved = release({ channel: "git", ref: "missing-owner-ref" });
    assert.equal(
      workflow.resolveGitCommitForRelease(repo, unresolved),
      unresolved,
    );

    const workRoot = path.join(root, "work");
    await fs.mkdir(workRoot);
    const stale = path.join(workRoot, "work-stale");
    const kept = path.join(workRoot, "work-kept");
    const fresh = path.join(workRoot, "work-fresh");
    const unrelated = path.join(workRoot, "other");
    for (const dir of [stale, kept, fresh, unrelated]) await fs.mkdir(dir);
    const old = new Date(1_000);
    await fs.utimes(stale, old, old);
    await fs.utimes(kept, old, old);
    const removed = workflow.cleanupStaleUpdateWorkDirs(workRoot, {
      keepPaths: [kept],
      nowMs: 20_000,
      staleAfterMs: 5_000,
    });
    assert.deepEqual(removed, [stale]);
    await fs.access(kept);
    await fs.access(fresh);
    await fs.access(unrelated);
    assert.deepEqual(
      workflow.cleanupStaleUpdateWorkDirs(path.join(root, "missing")),
      [],
    );

    const workspace = workflow.createUpdateRuntimeSourceWorkspace(
      stable,
      workRoot,
    );
    assert.equal((await fs.stat(workspace.releaseFile)).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(await fs.readFile(workspace.releaseFile, "utf8")),
      stable,
    );
    await fs.access(workspace.tmpDir);
    await fs.access(workspace.sourceRoot);
  });
});

test("prepared runtime and release comparisons preserve channel semantics", async () => {
  await withTempRoot(async (root) => {
    assert.throws(
      () => workflow.preparedRuntimeNodeExecutable(root),
      /rin_managed_node_runtime_missing/,
    );
    const copied = workflow.provisionPreparedCurrentNodeRuntime(root);
    assert.equal(workflow.preparedRuntimeNodeExecutable(root), copied);
    assert.deepEqual(
      await fs.readFile(copied),
      await fs.readFile(process.execPath),
    );
    assert.equal(workflow.provisionPreparedCurrentNodeRuntime(root), copied);

    const execPathDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "execPath",
    );
    const missingRuntime = path.join(root, "missing-runtime");
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: "",
    });
    try {
      assert.throws(
        () => workflow.provisionPreparedCurrentNodeRuntime(missingRuntime),
        /rin_managed_node_runtime_missing/,
      );
    } finally {
      if (execPathDescriptor)
        Object.defineProperty(process, "execPath", execPathDescriptor);
    }

    assert.equal(workflow.isInstalledReleaseCurrent({}, release()), false);
    assert.equal(
      workflow.isInstalledReleaseCurrent(
        { channel: "stable", version: "1.2.3" },
        release(),
      ),
      true,
    );
    assert.equal(
      workflow.isInstalledReleaseCurrent(
        { channel: "git", ref: "abc" },
        release({ channel: "git", ref: "abc" }),
      ),
      true,
    );
    assert.equal(
      workflow.isInstalledReleaseCurrent(
        { channel: "beta", version: "2", ref: "same" },
        release({ channel: "beta", version: "2", ref: "same" }),
      ),
      true,
    );
    assert.equal(
      workflow.isInstalledReleaseCurrent(
        { channel: "beta", version: "2", ref: "old" },
        release({ channel: "beta", version: "2", ref: "new" }),
      ),
      false,
    );
  });
});

test("platform bundles verify checksums and extract zip or tar without package commands", async () => {
  await withTempRoot(async (root) => {
    const platformKey = releaseHelpers.releasePlatformKey();
    const workRoot = path.join(root, "work");
    await fs.mkdir(workRoot);
    const bundle = await createSourcePackage(root, "bundle");
    const runtimeNode = path.join(
      bundle,
      "runtime",
      "node",
      "current",
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
    await fs.mkdir(path.dirname(runtimeNode), { recursive: true });
    await fs.writeFile(runtimeNode, "#!/bin/sh\n", { mode: 0o755 });

    const zip = path.join(root, "bundle.zip");
    createZip(bundle, zip);
    const toolDir = path.join(root, "tools");
    const fakeUnzip = path.join(toolDir, "unzip");
    await fs.mkdir(toolDir);
    const fakeUnzipSource =
      '#!/bin/sh\nset -eu\ndest="$4"\nmkdir -p "$dest/bundle"\ncp -R "$RIN_TEST_BUNDLE"/. "$dest/bundle/"\n';
    await fs.writeFile(fakeUnzip, fakeUnzipSource, { mode: 0o755 });
    let sandboxSystemUnzip: string | undefined;
    if (
      !fsSync.existsSync("/usr/bin/unzip") &&
      !fsSync.existsSync("/bin/unzip")
    ) {
      for (const candidate of ["/usr/bin/unzip", "/bin/unzip"]) {
        try {
          await fs.writeFile(candidate, fakeUnzipSource, { mode: 0o755 });
          sandboxSystemUnzip = candidate;
          break;
        } catch {}
      }
    }
    const originalPath = process.env.PATH;
    const originalBundle = process.env.RIN_TEST_BUNDLE;
    const shellProfile = path.join(process.env.HOME || root, ".profile");
    let originalShellProfile: string | undefined;
    try {
      originalShellProfile = await fs.readFile(shellProfile, "utf8");
    } catch {}
    await fs.mkdir(path.dirname(shellProfile), { recursive: true });
    await fs.writeFile(
      shellProfile,
      `${originalShellProfile || ""}\nexport PATH=${JSON.stringify(toolDir)}:$PATH\n`,
    );
    process.env.PATH = `${toolDir}${path.delimiter}${originalPath || ""}`;
    process.env.RIN_TEST_BUNDLE = bundle;
    scenario.hideDownloadTools = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(await fs.readFile(zip), { status: 200 });
    try {
      const zipRelease = release({
        assets: {
          [platformKey]: {
            bundleUrl: "https://owner.invalid/bundle.zip",
            sha256: sha256(zip),
          },
        },
      });
      const workspace = workflow.createUpdateRuntimeSourceWorkspace(
        zipRelease,
        workRoot,
      );
      await workflow.prepareUpdateRuntimeSource({
        release: zipRelease,
        workspace,
        i18n: i18n(),
      });
      assert.equal(
        await fs.readFile(
          path.join(workspace.sourceRoot, "payload.txt"),
          "utf8",
        ),
        "bundle",
      );
      assert.equal(workspace.archivePath.endsWith("rin.zip"), true);
      assert.doesNotMatch(await fs.readFile(workspace.logFile, "utf8"), /npm /);
    } finally {
      globalThis.fetch = originalFetch;
      scenario.hideDownloadTools = false;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalBundle === undefined) delete process.env.RIN_TEST_BUNDLE;
      else process.env.RIN_TEST_BUNDLE = originalBundle;
      if (sandboxSystemUnzip) await fs.rm(sandboxSystemUnzip, { force: true });
      if (originalShellProfile === undefined) {
        await fs.rm(shellProfile, { force: true });
      } else {
        await fs.writeFile(shellProfile, originalShellProfile);
      }
    }

    scenario.hideDownloadTools = true;
    const originalFetchForFailure = globalThis.fetch;
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    const failedDownloadRelease = release({
      assets: {
        [platformKey]: {
          bundleUrl: "https://owner.invalid/unavailable.zip",
          sha256: "0".repeat(64),
        },
      },
    });
    try {
      await assert.rejects(
        workflow.prepareUpdateRuntimeSource({
          release: failedDownloadRelease,
          workspace: workflow.createUpdateRuntimeSourceWorkspace(
            failedDownloadRelease,
            workRoot,
          ),
          i18n: i18n(),
        }),
        /rin_download_failed:503/,
      );
    } finally {
      globalThis.fetch = originalFetchForFailure;
      scenario.hideDownloadTools = false;
    }

    const missingChecksumRelease = release({
      assets: { [platformKey]: { bundleUrl: pathToFileURL(zip).href } },
    });
    await assert.rejects(
      workflow.prepareUpdateRuntimeSource({
        release: missingChecksumRelease,
        workspace: workflow.createUpdateRuntimeSourceWorkspace(
          missingChecksumRelease,
          workRoot,
        ),
        i18n: i18n(),
      }),
      /rin_update_platform_bundle_checksum_missing/,
    );
    const mismatchRelease = release({
      assets: {
        [platformKey]: {
          bundleUrl: pathToFileURL(zip).href,
          sha256: "0".repeat(64),
        },
      },
    });
    await assert.rejects(
      workflow.prepareUpdateRuntimeSource({
        release: mismatchRelease,
        workspace: workflow.createUpdateRuntimeSourceWorkspace(
          mismatchRelease,
          workRoot,
        ),
        i18n: i18n(),
      }),
      /rin_update_platform_bundle_checksum_mismatch/,
    );

    const tar = path.join(root, "bundle.tar.gz");
    createTar(root, path.basename(bundle), tar);
    const tarRelease = release({
      assets: {
        [platformKey]: {
          bundleUrl: pathToFileURL(tar).href,
          sha256: sha256(tar),
        },
      },
    });
    const tarWorkspace = workflow.createUpdateRuntimeSourceWorkspace(
      tarRelease,
      workRoot,
    );
    await workflow.prepareUpdateRuntimeSource({
      release: tarRelease,
      workspace: tarWorkspace,
      i18n: i18n(),
    });
    assert.equal(
      await fs.readFile(
        path.join(tarWorkspace.sourceRoot, "payload.txt"),
        "utf8",
      ),
      "bundle",
    );
  });
});

test("source preparation runs stable, locked git, and unlocked prerelease workflows offline", async () => {
  await withTempRoot(async (root) => {
    const workRoot = path.join(root, "work");
    await fs.mkdir(workRoot);
    for (const [name, channel, lock, prepare] of [
      ["stable", "stable", false, true],
      ["locked", "git", true, false],
      ["unlocked", "beta", false, false],
    ] as const) {
      const source = await createSourcePackage(root, name, { lock, prepare });
      const archive = path.join(root, `${name}.tar.gz`);
      createTar(root, path.basename(source), archive);
      const selected = release({
        channel,
        archiveUrl: pathToFileURL(archive).href,
        version: `${name}-1`,
        ref: `${name}-ref`,
      });
      const workspace = workflow.createUpdateRuntimeSourceWorkspace(
        selected,
        workRoot,
      );
      await workflow.prepareUpdateRuntimeSource({
        release: selected,
        workspace,
        i18n: i18n(),
        env: { ...process.env, OWNER_BUILD_ENV: name },
      });
      assert.equal(
        workflow.preparedRuntimeNodeExecutable(workspace.sourceRoot).length > 0,
        true,
      );
      const packageJson = JSON.parse(
        await fs.readFile(
          path.join(workspace.sourceRoot, "package.json"),
          "utf8",
        ),
      );
      if (channel === "stable") {
        assert.equal(packageJson.scripts.prepare, undefined);
        await assert.rejects(
          fs.access(path.join(workspace.sourceRoot, "prepare-ran.txt")),
          /ENOENT/,
        );
      } else {
        await fs.access(path.join(workspace.sourceRoot, "built.txt"));
      }
    }
  });
});
