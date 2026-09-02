import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const interactive = await importBuiltModule<
  typeof import("../../src/core/rin-install/interactive.js")
>("dist/core/rin-install/interactive.js");
const copyModule = await importBuiltModule<
  typeof import("../../src/core/product-copy.js")
>("dist/core/product-copy.js");
const paths = await importBuiltModule<
  typeof import("../../src/core/rin-install/paths.js")
>("dist/core/rin-install/paths.js");

const copy = copyModule.createInstallerCopy("en-US");

function createPrompt(options: {
  selects?: any[];
  texts?: any[];
  confirms?: any[];
}) {
  const selects = [...(options.selects || [])];
  const texts = [...(options.texts || [])];
  const confirms = [...(options.confirms || [])];
  const seen = { select: [] as any[], text: [] as any[], confirm: [] as any[] };
  return {
    seen,
    ensureNotCancelled<T>(value: T | symbol | undefined | null): T {
      assert.notEqual(value, undefined);
      assert.notEqual(value, null);
      return value as T;
    },
    async select(promptOptions: any) {
      seen.select.push(promptOptions);
      assert.ok(
        selects.length > 0,
        `missing select response for ${promptOptions.message}`,
      );
      return selects.shift();
    },
    async text(promptOptions: any) {
      seen.text.push(promptOptions);
      assert.ok(
        texts.length > 0,
        `missing text response for ${promptOptions.message}`,
      );
      return texts.shift();
    },
    async confirm(promptOptions: any) {
      seen.confirm.push(promptOptions);
      assert.ok(
        confirms.length > 0,
        `missing confirm response for ${promptOptions.message}`,
      );
      return confirms.shift();
    },
  };
}

const users = [
  {
    name: "owner",
    uid: 1000,
    gid: 1000,
    home: "/home/owner",
    shell: "/bin/bash",
  },
  { name: "rin", uid: 1001, gid: 1001, home: "/home/rin", shell: "/bin/bash" },
];
const targetHome = (user: string) => `/srv/home/${user}`;

test("install target options preserve platform capabilities", () => {
  const linux = interactive.buildInstallTargetOptions("owner", copy, "linux");
  assert.deepEqual(
    linux.map((item) => item.value),
    ["current", "local-user", "new-local-user", "ssh", "container"],
  );
  assert.equal(linux[0].hint, "owner");
  const windows = interactive.buildInstallTargetOptions("owner", copy, "win32");
  assert.deepEqual(
    windows.map((item) => item.value),
    ["current", "ssh", "container"],
  );
});

test("removed install target modes fail explicitly without prompting for legacy inputs", async () => {
  const prompt = createPrompt({ selects: ["cloud"] });
  await assert.rejects(
    () =>
      interactive.promptInstallTarget(prompt, "owner", users, targetHome, copy),
    /rin_target_unsupported:cloud/,
  );
  assert.equal(prompt.seen.text.length, 0);
});

test("local target prompts distinguish current, existing, new, and unavailable users", async () => {
  const currentPrompt = createPrompt({ selects: ["current"] });
  const current = await interactive.promptInstallTarget(
    currentPrompt,
    "owner",
    users,
    targetHome,
    copy,
  );
  assert.equal(current.kind, "local");
  assert.equal(current.targetUser, "owner");
  assert.equal(
    current.installDir,
    paths.defaultInstallDirForHome("/srv/home/owner"),
  );

  const existingPrompt = createPrompt({ selects: ["local-user", "rin"] });
  const existing = await interactive.promptInstallTarget(
    existingPrompt,
    "owner",
    users,
    targetHome,
    copy,
  );
  assert.equal(existing.kind, "local");
  assert.equal(existing.targetUser, "rin");
  assert.equal(existing.existingCandidates.length, 1);
  assert.equal(
    existingPrompt.seen.select[1].options[0].hint,
    "/home/rin · uid 1001",
  );

  const newPrompt = createPrompt({
    selects: ["new-local-user"],
    texts: ["new_owner"],
  });
  const created = await interactive.promptInstallTarget(
    newPrompt,
    "owner",
    users,
    targetHome,
    copy,
  );
  assert.equal(created.targetUser, "new_owner");
  assert.equal(created.createSystemUser, true);
  const usernameValidator = newPrompt.seen.text[0].validate;
  assert.equal(usernameValidator(""), copy.usernameRequired);
  assert.equal(usernameValidator("bad name"), copy.usernameInvalid);
  assert.equal(usernameValidator("valid-user"), undefined);

  const unavailablePrompt = createPrompt({ selects: [] });
  const unavailable = await interactive.promptTargetInstall(
    unavailablePrompt,
    "owner",
    [],
    targetHome,
    copy,
    "existing",
  );
  assert.deepEqual(unavailable, {
    kind: "local",
    cancelled: true,
    targetUser: "owner",
    installDir: "",
    existingCandidates: [],
    allUsers: [],
  });
});

