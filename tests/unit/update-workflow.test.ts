import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const updateWorkflow = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "update-workflow.js"),
  ).href
);
const release = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "release.js"))
    .href
);

function hasCommand(name: string) {
  try {
    return Boolean(
      execFileSync("sh", ["-lc", `command -v ${name} || true`], {
        encoding: "utf8",
      }).trim(),
    );
  } catch {
    return false;
  }
}

function testI18n() {
  return {
    fetchingUpdateSourceMessage: "Fetching update source",
    preparingUpdateSourceMessage: "Preparing update source",
    installingUpdateDependenciesMessage: "Installing update dependencies",
    buildingUpdateRuntimeMessage: "Building update runtime",
    pruningUpdateDependenciesMessage: "Pruning update dependencies",
    buildUpdateCommandFailureHeader: (label: string) => `${label} failed`,
  };
}

const unresolvedMainRelease = {
  channel: "git",
  archiveUrl: "https://example.invalid/main.tar.gz",
  version: "main",
  branch: "main",
  ref: "main",
  sourceLabel: "git branch main",
};

test("resolveGitCommitForRelease rejects an unresolved branch", () => {
  assert.throws(
    () =>
      updateWorkflow.resolveGitCommitForRelease(
        pathToFileURL(
          path.join(os.tmpdir(), "rin-nonexistent-remote-repository"),
        ).href,
        unresolvedMainRelease,
      ),
    /rin_git_ref_not_resolved:main/,
  );
});

test("resolveGitCommitForRelease rejects malformed ls-remote output", () => {
  assert.throws(
    () =>
      updateWorkflow.resolveGitCommitForRelease(
        pathToFileURL(rootDir).href,
        unresolvedMainRelease,
        {
          readRemoteRefs: () => "0123456789abcdef0123456789abcdef01234567",
        },
      ),
    /rin_git_ref_not_resolved:main/,
  );
});

test("resolveGitCommitForRelease rejects ambiguous ls-remote output", () => {
  assert.throws(
    () =>
      updateWorkflow.resolveGitCommitForRelease(
        pathToFileURL(rootDir).href,
        unresolvedMainRelease,
        {
          readRemoteRefs: () =>
            [
              "0123456789abcdef0123456789abcdef01234567\trefs/heads/main",
              "89abcdef0123456789abcdef0123456789abcdef\trefs/tags/main",
            ].join("\n"),
        },
      ),
    /rin_git_ref_not_resolved:main/,
  );
});

test("resolveGitCommitForRelease rejects an ordinary selector in another ref namespace", () => {
  assert.throws(
    () =>
      updateWorkflow.resolveGitCommitForRelease(
        pathToFileURL(rootDir).href,
        unresolvedMainRelease,
        {
          readRemoteRefs: () =>
            "0123456789abcdef0123456789abcdef01234567\trefs/pull/main",
        },
      ),
    /rin_git_ref_not_resolved:main/,
  );
});

async function writeExecutable(filePath: string, content: string) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
}

