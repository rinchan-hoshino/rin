import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);

function makeTempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(command: string, args: string[], cwd: string) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeMirrorSnapshot(root: string, version: string) {
  const sourceRoot = path.join(root, "packages", "coding-agent");
  fs.mkdirSync(path.join(sourceRoot, "docs"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "examples"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "README.md"),
    `README ${version}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(sourceRoot, "CHANGELOG.md"),
    `# ${version}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(sourceRoot, "docs", "version.txt"),
    `${version}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(sourceRoot, "examples", "version.txt"),
    `${version}\n`,
    "utf8",
  );
}

function commitTag(root: string, version: string) {
  run("git", ["add", "."], root);
  run("git", ["commit", "-m", `snapshot ${version}`], root);
  run("git", ["tag", `v${version}`], root);
}

function writeSyncWorkspace(workspace: string, packageVersion: string) {
  fs.mkdirSync(path.join(workspace, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(rootDir, "scripts", "sync-upstreams.mjs"),
    path.join(workspace, "scripts", "sync-upstreams.mjs"),
  );
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify(
      {
        dependencies: {
          "@mariozechner/pi-coding-agent": `^${packageVersion}`,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function initMirrorRepo(mirrorRepo: string) {
  fs.mkdirSync(mirrorRepo, { recursive: true });
  run("git", ["init", "-b", "main"], mirrorRepo);
  run("git", ["config", "user.name", "Rin Tests"], mirrorRepo);
  run("git", ["config", "user.email", "rin-tests@example.invalid"], mirrorRepo);
}

function piUpstreamMetaPath(workspace: string) {
  return path.join(workspace, "upstream", "pi", "_upstream.json");
}

function writePiUpstreamMeta(workspace: string, meta: Record<string, string>) {
  fs.mkdirSync(path.dirname(piUpstreamMetaPath(workspace)), {
    recursive: true,
  });
  fs.writeFileSync(
    piUpstreamMetaPath(workspace),
    JSON.stringify(meta, null, 2) + "\n",
    "utf8",
  );
}

function readPiUpstreamMeta(workspace: string) {
  return JSON.parse(fs.readFileSync(piUpstreamMetaPath(workspace), "utf8"));
}

function readSyncedPiReadme(workspace: string) {
  return fs.readFileSync(
    path.join(workspace, "upstream", "pi", "README.md"),
    "utf8",
  );
}

function runPiSync(workspace: string) {
  run(
    process.execPath,
    [path.join(workspace, "scripts", "sync-upstreams.mjs"), "pi"],
    workspace,
  );
}

test("sync-upstreams uses the current pi package version tag instead of a stale _upstream ref", () => {
  const tempDir = makeTempDir("rin-sync-upstreams-");
  const mirrorRepo = path.join(tempDir, "mirror.git");
  const workspace = path.join(tempDir, "workspace");
  try {
    initMirrorRepo(mirrorRepo);

    writeMirrorSnapshot(mirrorRepo, "0.69.0");
    commitTag(mirrorRepo, "0.69.0");
    writeMirrorSnapshot(mirrorRepo, "0.70.0");
    commitTag(mirrorRepo, "0.70.0");

    writeSyncWorkspace(workspace, "0.70.0");
    writePiUpstreamMeta(workspace, {
      repo: pathToFileURL(mirrorRepo).href,
      sourceSubdir: "packages/coding-agent",
      ref: "v0.69.0",
      packageVersion: "0.69.0",
    });

    runPiSync(workspace);

    const nextMeta = readPiUpstreamMeta(workspace);
    assert.equal(nextMeta.ref, "v0.70.0");
    assert.equal(nextMeta.packageVersion, "0.70.0");
    assert.equal(readSyncedPiReadme(workspace), "README 0.70.0\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync-upstreams preserves an existing pi ref when package version is already current", () => {
  const tempDir = makeTempDir("rin-sync-upstreams-current-");
  const mirrorRepo = path.join(tempDir, "mirror.git");
  const workspace = path.join(tempDir, "workspace");
  try {
    initMirrorRepo(mirrorRepo);
    writeMirrorSnapshot(mirrorRepo, "0.70.0");
    commitTag(mirrorRepo, "0.70.0");
    run("git", ["tag", "custom-0.70.0"], mirrorRepo);

    writeSyncWorkspace(workspace, "0.70.0");
    writePiUpstreamMeta(workspace, {
      repo: pathToFileURL(mirrorRepo).href,
      sourceSubdir: "packages/coding-agent",
      ref: "custom-0.70.0",
      packageVersion: "0.70.0",
    });

    runPiSync(workspace);

    const nextMeta = readPiUpstreamMeta(workspace);
    assert.equal(nextMeta.ref, "custom-0.70.0");
    assert.equal(nextMeta.packageVersion, "0.70.0");
    assert.equal(readSyncedPiReadme(workspace), "README 0.70.0\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync-upstreams rejects value options without explicit values", () => {
  const tempDir = makeTempDir("rin-sync-upstreams-args-");
  const workspace = path.join(tempDir, "workspace");
  try {
    writeSyncWorkspace(workspace, "0.70.0");
    assert.throws(
      () =>
        run(
          process.execPath,
          [
            path.join(workspace, "scripts", "sync-upstreams.mjs"),
            "pi",
            "--ref",
          ],
          workspace,
        ),
      /Missing value for --ref/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
