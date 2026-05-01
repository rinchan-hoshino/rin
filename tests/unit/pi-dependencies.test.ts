import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);

const piDependencyNames = [
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
];

function readJson(relativePath: string) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function normalizeVersionSpec(value: unknown) {
  return String(value || "").replace(/^[~^]/, "");
}

test("Pi package dependencies stay version-aligned", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const rootLockPackage = packageLock.packages?.[""];
  const expectedVersion = normalizeVersionSpec(
    packageJson.dependencies?.["@mariozechner/pi-coding-agent"],
  );

  assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/);

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
