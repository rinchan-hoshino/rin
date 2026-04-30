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
const updateTargets = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "update-targets.js"),
  ).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-targets-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("discoverInstalledTargets scans manifest, launcher, systemd, and launchd homes deterministically", async () => {
  await withTempDir(async (dir) => {
    const homeRoot = path.join(dir, "home");
    const usersRoot = path.join(dir, "Users");
    const aliceHome = path.join(homeRoot, "alice");
    const bobHome = path.join(homeRoot, "bob");
    const carolHome = path.join(usersRoot, "carol");
    const danaHome = path.join(homeRoot, "dana");
    const eveHome = path.join(homeRoot, "eve");
    const frankHome = path.join(homeRoot, "frank");
    const graceHome = path.join(usersRoot, "grace");
    const heidiHome = path.join(homeRoot, "heidi");

    await fs.mkdir(path.join(aliceHome, ".rin"), { recursive: true });
    await fs.writeFile(
      path.join(aliceHome, ".rin", "installer.json"),
      JSON.stringify({
        targetUser: "alice",
        installDir: "/srv/rin-alice",
      }),
      "utf8",
    );
    await fs.mkdir(path.join(aliceHome, ".config", "systemd", "user"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        aliceHome,
        ".config",
        "systemd",
        "user",
        "rin-daemon-alice.service",
      ),
      "Environment=RIN_DIR=/srv/rin-alice\n",
      "utf8",
    );

    await fs.mkdir(path.join(bobHome, ".rin", "config"), { recursive: true });
    await fs.writeFile(
      path.join(bobHome, ".rin", "config", "installer.json"),
      JSON.stringify({ targetUser: "bob" }),
      "utf8",
    );

    await fs.mkdir(path.join(carolHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        carolHome,
        "Library",
        "LaunchAgents",
        "com.rin.daemon.carol.plist",
      ),
      [
        "<plist>",
        "  <dict>",
        "    <key>RIN_DIR</key>",
        "    <string>/Users/carol/.rin-managed</string>",
        "  </dict>",
        "</plist>",
      ].join("\n"),
      "utf8",
    );

    await fs.mkdir(path.join(danaHome, ".config", "systemd", "user"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(danaHome, ".config", "systemd", "user", "rin-daemon.service"),
      `Environment=RIN_DIR=${path.join(danaHome, ".rin")}\nExecStart=node daemon.js\n`,
      "utf8",
    );

    await fs.mkdir(path.join(eveHome, ".rin"), { recursive: true });
    await fs.writeFile(
      path.join(eveHome, ".rin", "installer.json"),
      JSON.stringify({
        targetUser: "eve",
        installDir: "/opt/rin-eve",
      }),
      "utf8",
    );

    await fs.mkdir(path.join(frankHome, ".config", "rin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(frankHome, ".config", "rin", "install.json"),
      JSON.stringify({
        defaultTargetUser: "frank-daemon",
        defaultInstallDir: "/opt/rin-frank",
      }),
      "utf8",
    );

    await fs.mkdir(
      path.join(graceHome, "Library", "Application Support", "rin"),
      {
        recursive: true,
      },
    );
    await fs.writeFile(
      path.join(
        graceHome,
        "Library",
        "Application Support",
        "rin",
        "install.json",
      ),
      JSON.stringify({
        defaultTargetUser: "grace-daemon",
        defaultInstallDir: "/Users/grace/.rin-managed",
      }),
      "utf8",
    );

    await fs.mkdir(path.join(heidiHome, ".rin"), { recursive: true });
    await fs.writeFile(
      path.join(heidiHome, ".rin", "installer.json"),
      JSON.stringify({
        targetUser: "heidi",
        installDir: "/opt/rin-heidi-manifest",
      }),
      "utf8",
    );
    await fs.mkdir(path.join(heidiHome, ".config", "rin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(heidiHome, ".config", "rin", "install.json"),
      JSON.stringify({
        defaultTargetUser: "heidi",
        defaultInstallDir: "/opt/rin-heidi-launcher",
      }),
      "utf8",
    );

    const discovered = updateTargets.discoverInstalledTargets([
      homeRoot,
      usersRoot,
    ]);

    assert.deepEqual(discovered, [
      {
        targetUser: "alice",
        installDir: "/srv/rin-alice",
        ownerHome: aliceHome,
        source: "manifest",
      },
      {
        targetUser: "bob",
        installDir: path.join(bobHome, ".rin"),
        ownerHome: bobHome,
        source: "manifest",
      },
      {
        targetUser: "carol",
        installDir: "/Users/carol/.rin-managed",
        ownerHome: carolHome,
        source: "launchd",
      },
      {
        targetUser: "eve",
        installDir: "/opt/rin-eve",
        ownerHome: eveHome,
        source: "manifest",
      },
      {
        targetUser: "frank-daemon",
        installDir: "/opt/rin-frank",
        ownerHome: frankHome,
        source: "launcher",
      },
      {
        targetUser: "grace-daemon",
        installDir: "/Users/grace/.rin-managed",
        ownerHome: graceHome,
        source: "launcher",
      },
      {
        targetUser: "heidi",
        installDir: "/opt/rin-heidi-launcher",
        ownerHome: heidiHome,
        source: "launcher",
      },
      {
        targetUser: "heidi",
        installDir: "/opt/rin-heidi-manifest",
        ownerHome: heidiHome,
        source: "manifest",
      },
    ]);
  });
});

test("discoverInstalledTargets dedupes identical targets with explicit source precedence", async () => {
  await withTempDir(async (dir) => {
    const homeRoot = path.join(dir, "home");
    const ivanHome = path.join(homeRoot, "ivan");
    const judyHome = path.join(homeRoot, "judy");
    const malloryHome = path.join(homeRoot, "mallory");

    await fs.mkdir(path.join(ivanHome, ".rin"), { recursive: true });
    await fs.writeFile(
      path.join(ivanHome, ".rin", "installer.json"),
      JSON.stringify({
        targetUser: "ivan",
        installDir: "/srv/rin-ivan",
      }),
      "utf8",
    );
    await fs.mkdir(path.join(ivanHome, ".config", "rin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(ivanHome, ".config", "rin", "install.json"),
      JSON.stringify({
        defaultTargetUser: "ivan",
        defaultInstallDir: "/srv/rin-ivan",
      }),
      "utf8",
    );
    await fs.mkdir(path.join(ivanHome, ".config", "systemd", "user"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        ivanHome,
        ".config",
        "systemd",
        "user",
        "rin-daemon-ivan.service",
      ),
      "Environment=RIN_DIR=/srv/rin-ivan\n",
      "utf8",
    );

    await fs.mkdir(path.join(judyHome, ".config", "rin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(judyHome, ".config", "rin", "install.json"),
      JSON.stringify({
        defaultTargetUser: "judy",
        defaultInstallDir: "/srv/rin-judy",
      }),
      "utf8",
    );
    await fs.mkdir(path.join(judyHome, ".config", "systemd", "user"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        judyHome,
        ".config",
        "systemd",
        "user",
        "rin-daemon-judy.service",
      ),
      "Environment=RIN_DIR=/srv/rin-judy\n",
      "utf8",
    );

    await fs.mkdir(path.join(malloryHome, ".config", "systemd", "user"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        malloryHome,
        ".config",
        "systemd",
        "user",
        "rin-daemon-mallory.service",
      ),
      "Environment=RIN_DIR=/srv/rin-mallory\n",
      "utf8",
    );
    await fs.mkdir(path.join(malloryHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        malloryHome,
        "Library",
        "LaunchAgents",
        "com.rin.daemon.mallory.plist",
      ),
      [
        "<plist>",
        "  <dict>",
        "    <key>RIN_DIR</key>",
        "    <string>/srv/rin-mallory</string>",
        "  </dict>",
        "</plist>",
      ].join("\n"),
      "utf8",
    );

    assert.deepEqual(updateTargets.discoverInstalledTargets([homeRoot]), [
      {
        targetUser: "ivan",
        installDir: "/srv/rin-ivan",
        ownerHome: ivanHome,
        source: "manifest",
      },
      {
        targetUser: "judy",
        installDir: "/srv/rin-judy",
        ownerHome: judyHome,
        source: "launcher",
      },
      {
        targetUser: "mallory",
        installDir: "/srv/rin-mallory",
        ownerHome: malloryHome,
        source: "systemd",
      },
    ]);
  });
});

test("discoverInstalledTargets ignores invalid managed entries and non-file lookalikes", async () => {
  await withTempDir(async (dir) => {
    const homeRoot = path.join(dir, "home");
    const oscarHome = path.join(homeRoot, "oscar");

    await fs.mkdir(path.join(oscarHome, ".rin"), { recursive: true });
    await fs.writeFile(
      path.join(oscarHome, ".rin", "installer.json"),
      JSON.stringify({ targetUser: "", installDir: "" }),
      "utf8",
    );
    await fs.mkdir(
      path.join(
        oscarHome,
        ".config",
        "systemd",
        "user",
        "rin-daemon-oscar.service",
      ),
      {
        recursive: true,
      },
    );
    await fs.writeFile(
      path.join(oscarHome, ".config", "systemd", "user", "rin-daemon.service"),
      "Environment=RIN_DIR=\n",
      "utf8",
    );
    await fs.mkdir(path.join(oscarHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        oscarHome,
        "Library",
        "LaunchAgents",
        "com.rin.daemon.oscar.plist",
      ),
      [
        "<plist>",
        "  <dict>",
        "    <key>RIN_DIR</key>",
        "    <string>/srv/rin-oscar</string>",
        "  </dict>",
        "</plist>",
      ].join("\n"),
      "utf8",
    );

    assert.deepEqual(updateTargets.discoverInstalledTargets([homeRoot]), [
      {
        targetUser: "oscar",
        installDir: "/srv/rin-oscar",
        ownerHome: oscarHome,
        source: "launchd",
      },
    ]);
  });
});
