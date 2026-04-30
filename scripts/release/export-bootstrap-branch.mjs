#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_PAYLOAD_FILES = Object.freeze([
  "install.sh",
  "update.sh",
  "install.ps1",
  "update.ps1",
  "scripts/bootstrap-entrypoint.sh",
  "scripts/bootstrap-entrypoint.ps1",
  "release-manifest.json",
  "docs/release/CHANGELOG.md",
]);

function parseArgs(argv) {
  const args = {
    output: "",
    branch: "bootstrap",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") args.output = String(argv[++index] || "").trim();
    else if (arg === "--branch")
      args.branch = String(argv[++index] || "").trim();
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/release/export-bootstrap-branch.mjs --output <dir> [--branch bootstrap]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  return args;
}

function rewriteBootstrapBranch(content, branch) {
  return content
    .replace(
      /^DEFAULT_BOOTSTRAP_BRANCH=.*$/m,
      `DEFAULT_BOOTSTRAP_BRANCH=${branch}`,
    )
    .replace(
      /^\$defaultBootstrapBranch = ".*"$/m,
      `$defaultBootstrapBranch = "${branch}"`,
    );
}

function copyFile(repoRoot, relativePath, outputDir, args) {
  const source = path.join(repoRoot, relativePath);
  const target = path.join(outputDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (relativePath === "install.sh" || relativePath === "install.ps1") {
    const content = fs.readFileSync(source, "utf8");
    fs.writeFileSync(
      target,
      rewriteBootstrapBranch(content, args.branch),
      "utf8",
    );
    return;
  }
  fs.copyFileSync(source, target);
}

const args = parseArgs(process.argv.slice(2));
if (!args.output) throw new Error("missing_output_dir");
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const outputDir = path.resolve(process.cwd(), args.output);
fs.mkdirSync(outputDir, { recursive: true });
for (const entry of fs.readdirSync(outputDir)) {
  if (entry === ".git") continue;
  fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
}

for (const relativePath of BOOTSTRAP_PAYLOAD_FILES) {
  copyFile(repoRoot, relativePath, outputDir, args);
}

fs.writeFileSync(
  path.join(outputDir, "README.md"),
  [
    "# Rin bootstrap branch",
    "",
    `This branch is generated for the ${args.branch} bootstrap flow.`,
    "It only stores the install/update bootstrap entry scripts and release metadata.",
    "Do not develop Rin source code on this branch.",
    "",
    "Included files:",
    ...BOOTSTRAP_PAYLOAD_FILES.map((relativePath) => `- ${relativePath}`),
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Exported bootstrap files to ${outputDir}`);
