import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runInstallToTuiSmokeInContainer } from "../support/install-to-tui-harness.js";

async function writeFakeDocker(dir: string, script: string) {
  const executable = path.join(dir, "docker");
  await fs.writeFile(executable, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

test("install-to-TUI container wrapper distinguishes runtime and smoke failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-fake-docker-"));
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath || ""}`;
  try {
    await writeFakeDocker(
      dir,
      'if [ "$1" = "info" ]; then exit 0; fi\necho inner-smoke-failed >&2\nexit 17',
    );
    await assert.rejects(
      runInstallToTuiSmokeInContainer({ failOnUnavailableRuntime: false }),
      (error: any) => {
        assert.match(String(error?.stderr), /inner-smoke-failed/);
        return true;
      },
    );

    await writeFakeDocker(
      dir,
      'if [ "$1" = "info" ]; then echo runtime-unavailable >&2; exit 19; fi\nexit 0',
    );
    const unavailable = await runInstallToTuiSmokeInContainer({
      failOnUnavailableRuntime: false,
    });
    assert.match(
      String(unavailable.skipped),
      /runtime-unavailable|missing docker or podman/,
    );
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
