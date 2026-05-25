import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const workerMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "worker.js"))
    .href
);

test("daemon worker starts from a temporary session manager with a durable target dir", () => {
  const calls: string[] = [];
  const sessionManager = workerMod.createTemporaryWorkerSessionManager(
    {
      inMemory(cwd: string) {
        calls.push(`inMemory:${cwd}`);
        return {
          persist: false,
          sessionDir: "",
          sessionFile: undefined,
          isPersisted() {
            return this.persist;
          },
          getSessionFile() {
            return this.sessionFile;
          },
          getSessionDir() {
            return this.sessionDir;
          },
        };
      },
    },
    { cwd: "/tmp/project", sessionDir: "/tmp/agent/sessions" },
  );

  assert.deepEqual(calls, ["inMemory:/tmp/project"]);
  assert.equal(sessionManager.isPersisted(), false);
  assert.equal(sessionManager.getSessionFile(), undefined);
  assert.equal(sessionManager.getSessionDir(), "/tmp/agent/sessions");
});
