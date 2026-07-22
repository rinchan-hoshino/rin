#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CHANNELS = new Set(["nightly", "beta", "stable", "hotfix"]);
const NPM_REGISTRY = "https://registry.npmjs.org/";
const NPM_PUBLISHER = "hoshinorin";

function trim(value) {
  return String(value || "").trim();
}

function nextArgValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || String(value).startsWith("--")) {
    throw new Error(`missing_value:${option}`);
  }
  return trim(value);
}

function parseArgs(argv) {
  const args = {
    channel: "",
    ref: "",
    version: "",
    noPublish: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--channel") {
      args.channel = nextArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--ref") {
      args.ref = nextArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--version") {
      args.version = nextArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--no-publish") {
      args.noPublish = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: npm run release:local -- --channel nightly|beta|stable|hotfix [--ref <git-ref>] [--version <x.y.z>] [--no-publish]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  if (!CHANNELS.has(args.channel)) {
    throw new Error(`invalid_channel:${args.channel || "missing"}`);
  }
  if (args.channel === "hotfix" && (!args.ref || !args.version)) {
    throw new Error("hotfix_requires_ref_and_version");
  }
  if (args.channel !== "hotfix" && (args.ref || args.version)) {
    throw new Error(`unexpected_ref_or_version:${args.channel}`);
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${trim(result.stdout)}\n${trim(result.stderr)}`
      : "";
    throw new Error(
      `command_failed:${command} ${args.join(" ")}:exit=${result.status}${detail}`,
    );
  }
  return options.capture ? trim(result.stdout) : "";
}

function git(args, options = {}) {
  return run("git", args, options);
}

function npm(args, options = {}) {
  return run("npm", args, options);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function repoRoot() {
  return git(["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    capture: true,
  });
}

function ensureCleanAuthoritativeMain(root, noPublish) {
  const branch = git(["branch", "--show-current"], {
    cwd: root,
    capture: true,
  });
  const status = git(["status", "--porcelain"], { cwd: root, capture: true });
  if (status) throw new Error("release_worktree_dirty");
  if (!noPublish && branch !== "main") {
    throw new Error(`release_requires_main_branch:${branch || "detached"}`);
  }
  git(["fetch", "origin", "main"], { cwd: root });
  const head = git(["rev-parse", "HEAD"], { cwd: root, capture: true });
  const remote = git(["rev-parse", "origin/main"], {
    cwd: root,
    capture: true,
  });
  if (!noPublish && head !== remote) {
    throw new Error(`release_main_not_current:${head}:${remote}`);
  }
}

function ensureNpmPublishIdentity(root, channel, noPublish) {
  if (noPublish || (channel !== "stable" && channel !== "hotfix")) return;

  const identity = npm(["whoami", "--registry", NPM_REGISTRY], {
    cwd: root,
    capture: true,
  });
  if (identity !== NPM_PUBLISHER) {
    throw new Error(
      `npm_publisher_identity_mismatch:${identity || "missing"}:expected=${NPM_PUBLISHER}`,
    );
  }
}

function tsx(root, script, args, options = {}) {
  const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
  if (!fs.existsSync(tsxBin))
    throw new Error("missing_node_modules_run_npm_ci");
  return run(tsxBin, [path.join(root, "scripts", "release", script), ...args], {
    cwd: options.cwd || root,
    capture: options.capture,
  });
}

function validateReleaseTree(root) {
  npm(["run", "format:check"], { cwd: root });
  npm(["run", "lint"], { cwd: root });
  npm(["run", "build"], { cwd: root });
  npm(["run", "test:release"], {
    cwd: root,
    env: { ...process.env, CI: "1" },
  });
}

function verifyChangelog(root, cwd, version, fromRef, toRef) {
  tsx(
    root,
    "verify-changelog.ts",
    ["--version", version, "--from-ref", fromRef, "--to-ref", toRef],
    { cwd },
  );
}

function buildBundle(root, cwd, version, outputDir) {
  const nodeRuntime = path.dirname(path.dirname(process.execPath));
  const output = tsx(
    root,
    "build-platform-bundle.ts",
    [
      "--repo-root",
      cwd,
      "--output",
      outputDir,
      "--platform",
      "linux-x64",
      "--version",
      version,
      "--node-runtime",
      nodeRuntime,
      "--node-version",
      process.versions.node,
    ],
    { cwd, capture: true },
  );
  return JSON.parse(output);
}

function repositorySlug(root) {
  const remote = git(["remote", "get-url", "origin"], {
    cwd: root,
    capture: true,
  });
  const match = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`unsupported_origin:${remote}`);
  return match[1];
}

function remoteHasTag(root, tag) {
  const result = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
    { cwd: root, encoding: "utf8", stdio: "ignore" },
  );
  return result.status === 0;
}

function ghReleaseExists(root, repository, tag) {
  const result = spawnSync(
    "gh",
    ["release", "view", tag, "--repo", repository],
    { cwd: root, encoding: "utf8", stdio: "ignore" },
  );
  return result.status === 0;
}

function publishGitHubBundle(
  root,
  repository,
  version,
  ref,
  bundlePath,
  prerelease,
) {
  const tag = `v${version}`;
  if (!remoteHasTag(root, tag)) {
    git(["tag", "-a", tag, "-m", `Rin ${tag}`, ref], { cwd: root });
    git(["push", "origin", `refs/tags/${tag}`], { cwd: root });
  }
  if (!ghReleaseExists(root, repository, tag)) {
    const args = [
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--target",
      ref,
      "--title",
      `Rin ${tag}`,
      "--notes",
      `Rin ${tag} ${prerelease ? `${prerelease} ` : ""}platform bundles`,
    ];
    if (prerelease) args.push("--prerelease");
    run("gh", args, { cwd: root });
  }
  run(
    "gh",
    ["release", "upload", tag, bundlePath, "--clobber", "--repo", repository],
    { cwd: root },
  );
}

function commitAndPushMain(root, message) {
  git(["add", "release-manifest.json"], { cwd: root });
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: root,
    stdio: "ignore",
  });
  if (staged.status !== 0) {
    git(["commit", "--no-verify", "-m", message], { cwd: root });
  }
  const pushed = spawnSync("git", ["push", "origin", "HEAD:main"], {
    cwd: root,
    stdio: "inherit",
  });
  if (pushed.status !== 0) {
    git(["fetch", "origin", "main"], { cwd: root });
    git(["rebase", "origin/main"], { cwd: root });
    git(["push", "origin", "HEAD:main"], { cwd: root });
  }
}

function publishBootstrap(root, remoteUrl, message, tempRoot) {
  const branch = "bootstrap";
  const dir = path.join(tempRoot, branch);
  const hasBranch =
    spawnSync(
      "git",
      ["ls-remote", "--exit-code", "--heads", "origin", branch],
      { cwd: root, stdio: "ignore" },
    ).status === 0;
  if (hasBranch) {
    git(["clone", "--depth", "1", "--branch", branch, remoteUrl, dir], {
      cwd: root,
    });
  } else {
    git(["init", dir], { cwd: root });
    git(["-C", dir, "checkout", "--orphan", branch], { cwd: root });
    git(["-C", dir, "remote", "add", "origin", remoteUrl], { cwd: root });
  }
  tsx(root, "export-bootstrap-branch.ts", [
    "--output",
    dir,
    "--branch",
    branch,
  ]);
  git(["-C", dir, "add", "."], { cwd: root });
  const staged = spawnSync("git", ["-C", dir, "diff", "--cached", "--quiet"], {
    cwd: root,
    stdio: "ignore",
  });
  if (staged.status === 0) return;
  git(["-C", dir, "commit", "-m", message], { cwd: root });
  const pushed = spawnSync(
    "git",
    ["-C", dir, "push", "origin", `HEAD:${branch}`],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (pushed.status !== 0) {
    git(["-C", dir, "fetch", "origin", branch], { cwd: root });
    git(["-C", dir, "rebase", `origin/${branch}`], { cwd: root });
    git(["-C", dir, "push", "origin", `HEAD:${branch}`], { cwd: root });
  }
}

function updateManifest(
  root,
  channel,
  version,
  ref,
  extra,
  bundle,
  repository,
) {
  const args = [
    "--channel",
    channel,
    "--version",
    version,
    "--ref",
    ref,
    ...extra,
    "--asset-platform",
    "linux-x64",
    "--asset-url",
    `https://github.com/${repository}/releases/download/v${version}/${path.basename(bundle.bundlePath)}`,
    "--asset-sha256",
    bundle.sha256,
    "--asset-node-version",
    bundle.nodeVersion,
  ];
  tsx(root, "update-release-manifest.ts", args);
}

function releaseSourceChannel(root, channel, noPublish, tempRoot) {
  const manifest = readJson(path.join(root, "release-manifest.json"));
  const ref = git(["rev-parse", "HEAD"], { cwd: root, capture: true });
  const plan = JSON.parse(
    tsx(root, "plan-release.ts", ["--channel", channel, "--ref", ref], {
      capture: true,
    }),
  );
  if (channel === "beta") {
    verifyChangelog(
      root,
      root,
      plan.promotionVersion,
      trim(manifest.stable?.ref),
      ref,
    );
  }
  validateReleaseTree(root);
  const bundle = buildBundle(
    root,
    root,
    plan.version,
    path.join(tempRoot, "bundles"),
  );
  if (noPublish)
    return { channel, version: plan.version, ref, bundle, published: false };

  const repository = repositorySlug(root);
  publishGitHubBundle(
    root,
    repository,
    plan.version,
    ref,
    bundle.bundlePath,
    channel,
  );
  const extra =
    channel === "nightly"
      ? ["--branch", "main"]
      : ["--promotion-version", plan.promotionVersion];
  updateManifest(root, channel, plan.version, ref, extra, bundle, repository);
  const action = channel === "nightly" ? "publish nightly" : "cut beta";
  commitAndPushMain(root, `chore(release): ${action} ${plan.version}`);
  publishBootstrap(
    root,
    git(["remote", "get-url", "origin"], { cwd: root, capture: true }),
    `chore(release): ${action} ${plan.version}`,
    tempRoot,
  );
  return { channel, version: plan.version, ref, bundle, published: true };
}

function releaseCandidateChannel(root, args, tempRoot) {
  const manifest = readJson(path.join(root, "release-manifest.json"));
  let ref = args.ref;
  let version = args.version;
  let betaVersion = "";
  if (args.channel === "stable") {
    ref = trim(manifest.beta?.ref);
    betaVersion = trim(manifest.beta?.version);
    if (!ref || !betaVersion) throw new Error("missing_beta_candidate");
    const plan = JSON.parse(
      tsx(
        root,
        "plan-release.ts",
        ["--channel", "stable-promotion", "--beta-version", betaVersion],
        { capture: true },
      ),
    );
    version = plan.version;
  } else {
    git(["fetch", "origin", ref], { cwd: root });
  }

  const candidate = path.join(tempRoot, `${args.channel}-candidate`);
  git(["worktree", "add", "--detach", candidate, ref], { cwd: root });
  try {
    const candidateManifest = readJson(
      path.join(candidate, "release-manifest.json"),
    );
    verifyChangelog(
      root,
      candidate,
      version,
      trim(candidateManifest.stable?.ref),
      ref,
    );
    npm(["ci", "--no-fund", "--no-audit"], { cwd: candidate });
    validateReleaseTree(candidate);
    npm(["version", "--no-git-tag-version", version], { cwd: candidate });
    const bundle = buildBundle(
      root,
      candidate,
      version,
      path.join(tempRoot, "bundles"),
    );
    if (args.noPublish) {
      return { channel: args.channel, version, ref, bundle, published: false };
    }

    npm(["publish", "--tag", "latest", "--access", "public"], {
      cwd: candidate,
    });
    const repository = repositorySlug(root);
    publishGitHubBundle(root, repository, version, ref, bundle.bundlePath, "");
    const extra = betaVersion ? ["--from-beta-version", betaVersion] : [];
    updateManifest(root, "stable", version, ref, extra, bundle, repository);
    const action = betaVersion
      ? `promote beta ${betaVersion} to stable ${version}`
      : `publish hotfix ${version}`;
    commitAndPushMain(root, `chore(release): ${action}`);
    publishBootstrap(
      root,
      git(["remote", "get-url", "origin"], { cwd: root, capture: true }),
      `chore(release): ${action}`,
      tempRoot,
    );
    return { channel: args.channel, version, ref, bundle, published: true };
  } finally {
    git(["worktree", "remove", "--force", candidate], { cwd: root });
  }
}

function acquireLock() {
  const lock = path.join(os.homedir(), ".cache", "rin-release", "publish.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error && error.code === "EEXIST")
      throw new Error(`release_already_running:${lock}`);
    throw error;
  }
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  return () => fs.rmSync(lock, { recursive: true, force: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.versions.node !== "24.18.0") {
    throw new Error(
      `unsupported_release_node:${process.versions.node}:expected=24.18.0`,
    );
  }
  const root = repoRoot();
  const releaseLock = acquireLock();
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `rin-release-${args.channel}-`),
  );
  try {
    ensureCleanAuthoritativeMain(root, args.noPublish);
    ensureNpmPublishIdentity(root, args.channel, args.noPublish);
    const result =
      args.channel === "nightly" || args.channel === "beta"
        ? releaseSourceChannel(root, args.channel, args.noPublish, tempRoot)
        : releaseCandidateChannel(root, args, tempRoot);
    console.log(JSON.stringify(result));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    releaseLock();
  }
}

main();
