import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { importBuiltModule } from "../support/import-built-module.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const contracts = [
  {
    source: "src/core/rin-lib/capability-types.ts",
    built: "dist/core/rin-lib/capability-types.js",
    valid:
      'import type { RinCapabilityMode } from "SOURCE"; const value: RinCapabilityMode = "rpc";',
    invalid:
      'import type { RinCapabilityMode } from "SOURCE"; const value: RinCapabilityMode = "invalid";',
  },
  {
    source: "src/core/rin-frontend-sdk/types.ts",
    built: "dist/core/rin-frontend-sdk/types.js",
    valid:
      'import type { RinFrontendStatusPhase } from "SOURCE"; const value: RinFrontendStatusPhase = "working";',
    invalid:
      'import type { RinFrontendStatusPhase } from "SOURCE"; const value: RinFrontendStatusPhase = "invalid";',
  },
  {
    source: "src/core/rin-frontend-sdk/frontend-surface.ts",
    built: "dist/core/rin-frontend-sdk/frontend-surface.js",
    valid:
      'import type { FrontendStatusEvent } from "SOURCE"; const value: FrontendStatusEvent = { type: "status", level: "info", text: "ok" };',
    invalid:
      'import type { FrontendStatusEvent } from "SOURCE"; const value: FrontendStatusEvent = { type: "status", level: "invalid", text: "no" };',
  },
  {
    source: "src/core/rin-lib/pi-passthrough.ts",
    built: "dist/core/rin-lib/pi-passthrough.js",
    valid:
      'import type { RinPiPassthroughOptions } from "SOURCE"; const value: RinPiPassthroughOptions = { piStartupOptions: { model: "demo" } };',
    invalid:
      'import type { RinPiPassthroughOptions } from "SOURCE"; const value: RinPiPassthroughOptions = { piStartupOptions: "invalid" };',
  },
  {
    source: "src/core/rin-lib/rpc-types.ts",
    built: "dist/core/rin-lib/rpc-types.js",
    valid:
      'import type { RinRpcCommandType } from "SOURCE"; const value: RinRpcCommandType = "prompt";',
    invalid:
      'import type { RinRpcCommandType } from "SOURCE"; const value: RinRpcCommandType = "invalid";',
  },
  {
    source: "src/core/memory/transcript-types.ts",
    built: "dist/core/memory/transcript-types.js",
    valid:
      'import type { TranscriptFileState } from "SOURCE"; const value: TranscriptFileState = { archivePath: "a", mtimeMs: 1, size: 2 };',
    invalid:
      'import type { TranscriptFileState } from "SOURCE"; const value: TranscriptFileState = { archivePath: "a", mtimeMs: 1 };',
  },
] as const;

function compileFixture(
  directory: string,
  contract: (typeof contracts)[number],
  text: string,
) {
  const sourcePath = path
    .join(rootDir, contract.source)
    .replace(/\.ts$/, ".js");
  const specifier = path
    .relative(directory, sourcePath)
    .split(path.sep)
    .join("/");
  const fixture = path.join(directory, "fixture.ts");
  fs.writeFileSync(
    fixture,
    text.replace(
      "SOURCE",
      specifier.startsWith(".") ? specifier : `./${specifier}`,
    ),
  );
  return ts.getPreEmitDiagnostics(
    ts.createProgram([fixture], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ["node"],
    }),
  );
}

test("type-only production modules enforce positive and negative compile contracts", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-type-contract-"),
  );
  try {
    for (const contract of contracts) {
      assert.deepEqual(
        compileFixture(directory, contract, contract.valid),
        [],
        contract.source,
      );
      assert.ok(
        compileFixture(directory, contract, contract.invalid).length > 0,
        contract.source,
      );
      const runtime = await importBuiltModule(contract.built);
      assert.deepEqual(
        Object.keys(runtime),
        [],
        `${contract.source} runtime surface`,
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
