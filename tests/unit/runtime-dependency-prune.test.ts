import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { importBuiltModule } from "../support/import-built-module.js";

const runtimeDependencyPrune = await importBuiltModule<
  typeof import("../../src/core/rin-install/runtime-dependency-prune.js")
>("dist/core/rin-install/runtime-dependency-prune.js");

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

test("dependency prune tolerates missing trees and logs only removals", async () => {
  await withTempDir(async (sourceRoot) => {
    assert.deepEqual(
      runtimeDependencyPrune.pruneDuplicatePiCodingAgentDependencies(
        sourceRoot,
      ),
      { removed: [] },
    );
    const logFile = path.join(sourceRoot, "prune.log");
    runtimeDependencyPrune.appendDependencyPruneLog(logFile, { removed: [] });
    assert.equal(fsSync.existsSync(logFile), false);

    runtimeDependencyPrune.appendDependencyPruneLog(logFile, {
      removed: ["one", "@scope/two"],
    });
    assert.equal(
      await fs.readFile(logFile, "utf8"),
      "rin: pruned duplicate @earendil-works/pi-coding-agent dependencies (2): one, @scope/two\n",
    );
  });
});

test("dependency prune refuses symlinked package trees", async () => {
  await withTempDir(async (sourceRoot) => {
    const external = path.join(sourceRoot, "external");
    await fs.mkdir(external);
    await fs.symlink(external, path.join(sourceRoot, "node_modules"));
    assert.deepEqual(
      runtimeDependencyPrune.pruneDuplicatePiCodingAgentDependencies(
        sourceRoot,
      ),
      { removed: [] },
    );
  });

  await withTempDir(async (sourceRoot) => {
    const piRoot = path.join(
      sourceRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    const external = path.join(sourceRoot, "external");
    await fs.mkdir(piRoot, { recursive: true });
    await fs.mkdir(external);
    await fs.symlink(external, path.join(piRoot, "node_modules"));
    assert.deepEqual(
      runtimeDependencyPrune.pruneDuplicatePiCodingAgentDependencies(
        sourceRoot,
      ),
      { removed: [] },
    );
  });
});

test("dependency prune ignores invalid package metadata and hidden entries", async () => {
  await withTempDir(async (sourceRoot) => {
    const rootNodeModules = path.join(sourceRoot, "node_modules");
    const piNodeModules = path.join(
      rootNodeModules,
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
    );
    await fs.mkdir(path.join(piNodeModules, ".cache"), { recursive: true });
    await fs.writeFile(path.join(piNodeModules, "plain-file"), "not a dir");
    await fs.mkdir(path.join(piNodeModules, "invalid"));
    await fs.writeFile(
      path.join(piNodeModules, "invalid", "package.json"),
      "not json",
    );
    await fs.mkdir(path.join(piNodeModules, "nameless"));
    await fs.writeFile(
      path.join(piNodeModules, "nameless", "package.json"),
      JSON.stringify({ name: "", version: "1.0.0" }),
    );
    await writePackage(piNodeModules, "missing-root", "1.0.0");

    assert.deepEqual(
      runtimeDependencyPrune.pruneDuplicatePiCodingAgentDependencies(
        sourceRoot,
      ),
      { removed: [] },
    );
  });
});

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
