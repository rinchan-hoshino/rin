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

function compileFixtures(directory: string, kind: "valid" | "invalid") {
  const fixtures = contracts.map((contract, index) => {
    const sourcePath = path
      .join(rootDir, contract.source)
      .replace(/\.ts$/, ".js");
    const specifier = path
      .relative(directory, sourcePath)
      .split(path.sep)
      .join("/");
    const fixture = path.join(directory, `${kind}-${index}.ts`);
    fs.writeFileSync(
      fixture,
      contract[kind].replace(
        "SOURCE",
        specifier.startsWith(".") ? specifier : `./${specifier}`,
      ),
    );
    return { contract, fixture };
  });
  const diagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram(
      fixtures.map(({ fixture }) => fixture),
      {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        types: ["node"],
      },
    ),
  );
  return { diagnostics, fixtures };
}

function compileStandaloneFixture(fixture: string) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-cron-contract-"),
  );
  const file = path.join(directory, "fixture.ts");
  const contract = fs
    .readFileSync(
      path.join(rootDir, "src/core/rin-daemon/cron-contract.ts"),
      "utf8",
    )
    .replace(
      'import type { ThinkingLevel } from "@earendil-works/pi-agent-core";',
      'type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";',
    )
    .replace(
      'import type { RinFrontendIdentity } from "../rin-lib/frontend-identity.js";',
      "type RinFrontendIdentity = { kind?: string; key?: string };",
    )
    .replace(
      /import type \{\n {2}ScheduledTaskSessionMode,\n {2}ScheduledTaskTargetKind,\n\} from "\.\.\/scheduled-task-options\.js";/,
      'type ScheduledTaskSessionMode = "none" | "dedicated";\ntype ScheduledTaskTargetKind = "agent_prompt" | "shell_command";',
    );
  fs.writeFileSync(file, `${contract}\n${fixture}\n`);
  try {
    return ts.getPreEmitDiagnostics(
      ts.createProgram([file], {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        types: [],
      }),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("type-only production modules enforce positive and negative compile contracts", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-type-contract-"),
  );
  try {
    const valid = compileFixtures(directory, "valid");
    assert.deepEqual(valid.diagnostics, []);

    const invalid = compileFixtures(directory, "invalid");
    for (const { contract, fixture } of invalid.fixtures) {
      assert.ok(
        invalid.diagnostics.some(
          (diagnostic) => diagnostic.file?.fileName === fixture,
        ),
        contract.source,
      );
    }

    await Promise.all(
      contracts.map(async (contract) => {
        const runtime = await importBuiltModule(contract.built);
        assert.deepEqual(
          Object.keys(runtime),
          [],
          `${contract.source} runtime surface`,
        );
      }),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cron DTO contract enforces scheduler records without runtime exports", async () => {
  const record =
    '{ id: "task", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", enabled: true, trigger: { runAt: "2026-08-17T01:00:00.000Z" }, session: { mode: "none" }, target: { kind: "agent_prompt", prompt: "hello" }, runCount: 0, running: false }';
  assert.deepEqual(
    compileStandaloneFixture(`const value: CronTaskRecord = ${record};`),
    [],
  );
  assert.ok(
    compileStandaloneFixture(
      `const value: CronTaskRecord = { ...${record}, session: { mode: "invalid" } };`,
    ).length > 0,
  );
  const runtime = await importBuiltModule(
    "dist/core/rin-daemon/cron-contract.js",
  );
  assert.deepEqual(Object.keys(runtime), []);
});
