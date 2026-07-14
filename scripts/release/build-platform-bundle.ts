#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function argValue(argv: string[], index: number, option: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`missing_value:${option}`);
  return value.trim();
}

function parseArgs(argv: string[]) {
  const args = {
    output: "",
    platform: "",
    nodeRuntime: "",
    version: "",
    nodeVersion: process.versions.node,
    format: process.platform === "win32" ? "zip" : "tar.gz",
    repoRoot: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      args.output = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--platform") {
      args.platform = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--node-runtime") {
      args.nodeRuntime = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--version") {
      args.version = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--node-version") {
      args.nodeVersion = argValue(argv, index, arg).replace(/^v/, "");
      index += 1;
    } else if (arg === "--format") {
      args.format = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--repo-root") {
      args.repoRoot = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/release/build-platform-bundle.ts --output <dir> --platform <os-arch> [--version <version>] [--node-runtime <dir>] [--node-version <version>] [--format tar.gz|zip] [--repo-root <dir>]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  if (!args.output) throw new Error("missing_output");
  if (!args.platform) throw new Error("missing_platform");
  if (args.format !== "tar.gz" && args.format !== "zip") {
    throw new Error(`unsupported_format:${args.format}`);
  }
  return args;
}

function repoRootFromHere() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function inferNodeRuntimeRoot() {
  const root =
    process.platform === "win32"
      ? path.dirname(process.execPath)
      : path.dirname(path.dirname(process.execPath));
  const normalized = path.resolve(root);
  if (["/", "/usr", "/usr/local", "/opt/homebrew"].includes(normalized)) {
    throw new Error(
      "node_runtime_root_ambiguous: pass --node-runtime pointing at a self-contained Node distribution",
    );
  }
  return normalized;
}

function copyEntry(sourceRoot: string, bundleRoot: string, name: string) {
  const sourcePath = path.join(sourceRoot, name);
  if (!fs.existsSync(sourcePath)) return;
  fs.cpSync(sourcePath, path.join(bundleRoot, name), {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}

function sha256(filePath: string) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command}_failed:${result.status ?? 1}`);
  }
}

function nodeToolchainPaths(nodeRoot: string, platform: string) {
  return platform.startsWith("win32-")
    ? {
        nodeExecutable: path.join(nodeRoot, "node.exe"),
        npmCli: path.join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js"),
      }
    : {
        nodeExecutable: path.join(nodeRoot, "bin", "node"),
        npmCli: path.join(
          nodeRoot,
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      };
}

function managedToolchainEnvironment(
  toolchain: ReturnType<typeof nodeToolchainPaths>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const inheritedPath = String(env.PATH || "").trim();
  return {
    ...env,
    PATH: [path.dirname(toolchain.nodeExecutable), inheritedPath]
      .filter(Boolean)
      .join(path.delimiter),
    NODE_PATH: "",
    npm_node_execpath: toolchain.nodeExecutable,
    npm_execpath: toolchain.npmCli,
  };
}

function pruneBundleDependencies(
  sourceRoot: string,
  bundleRoot: string,
  nodeRuntimeRoot: string,
  platform: string,
) {
  const nodeModules = path.join(bundleRoot, "node_modules");
  if (!fs.existsSync(nodeModules)) return;
  const sourceLockfile = path.join(sourceRoot, "package-lock.json");
  const bundleLockfile = path.join(bundleRoot, "package-lock.json");
  if (fs.existsSync(sourceLockfile)) {
    fs.copyFileSync(sourceLockfile, bundleLockfile);
  }
  const toolchain = nodeToolchainPaths(nodeRuntimeRoot, platform);
  if (!fs.existsSync(toolchain.npmCli)) {
    throw new Error("bundle_missing:managed npm");
  }
  try {
    run(
      toolchain.nodeExecutable,
      [
        toolchain.npmCli,
        "prune",
        "--omit=dev",
        "--no-fund",
        "--no-audit",
        "--ignore-scripts",
        "--package-lock=false",
      ],
      bundleRoot,
      managedToolchainEnvironment(toolchain),
    );
  } finally {
    fs.rmSync(bundleLockfile, { force: true });
  }
}

function validateBundleLayout(bundleRoot: string, platform: string) {
  for (const relativePath of [
    "dist/app/rin-install/main.js",
    "dist/app/rin/main.js",
    "extensions",
    "node_modules",
    "package.json",
    "runtime/node/current",
  ]) {
    const target = path.join(bundleRoot, relativePath);
    if (!fs.existsSync(target)) {
      throw new Error(`bundle_missing:${relativePath}`);
    }
  }
  const toolchain = nodeToolchainPaths(
    path.join(bundleRoot, "runtime", "node", "current"),
    platform,
  );
  const { nodeExecutable, npmCli } = toolchain;
  fs.accessSync(nodeExecutable, fs.constants.X_OK);
  const result = spawnSync(nodeExecutable, ["--version"], {
    cwd: bundleRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`bundled_node_failed:${result.status ?? 1}`);
  }
  const version = String(result.stdout || "").trim();
  if (!/^v?\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`bundled_node_invalid_version:${version || "empty"}`);
  }

  if (!fs.existsSync(npmCli)) throw new Error("bundle_missing:managed npm");
  const managedEnv = managedToolchainEnvironment(toolchain);
  const npmResult = spawnSync(nodeExecutable, [npmCli, "--version"], {
    cwd: bundleRoot,
    env: managedEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (npmResult.error) throw npmResult.error;
  if (npmResult.status !== 0) {
    throw new Error(`bundled_npm_failed:${npmResult.status ?? 1}`);
  }
  const npmVersion = String(npmResult.stdout || "").trim();
  if (!/^\d+\.\d+\.\d+/.test(npmVersion)) {
    throw new Error(`bundled_npm_invalid_version:${npmVersion || "empty"}`);
  }

  const nativeResult = spawnSync(
    nodeExecutable,
    [
      "-e",
      "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close();",
    ],
    {
      cwd: bundleRoot,
      env: managedEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (nativeResult.error) throw nativeResult.error;
  if (nativeResult.status !== 0) {
    throw new Error(
      `bundled_native_dependency_failed:${nativeResult.status ?? 1}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = args.repoRoot
  ? path.resolve(args.repoRoot)
  : repoRootFromHere();
const outputDir = path.resolve(process.cwd(), args.output);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const version = String(args.version || packageJson.version || "0.0.0");
packageJson.version = version;
const bundleName = `rin-${version}-${args.platform}`;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-platform-bundle-"));
try {
  const bundleRoot = path.join(workDir, bundleName);
  fs.mkdirSync(bundleRoot, { recursive: true });
  for (const name of ["dist", "node_modules", "package.json"]) {
    copyEntry(repoRoot, bundleRoot, name);
  }
  copyEntry(repoRoot, bundleRoot, "extensions");
  fs.mkdirSync(path.join(bundleRoot, "extensions"), { recursive: true });
  fs.writeFileSync(
    path.join(bundleRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  const nodeRuntimeRoot = path.resolve(
    args.nodeRuntime || inferNodeRuntimeRoot(),
  );
  pruneBundleDependencies(repoRoot, bundleRoot, nodeRuntimeRoot, args.platform);
  const targetNodeRoot = path.join(bundleRoot, "runtime", "node", "current");
  fs.mkdirSync(path.dirname(targetNodeRoot), { recursive: true });
  fs.cpSync(nodeRuntimeRoot, targetNodeRoot, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  validateBundleLayout(bundleRoot, args.platform);

  fs.mkdirSync(outputDir, { recursive: true });
  const extension = args.format === "zip" ? "zip" : "tar.gz";
  const bundlePath = path.join(outputDir, `${bundleName}.${extension}`);
  fs.rmSync(bundlePath, { force: true });
  if (args.format === "zip") {
    run(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -LiteralPath ${JSON.stringify(bundleName)} -DestinationPath ${JSON.stringify(bundlePath)}`,
      ],
      workDir,
    );
  } else {
    run("tar", ["-czf", bundlePath, bundleName], workDir);
  }
  const result = {
    platform: args.platform,
    bundlePath,
    sha256: sha256(bundlePath),
    nodeVersion: args.nodeVersion,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
