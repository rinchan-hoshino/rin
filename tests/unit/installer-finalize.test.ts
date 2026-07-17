import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const finalize = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "finalize.js"),
  ).href
);

type LauncherCall = {
  userName: string;
  installDir: string;
  elevated: boolean;
};

function createLauncherDeps(options: { metadata?: any } = {}) {
  const calls: LauncherCall[] = [];
  return {
    calls,
    deps: {
      homeForUser: (userName: string) => `/home/${userName}`,
      findSystemUser: (userName: string) => ({ name: userName, gid: 1000 }),
      readJsonFile: () => options.metadata || {},
      launcherMetadataPathForUser: (userName: string) =>
        `/home/${userName}/.config/rin/launcher.json`,
      writeLaunchersForUser: (
        userName: string,
        installDir: string,
        homeForUser: (userName: string) => string,
        writeOptions: { elevated?: boolean } = {},
      ) => {
        calls.push({
          userName,
          installDir,
          elevated: Boolean(writeOptions.elevated),
        });
        return {
          rinPath: `${homeForUser(userName)}/.local/bin/rin`,
          rinInstallPath: `${homeForUser(userName)}/.local/bin/rin-install`,
        };
      },
    },
  };
}

test("managed runtime transition attempts restart when stop reports failure", async () => {
  const events: string[] = [];
  await assert.rejects(
    finalize.runManagedRuntimeTransition({
      stop: async () => {
        events.push("stop");
        throw new Error("stop incomplete");
      },
      mutate: async () => events.push("mutate"),
      activate: async () => events.push("activate"),
      restart: async () => events.push("restart"),
    }),
    /stop incomplete/,
  );
  assert.deepEqual(events, ["stop", "restart"]);
});

test("managed runtime transition restarts the current runtime after mutation failure", async () => {
  const events: string[] = [];
  const failure = new Error("migration failed");
  await assert.rejects(
    finalize.runManagedRuntimeTransition({
      stop: async () => events.push("stop"),
      mutate: async () => {
        events.push("mutate");
        throw failure;
      },
      activate: async () => events.push("activate"),
      restart: async () => events.push("restart"),
    }),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(events, ["stop", "mutate", "restart"]);
});

test("managed runtime transition restarts after activation failure", async () => {
  const events: string[] = [];
  await assert.rejects(
    finalize.runManagedRuntimeTransition({
      stop: async () => events.push("stop"),
      mutate: async () => {
        events.push("mutate");
        return "migrated";
      },
      activate: async () => {
        events.push("activate");
        throw new Error("activation failed");
      },
      restart: async () => events.push("restart"),
    }),
    /activation failed/,
  );
  assert.deepEqual(events, ["stop", "mutate", "activate", "restart"]);
});

test("managed runtime transition does not loop when restart itself fails", async () => {
  const events: string[] = [];
  await assert.rejects(
    finalize.runManagedRuntimeTransition({
      stop: async () => events.push("stop"),
      mutate: async () => {
        events.push("mutate");
        return "migrated";
      },
      activate: async () => events.push("activate"),
      restart: async () => {
        events.push("restart");
        throw new Error("restart failed");
      },
    }),
    /restart failed/,
  );
  assert.deepEqual(events, ["stop", "mutate", "activate", "restart"]);
});

test("managed runtime transition reports both mutation and recovery failures", async () => {
  const mutationFailure = new Error("migration failed");
  const restartFailure = new Error("restart failed");
  await assert.rejects(
    finalize.runManagedRuntimeTransition({
      stop: async () => {},
      mutate: async () => {
        throw mutationFailure;
      },
      activate: async () => {},
      restart: async () => {
        throw restartFailure;
      },
    }),
    (error: any) =>
      error instanceof AggregateError &&
      error.errors[0] === mutationFailure &&
      error.errors[1] === restartFailure,
  );
});

test("core update launcher refresh rewrites the target user's launchers", () => {
  const { calls, deps } = createLauncherDeps();
  const result = finalize.refreshCoreUpdateLaunchers(
    {
      currentUser: "rin",
      targetUser: "rin",
      installDir: "/home/rin/.rin",
      elevated: false,
    },
    deps,
  );

  assert.deepEqual(calls, [
    { userName: "rin", installDir: "/home/rin/.rin", elevated: false },
  ]);
  assert.equal(result.currentLaunchers, result.targetLaunchers);
});

test("core update launcher refresh avoids unrelated current-user launchers", () => {
  const { calls, deps } = createLauncherDeps();
  const result = finalize.refreshCoreUpdateLaunchers(
    {
      currentUser: "admin",
      targetUser: "service",
      installDir: "/srv/rin",
      elevated: true,
    },
    deps,
  );

  assert.deepEqual(calls, [
    { userName: "service", installDir: "/srv/rin", elevated: true },
  ]);
  assert.equal(result.currentLaunchers, null);
});

test("core update launcher refresh preserves a current-user launcher bound to the target", () => {
  const { calls, deps } = createLauncherDeps({
    metadata: { defaultTargetUser: "service", defaultInstallDir: "/srv/rin" },
  });
  const result = finalize.refreshCoreUpdateLaunchers(
    {
      currentUser: "admin",
      targetUser: "service",
      installDir: "/srv/rin",
      elevated: true,
    },
    deps,
  );

  assert.deepEqual(calls, [
    { userName: "service", installDir: "/srv/rin", elevated: true },
    { userName: "admin", installDir: "/srv/rin", elevated: false },
  ]);
  assert.equal(result.currentLaunchers.rinPath, "/home/admin/.local/bin/rin");
});