test("SSH and container prompts return validated direct targets", async () => {
  const sshPrompt = createPrompt({
    selects: ["ssh"],
    texts: [" owner@example ", "owner-ssh"],
  });
  const ssh = await interactive.promptInstallTarget(
    sshPrompt,
    "owner",
    users,
    targetHome,
    copy,
  );
  assert.deepEqual(ssh, {
    kind: "ssh",
    name: "owner-ssh",
    host: "owner@example",
  });
  assert.equal(sshPrompt.seen.text[0].validate(""), copy.sshTargetRequired);
  assert.equal(sshPrompt.seen.text[0].validate("host"), undefined);
  assert.equal(sshPrompt.seen.text[1].validate("***"), copy.targetNameRequired);
  assert.equal(sshPrompt.seen.text[1].validate("owner-target"), undefined);

  const containerPrompt = createPrompt({
    selects: ["container", "podman"],
    texts: ["owner-container", " node:22-alpine "],
  });
  const container = await interactive.promptInstallTarget(
    containerPrompt,
    "owner",
    users,
    targetHome,
    copy,
  );
  assert.deepEqual(container, {
    kind: "container",
    name: "owner-container",
    engine: "podman",
    image: "node:22-alpine",
  });
});

test("install directory and default-target prompts render both owner states", async () => {
  const existing = interactive.describeInstallDirState(
    "/opt/rin",
    { exists: true, entryCount: 2, sample: ["settings.json", "data"] },
    copy,
  );
  assert.equal(existing.title, copy.existingDirectoryTitle);
  assert.match(existing.text, /\/opt\/rin/);
  assert.match(existing.text, /settings\.json/);

  const fresh = interactive.describeInstallDirState(
    "/opt/new-rin",
    { exists: false, entryCount: 0, sample: [] },
    copy,
  );
  assert.equal(fresh.title, copy.installDirectoryTitle);
  assert.match(fresh.text, /\/opt\/new-rin/);

  const prompt = createPrompt({ confirms: [1] });
  assert.equal(
    await interactive.promptDefaultTargetUser(prompt, "rin", copy),
    true,
  );
  assert.equal(prompt.seen.confirm[0].initialValue, true);
});

function model(
  provider: string,
  id: string,
  options: Partial<{
    providerLabel: string;
    authKind: "subscription" | "api";
    reasoning: boolean;
    available: boolean;
  }> = {},
) {
  return {
    provider,
    providerLabel: options.providerLabel || provider,
    authKind: options.authKind || "api",
    id,
    reasoning: options.reasoning ?? true,
    available: options.available ?? false,
  };
}

test("provider setup reuses complete authenticated owner defaults", async () => {
  const prompt = createPrompt({});
  const installDir = "/owner/rin";
  const authData = { codex: { token: "stored" } };
  const result = await interactive.promptProviderSetup(
    prompt,
    installDir,
    (filePath, fallback) => {
      if (filePath === paths.installSettingsPath(installDir)) {
        return {
          defaultProvider: "codex",
          defaultModel: "gpt-owner",
          defaultThinkingLevel: "high",
        } as any;
      }
      if (filePath === paths.installAuthPath(installDir))
        return authData as any;
      return fallback;
    },
    {
      loadModelChoices: async () => [
        model("codex", "gpt-owner", {
          authKind: "subscription",
          available: true,
        }),
      ],
      configureProviderAuth: async () => assert.fail("auth must be reused"),
    },
    copy,
  );
  assert.deepEqual(result, {
    provider: "codex",
    modelId: "gpt-owner",
    thinkingLevel: "high",
    authResult: {
      available: true,
      authKind: "existing",
      authData,
    },
  });
  assert.equal(prompt.seen.select.length, 0);
});

