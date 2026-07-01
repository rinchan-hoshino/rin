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
