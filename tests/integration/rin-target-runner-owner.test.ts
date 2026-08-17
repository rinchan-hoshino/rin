import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const runner = await importBuiltModule<
  typeof import("../../src/core/rin-targets/runner.js")
>("dist/core/rin-targets/runner.js");
const store = await importBuiltModule<
  typeof import("../../src/core/rin-targets/store.js")
>("dist/core/rin-targets/store.js");

async function withCommandProbe(
  run: (probe: string, output: string) => Promise<void>,
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-target-runner-owner-"),
  );
  const probe = path.join(root, "probe.sh");
  const output = path.join(root, "argv.txt");
  await fs.writeFile(
    probe,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$RIN_TARGET_PROBE_OUTPUT"\n',
    { mode: 0o755 },
  );
  const previousOutput = process.env.RIN_TARGET_PROBE_OUTPUT;
  process.env.RIN_TARGET_PROBE_OUTPUT = output;
  try {
    await run(probe, output);
  } finally {
    if (previousOutput === undefined)
      delete process.env.RIN_TARGET_PROBE_OUTPUT;
    else process.env.RIN_TARGET_PROBE_OUTPUT = previousOutput;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("target runner strips only wrapper target selectors", () => {
  assert.deepEqual(
    runner.stripTargetWrapperArgs([
      "",
      "status",
      "--target",
      "remote",
      "--json",
      "--target=other",
      " ",
    ]),
    ["status", "--json"],
  );
  assert.deepEqual(runner.stripTargetWrapperArgs(["--target"]), []);
});

test("target runner resolves explicit and default target records", () => {
  const first = store.upsertTarget({
    name: "runner-owner-explicit",
    kind: "container",
    runtime: { kind: "container", engine: "podman", container: "rin" },
  });
  store.setDefaultTarget(first.name);
  assert.equal(
    runner.resolveTargetForName(` ${first.name} `)?.name,
    first.name,
  );
  assert.equal(runner.resolveTargetForName("")?.name, first.name);
  assert.equal(runner.resolveTargetForName("missing-target"), undefined);
});

test("target runner executes container, ssh, and local-user transports with exact argv", async () => {
  await withCommandProbe(async (probe, output) => {
    assert.equal(
      runner.runRinOnTarget(
        {
          name: "container",
          kind: "container",
          runtime: {
            kind: "container",
            engine: probe,
            container: "rin-box",
            user: "bob",
          },
        } as any,
        ["doctor"],
      ),
      0,
    );
    assert.deepEqual((await fs.readFile(output, "utf8")).trim().split("\n"), [
      "exec",
      "-u",
      "bob",
      "rin-box",
      "rin",
      "doctor",
    ]);

    const previousPath = process.env.PATH;
    const sshProbe = path.join(path.dirname(probe), "ssh");
    await fs.copyFile(probe, sshProbe);
    await fs.chmod(sshProbe, 0o755);
    process.env.PATH = `${path.dirname(probe)}:${previousPath || ""}`;
    try {
      assert.equal(
        runner.runRinOnTarget(
          {
            name: "ssh",
            kind: "ssh",
            runtime: {
              kind: "ssh",
              host: "example.invalid",
              user: "rin",
              port: 2222,
              identityFile: "/tmp/key",
              controlPath: "/tmp/control",
            },
          } as any,
          ["versions"],
        ),
        0,
      );
    } finally {
      process.env.PATH = previousPath;
    }
    assert.deepEqual((await fs.readFile(output, "utf8")).trim().split("\n"), [
      "-p",
      "2222",
      "-i",
      "/tmp/key",
      "-o",
      "ControlPath=/tmp/control",
      "rin@example.invalid",
      "rin",
      "versions",
    ]);

    const helper = path.join(path.dirname(probe), "local-helper.mjs");
    await fs.writeFile(
      helper,
      "import fs from 'node:fs'; fs.writeFileSync(process.env.RIN_TARGET_PROBE_OUTPUT, process.argv.slice(2).join('\\n'));",
    );
    const previousEntry = process.argv[1];
    process.argv[1] = helper;
    try {
      assert.equal(
        runner.runRinOnTarget(
          {
            name: "local",
            kind: "local-user",
            runtime: { kind: "local-user", user: "alice" },
          } as any,
          ["status"],
        ),
        0,
      );
    } finally {
      process.argv[1] = previousEntry;
    }
    assert.deepEqual((await fs.readFile(output, "utf8")).trim().split("\n"), [
      "--user",
      "alice",
      "status",
    ]);
  });
});

test("target runner rejects records from removed deployment modes before execution", () => {
  assert.throws(
    () =>
      runner.runRinOnTarget(
        {
          name: "legacy-vm",
          kind: "vm",
          runtime: {
            kind: "command",
            command: "/must-not-run",
            argsBeforeRin: [],
          },
        } as any,
        ["status"],
      ),
    /rin_target_unsupported:vm/,
  );
});

test("target runner surfaces spawn failures and normalizes signal-only exits", async () => {
  assert.throws(
    () =>
      runner.runRinOnTarget(
        {
          name: "missing",
          kind: "container",
          runtime: {
            kind: "container",
            engine: "/missing/rin-probe",
            container: "rin",
          },
        } as any,
        [],
      ),
    /ENOENT/,
  );

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-target-signal-"));
  const signalProbe = path.join(root, "signal-probe.sh");
  await fs.writeFile(signalProbe, "#!/bin/sh\nkill -TERM $$\n", {
    mode: 0o755,
  });
  try {
    assert.equal(
      runner.runRinOnTarget(
        {
          name: "signal",
          kind: "container",
          runtime: {
            kind: "container",
            engine: signalProbe,
            container: "rin",
          },
        } as any,
        [],
      ),
      1,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
