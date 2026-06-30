import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);

function readPackageJson() {
  return JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
  );
}

test("runtime dependencies do not include pure TypeScript declaration packages", () => {
  const packageJson = readPackageJson();
  assert.deepEqual(
    Object.keys(packageJson.dependencies || {}).filter((name) =>
      name.startsWith("@types/"),
    ),
    [],
  );
  assert.equal(typeof packageJson.devDependencies?.["@types/jsdom"], "string");
  assert.equal(
    typeof packageJson.devDependencies?.["@types/turndown"],
    "string",
  );
});
