import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as gui from "../../dist/core/rin-install/gui.js";

async function withTempDir(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-gui-owner-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("GUI installer parses host launch and release-file options", () => {
  assert.deepEqual(
    gui.buildGuiInstallerHostLaunch({
      RIN_INSTALLER_GUI_HOST: "node owner-host.js",
    }),
    { command: "node", args: ["owner-host.js", "--stdio", "--installer"] },
  );
  assert.deepEqual(
    gui.parseGuiInstallerArgs(["--gui", "--release-file", " release.json "]),
    {
      releaseFile: "release.json",
    },
  );
  assert.deepEqual(
    gui.parseGuiInstallerArgs(["--release-file=next.json", "--", "ignored"]),
    {
      releaseFile: "next.json",
    },
  );
  assert.deepEqual(gui.parseGuiInstallerArgs([]), {});
  assert.deepEqual(
    gui.parseGuiInstallerArgs(["", "--gui", "--release-file"]),
    {},
  );
  assert.throws(
    () => gui.parseGuiInstallerArgs(["--unknown"]),
    /rin_installer_gui_unrecognized_arg/,
  );
  assert.equal(
    gui.buildGuiInstallerHostLaunch({
      RIN_GUI_NATIVE_HOST: "owner-native-host",
    }).command,
    "owner-native-host",
  );
  assert.equal(gui.shouldStartGuiInstaller([], "linux"), false);
});

test("GUI installer normalizes model choices and builds reviewable HTML", async () => {
  const models = gui.normalizeGuiInstallerModelChoices([
    { provider: " zeta ", id: " model-b ", reasoning: false, available: true },
    { provider: "alpha", id: "model-a", reasoning: true, available: false },
    { provider: "", id: "ignored" },
  ]);
  assert.deepEqual(
    models.map((item) => `${item.provider}/${item.id}`),
    ["alpha/model-a", "zeta/model-b"],
  );
  assert.deepEqual(gui.normalizeGuiInstallerModelChoices([]), []);
  assert.ok(models[0].thinkingLevels.includes("off"));
  assert.ok((await gui.buildGuiInstallerModelChoices()).length > 0);

  const html = gui.buildGuiInstallerHtml();
  assert.match(html, /Step 1 of 4/);
  assert.match(html, /window\.rinDesktop\.send/);
  assert.match(html, /installer:auth:api-key/);
  assert.doesNotMatch(html, /http:\/\/localhost/);
});

test("GUI installer persists API auth through injected storage", () => {
  const writes: Array<{ filePath: string; value: any }> = [];
  const result = gui.saveGuiInstallerApiKeyAuth(
    { installDir: "/tmp/owner-rin", provider: "openai", token: " secret " },
    {
      readJsonFile: () => ({ existing: { type: "api_key", key: "kept" } }),
      writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
    },
  );
  assert.equal(result.provider, "openai");
  assert.deepEqual(writes[0].value, {
    existing: { type: "api_key", key: "kept" },
    openai: { type: "api_key", key: "secret" },
  });
  gui.saveGuiInstallerApiKeyAuth(
    { installDir: "/tmp/owner-rin", provider: "anthropic", token: "token" },
    {
      readJsonFile: () => [] as any,
      writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
    },
  );
  assert.deepEqual(writes[1].value, {
    anthropic: { type: "api_key", key: "token" },
  });
  assert.throws(
    () => gui.saveGuiInstallerApiKeyAuth({ provider: "openai", token: "x" }),
    /rin_installer_gui_install_dir_required/,
  );
  assert.throws(
    () =>
      gui.saveGuiInstallerApiKeyAuth({
        installDir: "/tmp/rin",
        provider: "pending",
        token: "x",
      }),
    /rin_installer_gui_provider_required/,
  );
  assert.throws(
    () =>
      gui.saveGuiInstallerApiKeyAuth({
        installDir: "/tmp/rin",
        provider: "openai",
      }),
    /rin_installer_gui_token_required/,
  );
});

test("GUI installer builds ordinary and elevated finalize plans", () => {
  const base = {
    language: "zh_CN",
    currentUser: "alice",
    targetUser: "rin",
    installDir: "/srv/rin",
    provider: "openai",
    modelId: "gpt-owner",
    thinkingLevel: "high",
    authAvailable: true,
    setDefaultTarget: false,
  };
  const plan = gui.buildGuiInstallerPlan(base);
  const defaults = gui.buildGuiInstallerPlan({
    language: " ",
    currentUser: " ",
    targetUser: " ",
    installDir: " ",
    provider: " ",
    modelId: " ",
    thinkingLevel: " ",
  });
  assert.equal(defaults.provider, "pending");
  assert.equal(defaults.modelId, "pending");
  assert.equal(defaults.thinkingLevel, "medium");
  assert.equal(plan.language, "zh_CN");
  assert.equal(plan.setDefaultTarget, false);
  assert.match(plan.planText, /\/srv\/rin/);
  assert.ok(plan.safety.length > 0);

  const finalized = gui.buildGuiInstallerFinalizePlan(base, {
    readJsonFile: () => ({ openai: { type: "api_key", key: "owner" } }),
    describeOwnership: () => ({ exists: true }) as any,
    shouldUseElevatedWrite: () => true,
    platform: "linux",
    release: {
      channel: "stable",
      version: "1.2.3",
      branch: "stable",
      ref: "v1.2.3",
      sourceLabel: "stable 1.2.3",
      archiveUrl: "release.tgz",
    },
  });
  assert.equal(finalized.needsElevatedWrite, true);
  assert.equal(finalized.needsElevatedService, true);
  assert.equal(finalized.options.setDefaultTarget, false);
  assert.ok(finalized.finalRequirements.length > 0);
  const ordinary = gui.buildGuiInstallerFinalizePlan(
    { ...base, currentUser: "alice", targetUser: "alice" },
    {
      readJsonFile: () => ({ openai: { type: "api_key", key: "owner" } }),
      describeOwnership: () => ({ exists: true }) as any,
      shouldUseElevatedWrite: () => false,
      platform: "freebsd",
    },
  );
  assert.equal(ordinary.needsElevatedWrite, false);
  assert.equal(ordinary.needsElevatedService, false);

  assert.throws(
    () => gui.buildGuiInstallerFinalizePlan({ ...base, provider: "pending" }),
    /rin_installer_gui_provider_required/,
  );
  assert.throws(
    () => gui.buildGuiInstallerFinalizePlan({ ...base, modelId: "pending" }),
    /rin_installer_gui_model_required/,
  );
  assert.throws(
    () => gui.buildGuiInstallerFinalizePlan(base, { readJsonFile: () => ({}) }),
    /rin_installer_gui_provider_auth_required:openai/,
  );
});

test("GUI installer finalizes a same-user review from local auth state", async () => {
  await withTempDir(async (root) => {
    gui.saveGuiInstallerApiKeyAuth({
      installDir: root,
      provider: "openai",
      token: "owner-token",
    });
    const currentUser = os.userInfo().username;
    const finalized = gui.buildGuiInstallerFinalizePlan({
      currentUser,
      targetUser: currentUser,
      installDir: root,
      provider: "openai",
      modelId: "gpt-owner",
      thinkingLevel: "medium",
    });
    assert.equal(finalized.options.authData.openai.key, "owner-token");
    assert.equal(finalized.needsElevatedWrite, false);
    assert.equal(finalized.needsElevatedService, false);
  });
});

test("GUI installer stdio host handles safe model, plan, auth, and error commands", async () => {
  await withTempDir(async (root) => {
    const host = path.join(root, "host.mjs");
    const installDir = path.join(root, "rin");
    await fs.writeFile(
      host,
      `const commands = [
        { type: "installer:models", installDir: ${JSON.stringify(installDir)} },
        { type: "installer:plan", input: { currentUser: "alice", targetUser: "alice", installDir: ${JSON.stringify(installDir)}, provider: "openai", modelId: "gpt-owner", authAvailable: true } },
        { type: "installer:auth:api-key", input: { installDir: ${JSON.stringify(installDir)}, provider: "openai", token: "owner-token" } },
        { type: "installer:apply", input: { installDir: ${JSON.stringify(installDir)}, provider: "pending", modelId: "pending" } },
        { type: "unknown" }
      ];
      let index = 0;
      const timer = setInterval(() => {
        if (index < commands.length) process.stdout.write(JSON.stringify(commands[index++]) + "\\n");
        else if (index++ === commands.length) process.stdout.write("not-json\\n");
        else { clearInterval(timer); setTimeout(() => process.stdout.write(JSON.stringify({ type: "close" }) + "\\n"), 40); }
      }, 30);
      process.stdin.resume();\n`,
    );
    const previous = process.env.RIN_INSTALLER_GUI_HOST;
    try {
      process.env.RIN_INSTALLER_GUI_HOST = `${process.execPath} ${host}`;
      await gui.runGuiInstaller([]);
      const auth = JSON.parse(
        await fs.readFile(path.join(installDir, "auth.json"), "utf8"),
      );
      assert.equal(auth.openai.key, "owner-token");
    } finally {
      if (previous === undefined) delete process.env.RIN_INSTALLER_GUI_HOST;
      else process.env.RIN_INSTALLER_GUI_HOST = previous;
    }
  });
});
