import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
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
const fsUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "fs-utils.js"),
  ).href
);
const persist = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "persist.js"))
    .href
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

test("managed runtime transition rolls back migration before recovery restart", async () => {
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
      recover: async () => events.push("rollback"),
      restart: async () => events.push("restart"),
    }),
    /activation failed/,
  );
  assert.deepEqual(events, [
    "stop",
    "mutate",
    "activate",
    "rollback",
    "restart",
  ]);
});

test("managed runtime transition commits migration after activation", async () => {
  const events: string[] = [];
  await finalize.runManagedRuntimeTransition({
    stop: async () => events.push("stop"),
    mutate: async () => {
      events.push("mutate");
      return "migrated";
    },
    activate: async () => {
      events.push("activate");
      return "activated";
    },
    commit: async () => events.push("commit"),
    restart: async () => events.push("restart"),
  });
  assert.deepEqual(events, ["stop", "mutate", "activate", "commit", "restart"]);
});

test("current-release replacement recovers runtime, rollback state, and user data after commit failure", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-finalize-reinstall-"),
  );
  const releasesRoot = path.join(installDir, "app", "releases");
  const releaseRoot = path.join(releasesRoot, "1.0.0");
  const previousReleaseRoot = path.join(releasesRoot, "0.9.0");
  const stagedReleaseRoot = path.join(releasesRoot, ".1.0.0.reinstall-test");
  const managedRelativePath = path.join("dist", "app", "rin", "main.js");
  const settingsPath = path.join(installDir, "agent", "settings.json");
  await fs.mkdir(path.dirname(path.join(releaseRoot, managedRelativePath)), {
    recursive: true,
  });
  await fs.mkdir(
    path.dirname(path.join(previousReleaseRoot, managedRelativePath)),
    { recursive: true },
  );
  await fs.mkdir(
    path.dirname(path.join(stagedReleaseRoot, managedRelativePath)),
    { recursive: true },
  );
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(
    path.join(releaseRoot, managedRelativePath),
    "corrupted current runtime\n",
  );
  await fs.writeFile(
    path.join(previousReleaseRoot, managedRelativePath),
    "previous runtime\n",
  );
  await fs.writeFile(
    path.join(stagedReleaseRoot, managedRelativePath),
    "restored current runtime\n",
  );
  await fs.writeFile(settingsPath, '{"owner":"unchanged"}\n');
  await fs.symlink(releaseRoot, path.join(installDir, "app", "current"));

  const currentRelease = {
    channel: "stable",
    version: "1.0.0",
    branch: "stable",
    ref: "v1.0.0",
    sourceLabel: "stable 1.0.0",
    archiveUrl: "https://example.invalid/rin-1.0.0.tgz",
    installedAt: "2026-07-01T00:00:00.000Z",
  };
  const previousRelease = {
    channel: "stable",
    version: "0.9.0",
    branch: "stable",
    ref: "v0.9.0",
    sourceLabel: "stable 0.9.0",
    archiveUrl: "https://example.invalid/rin-0.9.0.tgz",
    installedAt: "2026-06-01T00:00:00.000Z",
  };
  let manifest: any = {
    currentRelease: {
      name: "1.0.0",
      path: releaseRoot,
      release: currentRelease,
    },
    previousRelease: {
      name: "0.9.0",
      path: previousReleaseRoot,
      release: previousRelease,
    },
  };
  const migrationOptions = { migrationRuntimeRoot: stagedReleaseRoot };
  const replacement = finalize.createInstalledRuntimeReplacementLifecycle({
    releaseRoot,
    stagedReleaseRoot,
    migrationOptions,
  });

  await assert.rejects(
    finalize.runManagedRuntimeTransition({
      stop: async () => {},
      mutate: async () => {},
      activate: async () => {
        assert.equal(replacement.activate(), true);
        persist.reconcileInstallerManifest(
          {
            targetUser: "rin",
            installDir,
            release: currentRelease,
            currentReleaseName: "1.0.0",
            currentReleaseRoot: releaseRoot,
            previousReleaseName: "1.0.0",
            previousReleaseRoot: releaseRoot,
          },
          {
            findSystemUser: () => ({ name: "rin", gid: 1000 }),
            ensureDir: () => {},
            readInstallerJson: () => manifest,
            writeJsonFileWithPrivilege: (file: string, value: any) => {
              if (file === path.join(installDir, "installer.json")) {
                manifest = value;
              }
            },
            writeJsonFile: (file: string, value: any) => {
              if (file === path.join(installDir, "installer.json")) {
                manifest = value;
              }
            },
            runPrivileged: () => {
              throw new Error("unexpected privileged write");
            },
          },
        );
      },
      commit: async () => {
        throw new Error("injected migration commit failure");
      },
      recover: async () => replacement.rollback(),
      restart: async () => {},
    }),
    /injected migration commit failure/,
  );

  assert.equal(migrationOptions.migrationRuntimeRoot, releaseRoot);
  assert.equal(
    await fs.readFile(path.join(releaseRoot, managedRelativePath), "utf8"),
    "corrupted current runtime\n",
  );
  assert.equal(
    await fs.readFile(settingsPath, "utf8"),
    '{"owner":"unchanged"}\n',
  );
  assert.equal(manifest.currentRelease.name, "1.0.0");
  assert.equal(manifest.previousRelease.name, "0.9.0");
  assert.deepEqual((await fs.readdir(releasesRoot)).sort(), ["0.9.0", "1.0.0"]);

  fsUtils.switchInstalledCurrentRelease(
    installDir,
    manifest.previousRelease.name,
    "rin",
    false,
    { findSystemUser: () => null },
  );
  assert.equal(
    await fs.realpath(path.join(installDir, "app", "current")),
    previousReleaseRoot,
  );

  await fs.rm(installDir, { recursive: true, force: true });
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