test("provider setup orders providers, configures auth, model, and thinking", async () => {
  const prompt = createPrompt({
    selects: ["codex", "gpt-owner", "medium"],
  });
  const configured: any[] = [];
  const result = await interactive.promptProviderSetup(
    prompt,
    "/owner/rin",
    (_filePath, fallback) => fallback,
    {
      loadModelChoices: async () => [
        model("api-z", "plain", {
          providerLabel: `API Z ${copy.apiAuthLabel}`,
          reasoning: false,
          available: false,
        }),
        model("codex", "gpt-owner", {
          providerLabel: `Codex Plus ${copy.subscriptionAuthLabel}`,
          authKind: "subscription",
          available: true,
        }),
        model("codex", "gpt-other", {
          providerLabel: "Codex Plus",
          authKind: "subscription",
          available: false,
        }),
      ],
      configureProviderAuth: async (provider, installDir, options) => {
        configured.push({ provider, installDir, options });
        return {
          available: true,
          authKind: "oauth",
          authData: { codex: {} },
        } as any;
      },
    },
    copy,
  );
  assert.deepEqual(result, {
    provider: "codex",
    modelId: "gpt-owner",
    thinkingLevel: "medium",
    authResult: {
      available: true,
      authKind: "oauth",
      authData: { codex: {} },
    },
  });
  assert.equal(configured.length, 1);
  assert.equal(configured[0].provider, "codex");
  assert.equal(prompt.seen.select[0].options[0].value, "codex");
  assert.doesNotMatch(prompt.seen.select[0].options[0].label, /Subscription$/i);
  assert.match(prompt.seen.select[0].options[0].hint, /2/);
  assert.match(
    prompt.seen.select[1].options[0].hint,
    new RegExp(copy.reasoningHint),
  );
  assert.deepEqual(
    prompt.seen.select[2].options.map((item: any) => item.value),
    ["off", "minimal", "low", "medium", "high"],
  );
});