test("preparedRuntimeNodeExecutable rejects missing executable managed node", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-node-"));
  try {
    const nodePath = path.join(
      tempDir,
      "runtime",
      "node",
      "current",
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
    await fs.mkdir(path.dirname(nodePath), { recursive: true });
    await fs.writeFile(nodePath, "not executable\n", { mode: 0o644 });
    if (process.platform !== "win32") {
      assert.throws(
        () => updateWorkflow.preparedRuntimeNodeExecutable(tempDir),
        /rin_managed_node_runtime_missing/,
      );
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("provisionPreparedCurrentNodeRuntime makes source updates launch a self-contained Node and npm toolchain", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-node-"));
  try {
    const nodePath =
      updateWorkflow.provisionPreparedCurrentNodeRuntime(tempDir);
    assert.equal(
      nodePath,
      path.join(
        tempDir,
        "runtime",
        "node",
        "current",
        process.platform === "win32" ? "node.exe" : "bin/node",
      ),
    );
    assert.equal(
      updateWorkflow.preparedRuntimeNodeExecutable(tempDir),
      nodePath,
    );
    const copied = await fs.readFile(nodePath);
    const current = await fs.readFile(process.execPath);
    assert.deepEqual(copied, current);

    const hostilePath = path.join(tempDir, "external-node");
    const npmCommand = updateWorkflow.preparedRuntimeNpmCommand(
      tempDir,
      ["--version"],
      { ...process.env, PATH: hostilePath },
    );
    assert.equal(npmCommand.command, nodePath);
    await fs.access(npmCommand.args[0]);
    assert.deepEqual(npmCommand.args.slice(1), ["--version"]);
    assert.equal(
      String(npmCommand.options.env.PATH).split(path.delimiter)[0],
      path.dirname(nodePath),
    );
    assert.doesNotMatch(
      String(npmCommand.options.env.PATH).split(path.delimiter)[0],
      new RegExp(hostilePath),
    );
    assert.match(
      execFileSync(npmCommand.command, npmCommand.args, {
        ...npmCommand.options,
        encoding: "utf8",
      }).trim(),
      /^\d+\.\d+\.\d+$/,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test(
  "provisionPreparedCurrentNodeRuntime does not mix an existing Node-only runtime with process-adjacent npm",
  { skip: !hasCommand("curl") || !hasCommand("tar") },
  async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rin-update-node-"),
    );
    const originalExecPath = process.execPath;
    try {
      const targetNode = path.join(
        tempDir,
        "runtime",
        "node",
        "current",
        process.platform === "win32" ? "node.exe" : "bin/node",
      );
      await fs.mkdir(path.dirname(targetNode), { recursive: true });
      await fs.copyFile(originalExecPath, targetNode);
      if (process.platform !== "win32") await fs.chmod(targetNode, 0o755);

      const processNode = path.join(
        tempDir,
        "process-runtime",
        process.platform === "win32" ? "node.exe" : "bin/node",
      );
      await fs.mkdir(path.dirname(processNode), { recursive: true });
      await fs.copyFile(originalExecPath, processNode);
      if (process.platform !== "win32") await fs.chmod(processNode, 0o755);
      const processNpmRoot = path.join(
        tempDir,
        "process-runtime",
        process.platform === "win32"
          ? path.join("node_modules", "npm")
          : path.join("lib", "node_modules", "npm"),
      );
      await fs.mkdir(path.join(processNpmRoot, "bin"), { recursive: true });
      await fs.writeFile(
        path.join(processNpmRoot, "bin", "npm-cli.js"),
        "console.log('99.0.0');\n",
      );
      await fs.writeFile(
        path.join(processNpmRoot, "process-adjacent"),
        "bad\n",
      );

      process.execPath = processNode;
      updateWorkflow.provisionPreparedCurrentNodeRuntime(tempDir);

      const targetNpmRoot = path.join(
        tempDir,
        "runtime",
        "node",
        "current",
        process.platform === "win32"
          ? path.join("node_modules", "npm")
          : path.join("lib", "node_modules", "npm"),
      );
      assert.equal(
        fsSync.existsSync(path.join(targetNpmRoot, "process-adjacent")),
        false,
      );
      const npmCommand = updateWorkflow.preparedRuntimeNpmCommand(tempDir, [
        "--version",
      ]);
      assert.equal(
        execFileSync(npmCommand.command, npmCommand.args, {
          ...npmCommand.options,
          encoding: "utf8",
        }).trim(),
        "10.9.3",
      );
    } finally {
      process.execPath = originalExecPath;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "prepareUpdateRuntimeSource keeps npm lifecycle scripts on the prepared managed Node despite a hostile external PATH",
  { skip: !hasCommand("curl") || !hasCommand("tar") },
  async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rin-update-path-"),
    );
    try {
      const sourceRoot = path.join(tempDir, "source");
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.writeFile(
        path.join(sourceRoot, "package.json"),
        JSON.stringify({
          name: "rin-managed-node-fixture",
          version: "1.0.0",
          dependencies: {
            "better-sqlite3": "file:vendor/better-sqlite3",
          },
          scripts: {
            build:
              "node -e \"require('node:fs').writeFileSync('build-node.txt', process.execPath)\"",
          },
        }),
      );
      const fakeBetterSqliteRoot = path.join(
        sourceRoot,
        "vendor",
        "better-sqlite3",
      );
      await fs.mkdir(fakeBetterSqliteRoot, { recursive: true });
      await fs.writeFile(
        path.join(fakeBetterSqliteRoot, "package.json"),
        JSON.stringify({
          name: "better-sqlite3",
          version: "12.11.1",
          main: "index.js",
        }),
      );
      await fs.writeFile(
        path.join(fakeBetterSqliteRoot, "index.js"),
        "module.exports=class Database{prepare(){return{get(){return{}}}}close(){}};\n",
      );
      const archivePath = path.join(tempDir, "source.tar.gz");
      execFileSync("tar", ["-czf", archivePath, "-C", tempDir, "source"]);

      const hostileBin = path.join(tempDir, "hostile-bin");
      await fs.mkdir(hostileBin, { recursive: true });
      await writeExecutable(
        path.join(
          hostileBin,
          process.platform === "win32" ? "node.exe" : "node",
        ),
        "#!/bin/sh\nexit 97\n",
      );
      const workRoot = path.join(tempDir, "work");
      await fs.mkdir(workRoot, { recursive: true });
      const workspace = updateWorkflow.createUpdateRuntimeSourceWorkspace(
        {
          channel: "git",
          archiveUrl: pathToFileURL(archivePath).href,
          version: "abc1234",
          branch: "main",
          ref: "abc1234",
          sourceLabel: "git main @ abc1234",
        },
        workRoot,
      );

      await updateWorkflow.prepareUpdateRuntimeSource({
        release: JSON.parse(await fs.readFile(workspace.releaseFile, "utf8")),
        workspace,
        i18n: testI18n(),
        env: {
          ...process.env,
          PATH: [hostileBin, process.env.PATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
      });

      assert.equal(
        await fs.readFile(
          path.join(workspace.sourceRoot, "build-node.txt"),
          "utf8",
        ),
        updateWorkflow.preparedRuntimeNodeExecutable(workspace.sourceRoot),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "prepareUpdateRuntimeSource rejects platform bundle assets without checksum",
  { skip: !hasCommand("curl") },
  async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-"));
    try {
      const archivePath = path.join(tempDir, "rin-platform-bundle.tar.gz");
      await fs.writeFile(archivePath, "not a real archive");
      const workRoot = path.join(tempDir, "work");
      await fs.mkdir(workRoot, { recursive: true });
      const platformKey = release.releasePlatformKey();
      const workspace = updateWorkflow.createUpdateRuntimeSourceWorkspace(
        {
          channel: "stable",
          archiveUrl: "https://example.invalid/source.tgz",
          version: "1.2.3",
          branch: "stable",
          ref: "abc1234",
          sourceLabel: "stable 1.2.3",
          assets: {
            [platformKey]: {
              bundleUrl: pathToFileURL(archivePath).href,
            },
          },
        },
        workRoot,
      );

      await assert.rejects(
        updateWorkflow.prepareUpdateRuntimeSource({
          release: JSON.parse(await fs.readFile(workspace.releaseFile, "utf8")),
          workspace,
          i18n: testI18n(),
        }),
        /rin_update_platform_bundle_checksum_missing/,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "prepareUpdateRuntimeSource rejects platform bundle checksum mismatch",
  { skip: !hasCommand("curl") },
  async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-"));
    try {
      const archivePath = path.join(tempDir, "rin-platform-bundle.tar.gz");
      await fs.writeFile(archivePath, "not a real archive");
      const workRoot = path.join(tempDir, "work");
      await fs.mkdir(workRoot, { recursive: true });
      const platformKey = release.releasePlatformKey();
      const workspace = updateWorkflow.createUpdateRuntimeSourceWorkspace(
        {
          channel: "stable",
          archiveUrl: "https://example.invalid/source.tgz",
          version: "1.2.3",
          branch: "stable",
          ref: "abc1234",
          sourceLabel: "stable 1.2.3",
          assets: {
            [platformKey]: {
              bundleUrl: pathToFileURL(archivePath).href,
              sha256: "0".repeat(64),
            },
          },
        },
        workRoot,
      );

      await assert.rejects(
        updateWorkflow.prepareUpdateRuntimeSource({
          release: JSON.parse(await fs.readFile(workspace.releaseFile, "utf8")),
          workspace,
          i18n: testI18n(),
        }),
        /rin_update_platform_bundle_checksum_mismatch/,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "prepareUpdateRuntimeSource uses platform bundle assets without npm build",
  { skip: !hasCommand("curl") || !hasCommand("tar") },
  async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-"));
    try {
      const bundleRoot = path.join(tempDir, "rin-platform-bundle");
      const invocationLog = path.join(tempDir, "bundle-node.log");
      const nodePath = path.join(
        bundleRoot,
        "runtime",
        "node",
        "current",
        process.platform === "win32" ? "node.exe" : "bin/node",
      );
      await fs.mkdir(path.dirname(nodePath), { recursive: true });
      await fs.mkdir(path.join(bundleRoot, "dist", "app", "rin-install"), {
        recursive: true,
      });
      await fs.mkdir(path.join(bundleRoot, "node_modules", "better-sqlite3"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(bundleRoot, "node_modules", "better-sqlite3", "package.json"),
        JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }),
      );
      await fs.mkdir(path.join(bundleRoot, "extensions"), { recursive: true });
      await writeExecutable(
        nodePath,
        `#!/bin/sh
echo "$*" >>"$RIN_UPDATE_BUNDLE_NODE_LOG"
case "$1" in *npm-cli.js) echo 10.9.3 ;; esac
exit 0
`,
      );
      const npmCliPath = path.join(
        bundleRoot,
        "runtime",
        "node",
        "current",
        process.platform === "win32"
          ? path.join("node_modules", "npm", "bin", "npm-cli.js")
          : path.join("lib", "node_modules", "npm", "bin", "npm-cli.js"),
      );
      await fs.mkdir(path.dirname(npmCliPath), { recursive: true });
      await fs.writeFile(npmCliPath, "export {};\n");
      await fs.writeFile(
        path.join(bundleRoot, "dist", "app", "rin-install", "main.js"),
        "export {};\n",
      );
      await fs.writeFile(
        path.join(bundleRoot, "package.json"),
        JSON.stringify({ name: "@hoshinorin/rin", version: "1.2.3" }),
      );
      const archivePath = path.join(tempDir, "rin-platform-bundle.tar.gz");
      execFileSync("tar", [
        "-czf",
        archivePath,
        "-C",
        tempDir,
        "rin-platform-bundle",
      ]);
      const sha256 = createHash("sha256")
        .update(fsSync.readFileSync(archivePath))
        .digest("hex");
      const platformKey = release.releasePlatformKey();
      const workRoot = path.join(tempDir, "work");
      await fs.mkdir(workRoot, { recursive: true });
      const workspace = updateWorkflow.createUpdateRuntimeSourceWorkspace(
        {
          channel: "stable",
          archiveUrl: "https://example.invalid/source.tgz",
          version: "1.2.3",
          branch: "stable",
          ref: "abc1234",
          sourceLabel: "stable 1.2.3",
          assets: {
            [platformKey]: {
              bundleUrl: pathToFileURL(archivePath).href,
              sha256,
              nodeVersion: "24.18.0",
            },
          },
        },
        workRoot,
      );

      await updateWorkflow.prepareUpdateRuntimeSource({
        release: JSON.parse(await fs.readFile(workspace.releaseFile, "utf8")),
        workspace,
        i18n: testI18n(),
        env: {
          ...process.env,
          RIN_UPDATE_BUNDLE_NODE_LOG: invocationLog,
        },
      });

      await fs.access(
        path.join(
          workspace.sourceRoot,
          "dist",
          "app",
          "rin-install",
          "main.js",
        ),
      );
      await fs.access(
        path.join(
          workspace.sourceRoot,
          "runtime",
          "node",
          "current",
          process.platform === "win32" ? "node.exe" : "bin/node",
        ),
      );
      assert.equal(
        updateWorkflow.preparedRuntimeNodeExecutable(workspace.sourceRoot),
        path.join(
          workspace.sourceRoot,
          "runtime",
          "node",
          "current",
          process.platform === "win32" ? "node.exe" : "bin/node",
        ),
      );
      const log = await fs.readFile(workspace.logFile, "utf8");
      assert.doesNotMatch(log, /npm (?:install|ci|run|prune)/);
      const invocations = await fs.readFile(invocationLog, "utf8");
      assert.match(invocations, /npm-cli\.js --version/);
      assert.match(
        invocations,
        /-e const Database=require\('better-sqlite3'\)/,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);
