import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);

const runtimeDependencyPrune = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-install",
      "runtime-dependency-prune.js",
    ),
  ).href
);

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-workflow-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function packageDir(nodeModules: string, name: string) {
  return path.join(nodeModules, ...name.split("/"));
}

async function writePackage(
  nodeModules: string,
  name: string,
  version: string,
  declaredName = name,
) {
  const dir = packageDir(nodeModules, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: declaredName, version })}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(dir, "index.js"), "export {};\n", "utf8");
}

test("update workflow removes exact duplicate Pi shrinkwrap dependencies", async () => {
  await withTempDir(async (sourceRoot) => {
    const rootNodeModules = path.join(sourceRoot, "node_modules");
    const piNodeModules = path.join(
      rootNodeModules,
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
    );

    await writePackage(rootNodeModules, "same", "1.0.0");
    await writePackage(rootNodeModules, "@scope/same", "2.0.0");
    await writePackage(rootNodeModules, "different", "2.0.0");
    await writePackage(rootNodeModules, "mismatch", "1.0.0", "wrong-name");

    await writePackage(piNodeModules, "same", "1.0.0");
    await writePackage(piNodeModules, "@scope/same", "2.0.0");
    await writePackage(piNodeModules, "different", "1.0.0");
    await writePackage(piNodeModules, "mismatch", "1.0.0");
    await writePackage(piNodeModules, "only-nested", "1.0.0");

    const result =
      runtimeDependencyPrune.pruneDuplicatePiCodingAgentDependencies(
        sourceRoot,
      );

    assert.deepEqual(result.removed.sort(), ["@scope/same", "same"]);
    assert.equal(fsSync.existsSync(packageDir(piNodeModules, "same")), false);
    assert.equal(
      fsSync.existsSync(packageDir(piNodeModules, "@scope/same")),
      false,
    );
    assert.equal(fsSync.existsSync(path.join(piNodeModules, "@scope")), false);
    assert.equal(
      fsSync.existsSync(packageDir(piNodeModules, "different")),
      true,
    );
    assert.equal(
      fsSync.existsSync(packageDir(piNodeModules, "mismatch")),
      true,
    );
    assert.equal(
      fsSync.existsSync(packageDir(piNodeModules, "only-nested")),
      true,
    );
  });
});
