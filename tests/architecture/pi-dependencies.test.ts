import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const piDependencySections = new Map([
  ["@earendil-works/pi-agent-core", "devDependencies"],
  ["@earendil-works/pi-ai", "dependencies"],
  ["@earendil-works/pi-coding-agent", "dependencies"],
  ["@earendil-works/pi-tui", "dependencies"],
]);

function readJson(relativePath: string) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function normalizeVersionSpec(value: unknown) {
  return String(value || "").replace(/^[~^]/, "");
}

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...listSourceFiles(fullPath));
    } else if (/\.(?:ts|tsx|md)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativePath(filePath: string) {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

function currentPiVersion() {
  const packageJson = readJson("package.json");
  const expectedVersion = normalizeVersionSpec(
    packageJson.dependencies?.["@earendil-works/pi-coding-agent"],
  );
  assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/);
  return expectedVersion;
}

test("Pi package dependencies stay version-aligned", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const rootLockPackage = packageLock.packages?.[""];
  const expectedVersion = currentPiVersion();

  for (const [name, section] of piDependencySections) {
    assert.equal(
      normalizeVersionSpec(packageJson[section]?.[name]),
      expectedVersion,
    );
    assert.equal(
      normalizeVersionSpec(rootLockPackage?.[section]?.[name]),
      expectedVersion,
    );
    assert.equal(
      packageLock.packages?.[`node_modules/${name}`]?.version,
      expectedVersion,
    );
  }
});

test("Pi private imports stay centralized", () => {
  const allowed = new Set(["src/core/pi/private-api.ts"]);
  const violations: string[] = [];
  for (const filePath of listSourceFiles(path.join(rootDir, "src"))) {
    const relative = relativePath(filePath);
    const text = fs.readFileSync(filePath, "utf8");
    if (
      text.includes("node_modules/@earendil-works/pi-coding-agent/dist") &&
      !allowed.has(relative)
    ) {
      violations.push(relative);
    }
  }
  assert.deepEqual(violations, []);
});

test("Pi owns model thinking capability resolution", () => {
  const retiredOwner = "src/core/model-thinking-levels.ts";
  assert.equal(
    fs.existsSync(path.join(rootDir, retiredOwner)),
    false,
    `${retiredOwner} must stay retired`,
  );

  const forbiddenPatterns = [
    /computeAvailableThinkingLevels/,
    /supportsMaxReasoningThinkingLevels/,
    /codex-max/i,
  ];
  const violations: string[] = [];
  for (const filePath of listSourceFiles(path.join(rootDir, "src", "core"))) {
    const text = fs.readFileSync(filePath, "utf8");
    if (forbiddenPatterns.some((pattern) => pattern.test(text))) {
      violations.push(relativePath(filePath));
    }
  }
  assert.deepEqual(violations, []);
});

test("Pi session private members stay behind Rin's session host", () => {
  const allowed = new Set(["src/core/pi/session-host.ts"]);
  const memberPattern =
    /(?:\.|\[\s*["'])_(?:buildIndex|checkCompaction|emit|extensionCommandContextActions|extensionMode|extensionRunner|extensionShutdownHandler|extensionUIContext|getCompactionRequestAuth|persist|refreshToolRegistry|resourceLoader|rewriteFile|runAutoCompaction|toolPromptGuidelines|toolPromptSnippets|toolRegistry)\b/;
  const violations: string[] = [];
  for (const filePath of listSourceFiles(path.join(rootDir, "src", "core"))) {
    const relative = relativePath(filePath);
    if (allowed.has(relative)) continue;
    const text = fs.readFileSync(filePath, "utf8");
    if (memberPattern.test(text)) violations.push(relative);
  }
  assert.deepEqual(violations, []);
});

test("Rin has one private Pi session seam and no internal extension bridge", () => {
  assert.equal(
    fs.existsSync(
      path.join(rootDir, "src/core/pi/internal-extension-bridge.ts"),
    ),
    false,
  );
  const sessionHost = fs.readFileSync(
    path.join(rootDir, "src/core/pi/session-host.ts"),
    "utf8",
  );
  assert.match(sessionHost, /_baseSystemPrompt|_rebuildSystemPrompt/);
  const capabilitySession = fs.readFileSync(
    path.join(rootDir, "src/core/rin-lib/capability-session.ts"),
    "utf8",
  );
  assert.doesNotMatch(capabilitySession, /internal-extension-bridge/);
});

test("Pi upstream mirror metadata follows the package version", () => {
  const upstreamMeta = readJson("upstream/pi/_upstream.json");
  const expectedVersion = currentPiVersion();

  assert.equal(upstreamMeta.packageName, "@earendil-works/pi-coding-agent");
  assert.equal(upstreamMeta.packageVersion, expectedVersion);
  assert.equal(upstreamMeta.ref, `v${expectedVersion}`);
  assert.deepEqual(upstreamMeta.paths, [
    "README.md",
    "CHANGELOG.md",
    "docs",
    "examples",
  ]);
});
