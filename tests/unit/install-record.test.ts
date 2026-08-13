import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const installRecord = await importBuiltModule<
  typeof import("../../src/core/rin-install/install-record.js")
>("dist/core/rin-install/install-record.js");

test("install-record normalizes launcher metadata and installer manifests", () => {
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    }),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      targetUser: "manifest-demo",
    }),
    {
      defaultTargetUser: "manifest-demo",
      defaultInstallDir: "/home/demo/.rin",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "launcher-demo",
      installDir: "/srv/rin-demo",
    }),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      targetUser: "manifest-demo",
      defaultInstallDir: "/srv/rin-demo",
    }),
    {
      defaultTargetUser: "manifest-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "   ",
      targetUser: " manifest-demo ",
      defaultInstallDir: "   ",
      installDir: " /srv/rin-demo ",
    }),
    {
      defaultTargetUser: "manifest-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "launcher-demo",
    }),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/home/demo/.rin",
    },
  );
  assert.equal(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "   ",
      targetUser: "",
      defaultInstallDir: "   ",
      installDir: "",
    }),
    null,
  );
  assert.deepEqual(
    installRecord.resolveInstallRecordTarget("/home/demo", "fallback-user", {
      defaultInstallDir: "/srv/rin-demo",
    }),
    {
      targetUser: "fallback-user",
      installDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.resolveInstallRecordTarget("/home/demo", " fallback-user ", {
      defaultInstallDir: " /srv/rin-demo ",
    }),
    {
      targetUser: "fallback-user",
      installDir: "/srv/rin-demo",
    },
  );

  const readCalls = [];
  assert.deepEqual(
    installRecord.loadInstallRecordFromCandidates(
      "/home/demo",
      ["broken", "empty", "manifest", "unused"],
      (filePath) => {
        readCalls.push(filePath);
        if (filePath === "broken") throw new SyntaxError("broken json");
        if (filePath === "empty") return [];
        if (filePath === "manifest") return { targetUser: "candidate-demo" };
        return { targetUser: "unused-demo" };
      },
    ),
    {
      defaultTargetUser: "candidate-demo",
      defaultInstallDir: "/home/demo/.rin",
    },
  );
  assert.deepEqual(readCalls, ["broken", "empty", "manifest"]);

  assert.deepEqual(
    installRecord.loadInstallRecordFromCandidates(
      "/home/demo",
      ["mixed", "unused"],
      (filePath) =>
        filePath === "mixed"
          ? { defaultTargetUser: "launcher-demo", installDir: "/srv/rin-demo" }
          : { targetUser: "unused-demo" },
    ),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );

  assert.deepEqual(
    installRecord.resolveInstallRecordTargetFromCandidates(
      "/home/demo",
      "fallback-user",
      ["missing", "launcher"],
      (filePath) =>
        filePath === "launcher" ? { defaultInstallDir: "/srv/rin-demo" } : null,
    ),
    {
      targetUser: "fallback-user",
      installDir: "/srv/rin-demo",
    },
  );
  assert.equal(installRecord.normalizeInstallRecord("/home/demo", null), null);
});
