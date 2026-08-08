import assert from "node:assert/strict";
import test from "node:test";

import { tryRunExtensionCommandCli } from "../../dist/core/rin/extension-command-adapter.js";

function harness(commandExists = true, promptError = false) {
  let ui: any;
  let prompted = "";
  let disposed = false;
  let exitCode: number | undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  return {
    options: {
      argv: ["usage", "--days", "7"],
      stdout: {
        write: (value: unknown) => (stdout.push(String(value)), true),
      } as any,
      stderr: {
        write: (value: unknown) => (stderr.push(String(value)), true),
      } as any,
      dependencies: {
        resolveProfile: () => ({ cwd: "/work", agentDir: "/agent" }),
        loadSessionManager: async () => ({
          SessionManager: { inMemory: () => ({}) },
        }),
        createSession: async () => ({
          session: {
            extensionRunner: {
              getCommand: () => (commandExists ? { name: "usage" } : undefined),
              setUIContext(next: any) {
                ui = next;
              },
            },
            async prompt(value: string) {
              prompted = value;
              if (promptError) throw new Error("usage failed");
              ui.notify("Codex usage history");
              ui.notify("");
            },
          },
          runtime: {
            async dispose() {
              disposed = true;
            },
          },
        }),
      },
    } as any,
    finish() {
      exitCode = process.exitCode;
      process.exitCode = originalExitCode;
      return { stdout, stderr, prompted, disposed, exitCode };
    },
  };
}

test("extension command adapter exposes Pi extension commands as rin CLI commands", async () => {
  const run = harness(true);
  assert.equal(await tryRunExtensionCommandCli(run.options), true);
  assert.deepEqual(run.finish(), {
    stdout: ["Codex usage history\n"],
    stderr: [],
    prompted: "/usage --days 7",
    disposed: true,
    exitCode: undefined,
  });
});

test("extension command adapter leaves unknown commands to Rin parsing", async () => {
  const run = harness(false);
  assert.equal(await tryRunExtensionCommandCli(run.options), false);
  assert.deepEqual(run.finish(), {
    stdout: [],
    stderr: [],
    prompted: "",
    disposed: true,
    exitCode: undefined,
  });
});

test("extension command adapter reports extension command failures", async () => {
  const run = harness(true, true);
  assert.equal(await tryRunExtensionCommandCli(run.options), true);
  const result = run.finish();
  assert.deepEqual(result.stderr, ["usage failed\n"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.disposed, true);
});

test("extension command adapter ignores an empty command without loading resources", async () => {
  assert.equal(await tryRunExtensionCommandCli({ argv: [] }), false);
});

test("extension command adapter ignores wrapper flags", async () => {
  assert.equal(
    await tryRunExtensionCommandCli({
      argv: ["--help"],
      stdout: process.stdout,
      stderr: process.stderr,
      dependencies: {} as any,
    }),
    false,
  );
});
