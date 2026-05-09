import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);

const piDependencyNames = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

function readJson(relativePath: string) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function normalizeVersionSpec(value: unknown) {
  return String(value || "").replace(/^[~^]/, "");
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

  for (const name of piDependencyNames) {
    assert.equal(
      normalizeVersionSpec(packageJson.dependencies?.[name]),
      expectedVersion,
    );
    assert.equal(
      normalizeVersionSpec(rootLockPackage?.dependencies?.[name]),
      expectedVersion,
    );
    assert.equal(
      packageLock.packages?.[`node_modules/${name}`]?.version,
      expectedVersion,
    );
  }
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
