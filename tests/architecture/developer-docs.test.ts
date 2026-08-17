import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const developerDir = path.join(rootDir, "docs", "developer");
const architecture = fs.readFileSync(
  path.join(developerDir, "architecture.md"),
  "utf8",
);
const testing = fs.readFileSync(path.join(developerDir, "testing.md"), "utf8");
const developerIndex = fs.readFileSync(
  path.join(developerDir, "README.md"),
  "utf8",
);
const releasing = fs.readFileSync(
  path.join(developerDir, "releasing.md"),
  "utf8",
);

const permanentTestLayers = [
  "unit",
  "acceptance",
  "property",
  "qa",
  "torture",
  "regression",
  "integration",
  "system",
  "architecture",
];

function developerMarkdownFiles() {
  return fs
    .readdirSync(developerDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

test("developer architecture routes test taxonomy to its canonical owner", () => {
  assert.match(architecture, /thin assembly wrappers/);
  assert.match(architecture, /test taxonomy[\s\S]*`testing\.md`/);

  for (const layer of permanentTestLayers) {
    const marker = `tests/${layer}`;
    assert.match(testing, new RegExp(`\\b${marker}\\b`), marker);
    assert.equal(architecture.includes(marker), false, marker);
  }
});

test("developer index routes release operations to one current procedure", () => {
  const releaseProcedureOwners = developerMarkdownFiles().filter((name) =>
    fs
      .readFileSync(path.join(developerDir, name), "utf8")
      .includes("release:local -- --channel stable"),
  );
  assert.deepEqual(releaseProcedureOwners, ["releasing.md"]);
  assert.match(
    developerIndex,
    /`releasing\.md`: current channel contract and operator workflow/,
  );

  const topicMap = developerIndex.slice(
    developerIndex.indexOf("## Topic map"),
    developerIndex.indexOf("## Maintainer rule of thumb"),
  );
  for (const match of topicMap.matchAll(/`([^`]+\.md)`/g)) {
    assert.equal(
      fs.existsSync(path.join(developerDir, match[1])),
      true,
      match[1],
    );
  }
});

test("release procedure delegates the exact bootstrap payload to the exporter", () => {
  assert.match(
    releasing,
    /`scripts\/release\/export-bootstrap-branch\.ts` owns the exact payload/,
  );
  assert.match(releasing, /Do not maintain a second file list/);
});
