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

async function writeExecutable(filePath: string, content: string) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
}

test("preparedRuntimeNodeExecutable ignores non-executable managed node files", async () => {
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
      assert.equal(
        updateWorkflow.preparedRuntimeNodeExecutable(tempDir),
        process.execPath,
      );
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("provisionPreparedCurrentNodeRuntime makes source updates launch managed node", async () => {
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
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

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
      await fs.mkdir(path.join(bundleRoot, "node_modules"), {
        recursive: true,
      });
      await fs.mkdir(path.join(bundleRoot, "extensions"), { recursive: true });
      await writeExecutable(nodePath, "#!/bin/sh\necho bundled\n");
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
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);