test("provider setup rejects absent model inventory and missing provider models", async () => {
  await assert.rejects(
    interactive.promptProviderSetup(
      createPrompt({}),
      "/owner/rin",
      (_filePath, fallback) => fallback,
      { loadModelChoices: async () => [] },
      copy,
    ),
    new RegExp(
      copy.noModelsAvailableError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );

  const prompt = createPrompt({ selects: ["missing"] });
  await assert.rejects(
    interactive.promptProviderSetup(
      prompt,
      "/owner/rin",
      (_filePath, fallback) => fallback,
      {
        loadModelChoices: async () => [model("available", "model")],
        configureProviderAuth: async () =>
          ({ available: false, authData: {} }) as any,
      },
      copy,
    ),
    /missing/i,
  );
});

test("installer plan and safety copy preserve accepted owner choices", () => {
  const safety = interactive.buildInstallSafetyBoundaryText(copy);
  assert.ok(safety.length > 20);
  const plan = interactive.buildInstallPlanText(
    {
      currentUser: "owner",
      targetUser: "rin",
      installDir: "/home/rin/.rin",
      provider: "codex",
      modelId: "gpt-owner",
      thinkingLevel: "high",
      authAvailable: true,
      language: "en-US",
      setDefaultTarget: false,
    },
    copy,
  );
  assert.match(plan, /rin/);
  assert.match(plan, /codex/);
  assert.match(plan, /gpt-owner/);
  assert.match(plan, /high/);

  const defaultLanguage = interactive.buildInstallPlanText(
    {
      currentUser: "owner",
      targetUser: "owner",
      installDir: "/home/owner/.rin",
      provider: "demo",
      modelId: "model",
      thinkingLevel: "off",
      authAvailable: false,
    },
    copy,
  );
  assert.match(defaultLanguage, /Target daemon user: owner/);
});

test("installer display width handles control, combining, CJK, Hangul, fullwidth, and emoji", () => {
  assert.equal(interactive.installerTextDisplayWidth("abc"), 3);
  assert.equal(
    interactive.installerTextDisplayWidth("\u001b[31mred\u001b[0m"),
    3,
  );
  assert.equal(interactive.installerTextDisplayWidth("e\u0301"), 1);
  assert.equal(interactive.installerTextDisplayWidth("\u4e2d"), 2);
  assert.equal(interactive.installerTextDisplayWidth("한"), 2);
  assert.equal(interactive.installerTextDisplayWidth("Ａ"), 2);
  assert.equal(interactive.installerTextDisplayWidth("😀"), 2);
  assert.equal(interactive.installerTextDisplayWidth("\u0000\u0007"), 0);
});

test("installer notes wrap bullets and preserve readable plain and styled sections", () => {
  const longLine = `- ${"owner ".repeat(20)}`.trimEnd();
  const wrapped = interactive.wrapInstallerNoteText(`${longLine}\n\nshort`, 48);
  const rows = wrapped.split("\n");
  assert.ok(rows.length > 3);
  assert.equal(rows.at(-1), "short");
  assert.ok(rows.slice(1, -2).some((line) => /^\s+owner/.test(line)));
  assert.equal(interactive.wrapInstallerNoteText("short", 200), "short");

  assert.equal(
    interactive.buildPlainInstallerSection(" Owner ", "first\n\nsecond"),
    "Owner\n  first\n  second",
  );
  const styled = interactive.renderInstallerNote("owner\n\u4e2d\u6587", "Rin", {
    border: (value) => `<b>${value}</b>`,
    body: (value) => `<body>${value}</body>`,
    symbol: (value) => `<s>${value}</s>`,
    title: (value) => `<t>${value}</t>`,
  });
  assert.match(styled, /<s>◇<\/s>/);
  assert.match(styled, /<t>Rin<\/t>/);
  assert.match(styled, /<body>\u4e2d\u6587<\/body>/);
  assert.match(interactive.renderInstallerNote(), /◇/);
});

test("installer outro and initialization exit choose PATH-aware launch commands", () => {
  const noPath = interactive.buildInstallOutroText(
    { currentUser: "owner", targetUser: "owner" },
    copy,
  );
  assert.match(noPath, /rin/);

  const rinPath = path.join("/opt", "rin", "bin", "rin");
  const crossUser = interactive.buildInstallOutroText(
    {
      currentUser: "owner",
      targetUser: "rin",
      rinPath,
      pathValue: `/usr/bin${path.delimiter}/opt/rin/bin`,
      installedServiceKind: "systemd",
    },
    copy,
  );
  assert.match(crossUser, /rin -u rin/);
  assert.match(crossUser, /systemd/i);

  const notOnPath = interactive.buildInstallOutroText(
    {
      currentUser: "owner",
      targetUser: "rin",
      rinPath,
      pathValue: "/usr/bin",
    },
    copy,
  );
  assert.match(notOnPath, new RegExp(rinPath.replaceAll("/", "\\/")));

  const plainExit = interactive.buildPostInstallInitExitText(
    { currentUser: "owner", targetUser: "owner" },
    copy,
  );
  assert.ok(plainExit.length > 10);
  const pathExit = interactive.buildPostInstallInitExitText(
    {
      currentUser: "owner",
      targetUser: "owner",
      rinPath,
      pathValue: "/opt/rin/bin",
    },
    copy,
  );
  assert.match(pathExit, /rin/);
  const directExit = interactive.buildPostInstallInitExitText(
    {
      currentUser: "owner",
      targetUser: "owner",
      rinPath,
      pathValue: "/usr/bin",
    },
    copy,
  );
  assert.match(directExit, new RegExp(rinPath.replaceAll("/", "\\/")));
});

test("final requirements reflect service and privilege boundaries", () => {
  const none = interactive.buildFinalRequirements(
    {
      installServiceNow: false,
      needsElevatedWrite: false,
      needsElevatedService: false,
    },
    copy,
  );
  const elevated = interactive.buildFinalRequirements(
    {
      installServiceNow: true,
      needsElevatedWrite: true,
      needsElevatedService: true,
    },
    copy,
  );
  assert.ok(Array.isArray(none));
  assert.ok(Array.isArray(elevated));
  assert.ok(elevated.length >= none.length);
});
