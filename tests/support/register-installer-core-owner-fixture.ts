import { register } from "node:module";

const replacements: Record<string, string> = {
  "dist/core/rin-install/apply-plan.js": `
    export async function runFinalizeInstallPlanInChild(options, message, status) {
      globalThis.__rinInstallerOwnerEvents.push(["finalize-child", options, message]);
      status.writeStatus("owner");
      return globalThis.__rinInstallerOwnerResult();
    }
  `,
  "dist/core/rin-install/fs-utils.js": `
    export function readInstallerJson(file, fallback, elevated) {
      globalThis.__rinInstallerOwnerEvents.push(["read-installer", file, elevated]);
      return globalThis.__rinInstallerOwnerScenario.settings ?? fallback;
    }
    export function readJsonFile() { return {}; }
  `,
  "dist/core/rin-install/interactive.js": `
    const i = (name, value = name) => (...args) => { globalThis.__rinInstallerOwnerEvents.push([name, ...args]); return value; };
    export const buildFinalRequirements = i("requirements", "owner requirements");
    export const buildInstallPlanText = i("plan", "owner plan");
    export const buildInstallSafetyBoundaryText = i("safety", "owner safety");
    export const buildInstallOutroText = i("outro-text", "owner outro");
    export const buildPostInstallInitExitText = i("post-init", "owner post init");
    export function renderInstallerNote(message, title) { return "NOTE[" + title + "]" + message; }
    export function wrapInstallerNoteText(value) { return String(value); }
    export function describeInstallDirState(dir, state) { globalThis.__rinInstallerOwnerEvents.push(["dir-state", dir, state]); return { title: "owner dir", text: "owner state" }; }
    export async function promptDefaultTargetUser() { return globalThis.__rinInstallerOwnerScenario.setDefaultTarget ?? true; }
    export async function promptProviderSetup() { return { provider: "owner-provider", modelId: "owner-model", thinkingLevel: "high", authResult: { available: true, authData: { owner: true } } }; }
    export async function promptInstallTarget() {
      const scenario = globalThis.__rinInstallerOwnerScenario;
      if (scenario.target === "cancelled") return { cancelled: true };
      if (["ssh", "container", "cloud", "nas", "vm"].includes(scenario.target)) return { kind: scenario.target, name: "owner-target" };
      return { kind: "local", targetUser: scenario.targetUser || "other", installDir: scenario.installDir || "/owner/install" };
    }
  `,
  "dist/core/rin-install/i18n.js": `
    export function createInstallerI18n(language) {
      const fn = (name) => (...args) => name + ":" + args.map(String).join(",");
      return new Proxy({
        installerCancelled: "installer cancelled",
        confirmActiveLabel: "yes", confirmInactiveLabel: "no",
        preparingInstallerMessage: "preparing", installStepComplete: "complete",
        installStepFailed: "failed", introTitle: "intro", safetyBoundaryTitle: "safety",
        applyingTargetSelectionMessage: "target", nothingInstalled: "nothing",
        noEligibleUsersText: fn("no-users"), targetUserTitle: "target-user",
        inspectingInstallDirectoryMessage: "inspect", installChoicesTitle: "choices",
        ownershipCheckTitle: "ownership", ownershipMismatchText: fn("mismatch"),
        ownershipNotWritableText: "not-writable", finalizeInstallationMessage: fn("finalize"),
        installerFinishedWithoutWritingChanges: "not-written",
        publishingRuntimeMessageElevated: "publish-elevated", publishingRuntimeMessage: "publish",
        targetInstallDirLabel: "install-dir", writtenPathLabel: "written", serviceLabelLabel: "service",
        writtenPathsTitle: "paths", launchingInitText: "launch-init", launchingInitTitle: "launch",
        afterInitTitle: "after-init",
      }, { get(target, key) { return key in target ? target[key] : String(key); } });
    }
    export async function promptInstallerLanguage({ ensureNotCancelled }) {
      const scenario = globalThis.__rinInstallerOwnerScenario;
      return ensureNotCancelled(scenario.cancelLanguage ? Symbol.for("rin-owner-cancel") : scenario.language ?? "en_US");
    }
  `,
  "dist/core/rin-install/common.js": `
    export function detectCurrentUser() { return "owner"; }
    export function repoRootFromHere() { return "/owner/source"; }
    export async function runCommand(command, args, options) { globalThis.__rinInstallerOwnerEvents.push(["run-command", command, args, options]); return { code: 0 }; }
  `,
  "dist/core/rin-install/finalize.js": `
    export async function finalizeCoreUpdate(plan) { if (plan.fail) throw new Error("owner apply failed"); return { kind: "core", plan }; }
    export async function finalizeInstallPlan(plan) { if (plan.fail) throw new Error("owner apply failed"); return { kind: "install", plan }; }
  `,
  "dist/core/language.js": `
    export const DEFAULT_LANGUAGE_TAG = "en_US";
    export function detectLocalLanguageTag() { return "zh_CN"; }
    export function normalizeLanguageTag(value, fallback = "en_US") { return String(value || "").trim() || fallback; }
  `,
  "dist/core/rin-lib/release.js": `
    export function releaseInfoFromFile(file) { return { file: file || "default-release" }; }
  `,
  "dist/core/rin-lib/user-facing-errors.js": `
    export function formatRuntimeErrorForUser(error) { return "formatted:" + String(error?.message || error || "empty"); }
  `,
  "dist/core/rin-install/users.js": `
    export function describeOwnership() { return globalThis.__rinInstallerOwnerScenario.ownership || { ownerMatches: true, targetUid: 1000, writable: true }; }
    export function isSameSystemUser(left, right) { return left === right; }
    export function listSystemUsers() { return [{ name: "owner" }, { name: "other" }]; }
    export function shouldUseElevatedWrite() { return Boolean(globalThis.__rinInstallerOwnerScenario.elevatedWrite); }
    export function targetHomeForUser(user) { return "/homes/" + user; }
  `,
  "dist/core/rin-install/paths.js": `
    export function defaultInstallDirForHome(home) { return home + "/.rin/app"; }
    export function installSettingsPath(dir) { return dir + "/installer.json"; }
  `,
  "dist/core/rin-install/updater.js": `
    export async function startUpdater(options) {
      globalThis.__rinInstallerOwnerEvents.push(["updater", options.releaseRequest, options.requestedInstallDir, options.requestedTargetUser, options.assumeYes, options.preconfirmed, options.i18n.introTitle]);
      options.detectCurrentUser();
      await options.confirm({ message: "owner update", initialValue: true });
    }
  `,
  "dist/core/rin-install/progress.js": `
    export async function runInstallerProgress(message, run, options) { globalThis.__rinInstallerOwnerEvents.push(["progress", message, options]); return await run(); }
  `,
  "dist/core/rin-install/quick-run.js": `
    export async function runQuickRun() { globalThis.__rinInstallerOwnerEvents.push(["quick-run"]); }
  `,
  "dist/core/rin-install/deployment-targets.js": `
    const install = (kind) => async (target) => { globalThis.__rinInstallerOwnerEvents.push(["install-target", kind, target]); return { name: kind + "-owner" }; };
    export const installCloudTarget = install("cloud");
    export const installContainerTarget = install("container");
    export const installExistingSshTarget = install("ssh");
    export const installNasTarget = install("nas");
    export const installVmTarget = install("vm");
    export function registerLocalUserTarget(user) { globalThis.__rinInstallerOwnerEvents.push(["register-local", user]); }
  `,
};

