import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const loader = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "runtime-module-loader.js"),
  ).href
);

test("runtime module loader imports TypeScript and JavaScript extensions", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-runtime-module-loader-"),
  );
  try {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    const tsPath = path.join(tempDir, "extension.ts");
    const jsPath = path.join(tempDir, "extension.js");
    fs.writeFileSync(
      tsPath,
      'const value: { kind: string } = { kind: "typescript" }; export default value;\n',
    );
    fs.writeFileSync(jsPath, 'export default { kind: "javascript" };\n');

    assert.deepEqual(await loader.importRuntimeModule(tsPath), {
      kind: "typescript",
    });
    assert.deepEqual((await loader.importRuntimeModule(jsPath)).default, {
      kind: "javascript",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
