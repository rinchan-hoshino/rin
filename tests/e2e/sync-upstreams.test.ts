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

function writeMirrorSnapshot(
  root: string,
  version: string,
  sourceSubdir = "packages/coding-agent",
) {
  const sourceRoot = path.join(root, sourceSubdir);
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

function writeSkillCreatorSnapshot(root: string, version: string) {
  const sourceRoot = path.join(root, "skills", "skill-creator");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "README.md"),
    `skill README ${version}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(sourceRoot, "SKILL.md"),
    `skill body ${version}\n`,
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

function skillCreatorUpstreamMetaPath(workspace: string) {
  return path.join(workspace, "upstream", "skill-creator", "_upstream.json");
}

function writeUpstreamMeta(filePath: string, meta: Record<string, string>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(meta, null, 2) + "\n", "utf8");
}

function writePiUpstreamMeta(workspace: string, meta: Record<string, string>) {
  writeUpstreamMeta(piUpstreamMetaPath(workspace), meta);
}

function writeSkillCreatorUpstreamMeta(
  workspace: string,
  meta: Record<string, string>,
) {
  writeUpstreamMeta(skillCreatorUpstreamMetaPath(workspace), meta);
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

function runSync(workspace: string, target: string, args: string[] = []) {
  run(
    process.execPath,
    [path.join(workspace, "scripts", "sync-upstreams.mjs"), target, ...args],
    workspace,
  );
}

function runPiSync(workspace: string, args: string[] = []) {
  runSync(workspace, "pi", args);
}

function runDefaultSync(workspace: string) {
  run(
    process.execPath,
    [path.join(workspace, "scripts", "sync-upstreams.mjs")],
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

test("sync-upstreams honors an explicit pi ref override", () => {
  const tempDir = makeTempDir("rin-sync-upstreams-ref-");
  const mirrorRepo = path.join(tempDir, "mirror.git");
  const workspace = path.join(tempDir, "workspace");
  try {
    initMirrorRepo(mirrorRepo);
    writeMirrorSnapshot(mirrorRepo, "0.70.0");
    commitTag(mirrorRepo, "0.70.0");
    writeMirrorSnapshot(mirrorRepo, "override");
    run("git", ["add", "."], mirrorRepo);
    run("git", ["commit", "-m", "snapshot override"], mirrorRepo);
    run("git", ["tag", "custom-ref"], mirrorRepo);

    writeSyncWorkspace(workspace, "0.70.0");
    writePiUpstreamMeta(workspace, {
      repo: pathToFileURL(mirrorRepo).href,
      sourceSubdir: "packages/coding-agent",
      ref: "v0.70.0",
      packageVersion: "0.70.0",
    });

    runPiSync(workspace, ["--ref", "custom-ref"]);

    const nextMeta = readPiUpstreamMeta(workspace);
    assert.equal(nextMeta.ref, "custom-ref");
    assert.equal(nextMeta.packageVersion, "0.70.0");
    assert.equal(readSyncedPiReadme(workspace), "README override\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync-upstreams honors explicit pi repo and source subdir overrides", () => {
  const tempDir = makeTempDir("rin-sync-upstreams-repo-");
  const mirrorRepo = path.join(tempDir, "mirror.git");
  const workspace = path.join(tempDir, "workspace");
  try {
    initMirrorRepo(mirrorRepo);
    writeMirrorSnapshot(mirrorRepo, "0.70.0", "alt/coding-agent");
    commitTag(mirrorRepo, "0.70.0");

    writeSyncWorkspace(workspace, "0.70.0");
    const repo = pathToFileURL(mirrorRepo).href;
    writePiUpstreamMeta(workspace, {
      repo: pathToFileURL(path.join(tempDir, "missing.git")).href,
      sourceSubdir: "packages/coding-agent",
      ref: "v0.70.0",
      packageVersion: "0.70.0",
    });

    runPiSync(workspace, [
      "--repo",
      repo,
      "--sourceSubdir",
      "alt/coding-agent",
    ]);

    const nextMeta = readPiUpstreamMeta(workspace);
    assert.equal(nextMeta.repo, repo);
    assert.equal(nextMeta.sourceSubdir, "alt/coding-agent");
    assert.equal(nextMeta.ref, "v0.70.0");
    assert.equal(nextMeta.packageVersion, "0.70.0");
    assert.equal(readSyncedPiReadme(workspace), "README 0.70.0\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync-upstreams mirrors the full skill-creator source root", () => {
  const tempDir = makeTempDir("rin-sync-upstreams-skill-");
  const mirrorRepo = path.join(tempDir, "mirror.git");
  const workspace = path.join(tempDir, "workspace");
  try {
    initMirrorRepo(mirrorRepo);
    const sourceRoot = path.join(mirrorRepo, "skills", "skill-creator");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "README.md"),
      "skill readme\n",
      "utf8",
    );
    fs.writeFileSync(path.join(sourceRoot, "SKILL.md"), "skill body\n", "utf8");
    run("git", ["add", "."], mirrorRepo);
    run("git", ["commit", "-m", "snapshot skill creator"], mirrorRepo);
    run("git", ["tag", "skill-test"], mirrorRepo);

    writeSyncWorkspace(workspace, "0.70.0");
    const repo = pathToFileURL(mirrorRepo).href;
    runSync(workspace, "skill-creator", [
      "--repo",
      repo,
      "--ref",
      "skill-test",
    ]);

    const destRoot = path.join(workspace, "upstream", "skill-creator");
    const nextMeta = JSON.parse(
      fs.readFileSync(path.join(destRoot, "_upstream.json"), "utf8"),
    );
    assert.equal(nextMeta.repo, repo);
    assert.equal(nextMeta.sourceSubdir, "skills/skill-creator");
    assert.equal(nextMeta.ref, "skill-test");
    assert.equal(
      fs.readFileSync(path.join(destRoot, "README.md"), "utf8"),
      "skill readme\n",
    );
    assert.equal(
      fs.readFileSync(path.join(destRoot, "SKILL.md"), "utf8"),
      "skill body\n",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync-upstreams defaults to all configured upstream mirrors", () => {
  const tempDir = makeTempDir("rin-sync-upstreams-all-");
  const mirrorRepo = path.join(tempDir, "mirror.git");
  const workspace = path.join(tempDir, "workspace");
  try {
    initMirrorRepo(mirrorRepo);
    writeMirrorSnapshot(mirrorRepo, "0.70.0");
    writeSkillCreatorSnapshot(mirrorRepo, "default");
    commitTag(mirrorRepo, "0.70.0");

    writeSyncWorkspace(workspace, "0.70.0");
    const repo = pathToFileURL(mirrorRepo).href;
    writePiUpstreamMeta(workspace, {
      repo,
      sourceSubdir: "packages/coding-agent",
      ref: "v0.70.0",
      packageVersion: "0.70.0",
    });
    writeSkillCreatorUpstreamMeta(workspace, {
      repo,
      sourceSubdir: "skills/skill-creator",
      ref: "v0.70.0",
    });

    runDefaultSync(workspace);

    const piMeta = readPiUpstreamMeta(workspace);
    assert.equal(piMeta.repo, repo);
    assert.equal(piMeta.ref, "v0.70.0");
    assert.equal(readSyncedPiReadme(workspace), "README 0.70.0\n");

    const skillRoot = path.join(workspace, "upstream", "skill-creator");
    const skillMeta = JSON.parse(
      fs.readFileSync(skillCreatorUpstreamMetaPath(workspace), "utf8"),
    );
    assert.equal(skillMeta.repo, repo);
    assert.equal(skillMeta.ref, "v0.70.0");
    assert.equal(
      fs.readFileSync(path.join(skillRoot, "README.md"), "utf8"),
      "skill README default\n",
    );
    assert.equal(
      fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8"),
      "skill body default\n",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync-upstreams rejects unknown mirror targets", () => {
  const tempDir = makeTempDir("rin-sync-upstreams-target-");
  const workspace = path.join(tempDir, "workspace");
  try {
    writeSyncWorkspace(workspace, "0.70.0");
    assert.throws(
      () => runSync(workspace, "missing-upstream"),
      /Unknown upstream mirror: missing-upstream/,
    );
    assert.equal(fs.existsSync(path.join(workspace, "upstream")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync-upstreams rejects value options without explicit values", () => {
  const tempDir = makeTempDir("rin-sync-upstreams-args-");
  const workspace = path.join(tempDir, "workspace");
  try {
    writeSyncWorkspace(workspace, "0.70.0");
    for (const option of ["ref", "repo", "sourceSubdir"]) {
      assert.throws(
        () =>
          run(
            process.execPath,
            [
              path.join(workspace, "scripts", "sync-upstreams.mjs"),
              "pi",
              `--${option}`,
            ],
            workspace,
          ),
        new RegExp(`Missing value for --${option}`),
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
