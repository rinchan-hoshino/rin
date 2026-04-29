import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(entryPath));
    } else if (/\.(?:ts|mts|cts)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

test("runtime and installer TypeScript sources do not select PowerShell bootstrap scripts", () => {
  const sourceRoot = path.join(rootDir, "src");
  const forbidden =
    /\b(?:pwsh|powershell(?:\.exe)?)\b|(?:install|update|bootstrap-entrypoint)\.ps1/i;
  const offenders = listSourceFiles(sourceRoot)
    .map((file) => {
      const content = fs.readFileSync(file, "utf8");
      return forbidden.test(content) ? path.relative(rootDir, file) : "";
    })
    .filter(Boolean);

  assert.deepEqual(offenders, []);
});