const clackSource = `
  export const __cancel = Symbol.for("rin-owner-cancel");
  export function isCancel(value) { return value === __cancel; }
  export function cancel(value) { console.log("cancel:" + value); }
  export function intro(value) { console.log("intro:" + value); }
  export function outro(value) { console.log("outro:" + value); }
  export async function confirm(options) { globalThis.__rinInstallerOwnerEvents.push(["confirm", options]); return globalThis.__rinInstallerOwnerScenario.confirm ?? true; }
  export async function select() { return "owner-select"; }
  export async function text() { return "owner-text"; }
  export async function multiselect() { return []; }
`;
const chalkSource = `
  const identity = (value) => String(value ?? "");
  const chalk = new Proxy(identity, { get() { return identity; } });
  export default chalk;
`;
const replacementUrls = Object.fromEntries(
  Object.entries(replacements).map(([target, source]) => [
    target,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hookSource = `
const replacements = ${JSON.stringify(replacementUrls)};
const clackUrl = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(clackSource)}`)};
const chalkUrl = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(chalkSource)}`)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@clack/prompts") return { url: clackUrl, shortCircuit: true };
  if (specifier === "chalk") return { url: chalkUrl, shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  for (const [target, replacementUrl] of Object.entries(replacements)) {
    if (resolved.url.endsWith(target)) return { url: replacementUrl, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);

globalThis.__rinInstallerOwnerEvents ||= [];
globalThis.__rinInstallerOwnerScenario ||= JSON.parse(
  process.env.RIN_TEST_INSTALLER_SCENARIO || "{}",
);
globalThis.__rinInstallerOwnerResult ||= () => ({
  written: {
    settingsPath: "/owner/settings",
    authPath: "/owner/auth",
    manifestPath: "/owner/manifest",
    locatorManifestPath: "/owner/locator",
    launcherPath: "/owner/launcher",
    rinPath: "/owner/rin",
    rinInstallPath: "/owner/rin-install",
    targetRinPath: "/target/rin",
    targetRinInstallPath: "/target/rin-install",
  },
  publishedRuntime: {
    currentLink: "/owner/current",
    releaseRoot: "/owner/release",
  },
  installedDocs: { pi: ["/owner/pi-one", "/owner/pi-two"] },
  installedDocsDir: "/owner/docs",
  installedService: {
    servicePath: "/owner/service",
    kind: "systemd",
    label: "owner.service",
  },
  daemonReady: true,
  initializationRequired: true,
  serviceHint: "owner hint",
});
