import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const gui = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "gui.js"))
    .href
);

test("installer GUI starts by default only for Windows interactive installs", () => {
  assert.equal(gui.shouldStartGuiInstaller([], "win32"), true);
  assert.equal(gui.shouldStartGuiInstaller(["--gui"], "linux"), true);
  assert.equal(gui.shouldStartGuiInstaller(["--tui"], "win32"), false);
  assert.equal(gui.shouldStartGuiInstaller(["--no-gui"], "win32"), false);
  assert.equal(
    gui.shouldStartGuiInstaller(
      ["--apply-plan-file", "/tmp/plan.json"],
      "win32",
    ),
    false,
  );
  assert.equal(gui.shouldStartGuiInstaller(["--update"], "win32"), false);
});

test("installer GUI launcher resolves the bundled desktop host directly", () => {
  const launch = gui.buildGuiInstallerHostLaunch({});
  assert.equal(launch.command, process.execPath);
  assert.ok(
    launch.args[0].endsWith(
      path.join("dist", "app", "rin-desktop-host", "main.js"),
    ),
  );
  assert.deepEqual(launch.args.slice(1), ["--stdio", "--installer"]);
  assert.deepEqual(
    gui.buildGuiInstallerHostLaunch({
      RIN_GUI_NATIVE_HOST: "shared-host --channel beta",
    }),
    {
      command: "shared-host",
      args: ["--channel", "beta", "--stdio", "--installer"],
    },
  );
  assert.deepEqual(
    gui.buildGuiInstallerHostLaunch({
      RIN_INSTALLER_GUI_HOST: "installer-host --wizard",
      RIN_GUI_NATIVE_HOST: "shared-host --channel beta",
    }),
    {
      command: "installer-host",
      args: ["--wizard", "--stdio", "--installer"],
    },
  );
});

test("installer GUI args expose no browser server switches", () => {
  assert.deepEqual(gui.parseGuiInstallerArgs(["--gui"]), {});
  for (const arg of [
    "--host",
    "--host=localhost",
    "--port",
    "--open",
    "--no-open",
  ]) {
    assert.throws(
      () => gui.parseGuiInstallerArgs([arg]),
      new RegExp(`rin_installer_gui_unrecognized_arg:${arg}`),
    );
  }
});

test("installer GUI plan reuses installer plan text and escapes the HTML shell", () => {
  const plan = gui.buildGuiInstallerPlan({
    language: "zh_CN",
    currentUser: "alice",
    targetUser: "bob",
    installDir: "/home/bob/.rin",
    provider: "github-copilot",
    modelId: "gpt-5.1",
    thinkingLevel: "high",
    authAvailable: true,
    setDefaultTarget: false,
  });
  assert.equal(plan.language, "zh_CN");
  assert.equal(plan.targetUser, "bob");
  assert.equal(plan.provider, "github-copilot");
  assert.equal(plan.modelId, "gpt-5.1");
  assert.equal(plan.thinkingLevel, "high");
  assert.equal(plan.authAvailable, true);
  assert.match(plan.safety, /YOLO mode|YOLO/);
  assert.match(plan.planText, /bob/);
  assert.match(plan.planText, /github-copilot/);

  const html = gui.buildGuiInstallerHtml();
  assert.match(html, /Rin Installer/);
  assert.match(html, /Step 1 of 4: choose install target/);
  assert.match(html, /Step 4 of 4: apply installation/);
  assert.match(html, /data-next/);
  assert.match(html, /installer:plan/);
  assert.match(html, /installer:models/);
  assert.match(html, /installer:auth:api-key/);
  assert.match(html, /installer:apply/);
  assert.match(html, /data-busy/);
  assert.match(html, /rinInstallerSpin/);
  assert.match(html, /window\.rinDesktop\.send/);
  assert.doesNotMatch(html, /fetch\(|\/api\/|<script src=/);
});

test("installer GUI saves API key provider auth for desktop install", () => {
  let writtenPath = "";
  let writtenValue: any = null;
  const result = gui.saveGuiInstallerApiKeyAuth(
    { installDir: "/home/alice/.rin", provider: "openai", token: "sk-test" },
    {
      readJsonFile() {
        return { existing: { type: "api_key", key: "keep" } };
      },
      writeJsonFile(filePath, value) {
        writtenPath = filePath;
        writtenValue = value;
      },
    },
  );
  assert.equal(result.provider, "openai");
  assert.equal(result.available, true);
  assert.equal(writtenPath, "/home/alice/.rin/auth.json");
  assert.deepEqual(writtenValue, {
    existing: { type: "api_key", key: "keep" },
    openai: { type: "api_key", key: "sk-test" },
  });
});

test("installer GUI builds final apply options from auth-ready selections", () => {
  const finalPlan = gui.buildGuiInstallerFinalizePlan(
    {
      language: "en_US",
      currentUser: "alice",
      targetUser: "alice",
      installDir: "/home/alice/.rin",
      provider: "copilot",
      modelId: "gpt-5.1",
      thinkingLevel: "medium",
      setDefaultTarget: true,
    },
    {
      readJsonFile() {
        return { copilot: { type: "oauth" } };
      },
      release: {
        channel: "git",
        version: "0.0.0",
        branch: "main",
        ref: "main",
        sourceLabel: "git branch main",
        archiveUrl: "https://example.test/rin.tar.gz",
        installedAt: "2026-05-20T00:00:00.000Z",
      },
      describeOwnership() {
        return {
          ownerMatches: true,
          writable: true,
          statUid: 1000,
          statGid: 1000,
          targetUid: 1000,
          targetGid: 1000,
        };
      },
      shouldUseElevatedWrite() {
        return false;
      },
      platform: "win32",
    },
  );
  assert.equal(finalPlan.needsElevatedWrite, false);
  assert.equal(finalPlan.needsElevatedService, false);
  assert.equal(finalPlan.options.provider, "copilot");
  assert.equal(finalPlan.options.modelId, "gpt-5.1");
  assert.deepEqual(finalPlan.options.authData, { copilot: { type: "oauth" } });
});

test("installer GUI rejects final apply when provider auth is missing", () => {
  assert.throws(
    () =>
      gui.buildGuiInstallerFinalizePlan(
        {
          currentUser: "alice",
          targetUser: "alice",
          installDir: "/home/alice/.rin",
          provider: "copilot",
          modelId: "gpt-5.1",
        },
        {
          readJsonFile() {
            return {};
          },
        },
      ),
    /rin_installer_gui_provider_auth_required:copilot/,
  );
});

test("installer GUI normalizes local model choices for desktop selection", () => {
  assert.deepEqual(
    gui.normalizeGuiInstallerModelChoices([
      { provider: "openai", id: "plain", reasoning: false, available: false },
      {
        provider: "copilot",
        id: "reasoning",
        reasoning: true,
        available: true,
      },
      { provider: "", id: "ignored", reasoning: true, available: true },
    ]),
    [
      {
        provider: "copilot",
        id: "reasoning",
        reasoning: true,
        available: true,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      },
      {
        provider: "openai",
        id: "plain",
        reasoning: false,
        available: false,
        thinkingLevels: ["off"],
      },
    ],
  );
});
