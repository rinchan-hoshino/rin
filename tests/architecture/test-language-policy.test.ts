import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const testsDir = path.join(rootDir, "tests");
const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/u;

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(entryPath);
      if (entry.isFile()) return [entryPath];
      return [];
    }),
  );
  return files.flat();
}

test("repository tests avoid CJK characters in source fixtures", async () => {
  const files = await listFiles(testsDir);
  const offenders: string[] = [];

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    if (cjkPattern.test(source)) {
      offenders.push(path.relative(rootDir, file));
    }
  }

  assert.deepEqual(offenders, []);
});

test("repository-owned source uses TypeScript instead of mjs or cjs", async () => {
  const sourceDirectories = ["src", "scripts", "tests"];
  const files = (
    await Promise.all(
      sourceDirectories.map((directory) =>
        listFiles(path.join(rootDir, directory)),
      ),
    )
  ).flat();

  assert.deepEqual(
    files
      .filter((file) => /\.(?:mjs|cjs)$/u.test(file))
      .map((file) => path.relative(rootDir, file))
      .sort(),
    [],
  );
});
