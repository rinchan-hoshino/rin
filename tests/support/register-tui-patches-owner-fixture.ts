import { register } from "node:module";

const target = "dist/core/pi/tui-patches/index.js";
const sources: Record<string, string> = {
  "@earendil-works/pi-coding-agent": `
    export class DynamicBorder { constructor(render) { this.renderBorder = render; } }
    export class FooterComponent {
      constructor(session = {}, footerData = {}) { this.session = session; this.footerData = footerData; }
      render(width) {
        globalThis.__rinTuiPatchesOwner.events.push([
          "footer-render",
          width,
          this.session?.state?.model?.id,
          this.session?.state?.thinkingLevel,
        ]);
        return [...globalThis.__rinTuiPatchesOwner.footerLines];
      }
    }
    export class InteractiveMode {
      async init() {
        if (this.isInitialized) return;
        globalThis.__rinTuiPatchesOwner.events.push(["original-init", process.env.PI_OFFLINE]);
        this.isInitialized = true;
        this.fullscreenLayoutRoot = { owner: "native-fullscreen-layout" };
        this.builtInHeader = {
          text: "Pi v0.84.1\\nPi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
          setText(value) { this.text = value; },
        };
      }
      updateTerminalTitle() { globalThis.__rinTuiPatchesOwner.events.push(["original-title"]); }
      async shutdown() { process.stdout.write("To resume this session:\\n  pi --session owner\\n"); return "shutdown-owner"; }
      async run() { globalThis.__rinTuiPatchesOwner.events.push(["original-run"]); }
      getChangelogForDisplay() { return "original changelog"; }
      handleChangelogCommand() { globalThis.__rinTuiPatchesOwner.events.push(["original-changelog"]); }
      handleFatalRuntimeError() { globalThis.__rinTuiPatchesOwner.events.push(["original-fatal"]); }
      cycleThinkingLevel() { globalThis.__rinTuiPatchesOwner.events.push(["local-thinking"]); return "local-level"; }
      async rebindCurrentSession(...args) { globalThis.__rinTuiPatchesOwner.events.push(["rebind", ...args]); return "rebound"; }
      renderCurrentSessionState() { globalThis.__rinTuiPatchesOwner.events.push(["original-render-current"]); }
      showSettingsSelector() { globalThis.__rinTuiPatchesOwner.events.push(["settings-selector"]); }
      showSessionSelector() { globalThis.__rinTuiPatchesOwner.events.push(["original-session-selector"]); }
      registerSignalHandlers() { globalThis.__rinTuiPatchesOwner.events.push(["signals"]); }
      subscribeToAgent() { globalThis.__rinTuiPatchesOwner.events.push(["original-subscribe"]); }
      async handleEvent(event) { globalThis.__rinTuiPatchesOwner.events.push(["original-event", event]); }
    }
    export function keyHint(binding, text) { return "<" + binding + ":" + text + ">"; }
    export function keyText(binding) { return "[" + binding + "]"; }
    export function rawKeyHint(binding, text) { return "<" + binding + ":" + text + ">"; }
    export class SessionManager {}
    export class SessionSelectorComponent {
      constructor(currentLoader, allLoader, onSelect, onCancel, onExit, requestRender, options, currentFile) {
        Object.assign(this, { currentLoader, allLoader, onSelect, onCancel, onExit, requestRender, options, currentFile });
        this.scope = "current";
        this.header = {
          sortMode: "threaded", nameFilter: "all", loading: false, loadProgress: null,
          scope: "current", confirmingDeletePath: null, statusMessage: null,
          showPath: false, showRenameHint: options.showRenameHint,
          render() { return ["original header"]; },
          setProgress: (loaded, total) => globalThis.__rinTuiPatchesOwner.events.push(["progress", loaded, total]),
          setStatusMessage: (status, duration) => globalThis.__rinTuiPatchesOwner.events.push(["selector-status", status, duration]),
        };
        this.sessionList = {
          filteredSessions: [], selectedIndex: 0, showCwd: false,
          setSessions: (sessions, showCwd) => { this.sessionList.filteredSessions = sessions; globalThis.__rinTuiPatchesOwner.events.push(["set-sessions", sessions, showCwd]); },
          handleInput: (data) => globalThis.__rinTuiPatchesOwner.events.push(["selector-input", data]),
        };
        globalThis.__rinTuiPatchesOwner.selector = this;
      }
    }
    globalThis.__rinTuiPatchesOwner.classes = { DynamicBorder, FooterComponent, InteractiveMode, SessionManager, SessionSelectorComponent };
  `,
  "dist/core/rin-lib/update-notices.js": `
    export async function checkForRinUpdateNotice() {
      globalThis.__rinTuiPatchesOwner.events.push(["check-update"]);
      const value = globalThis.__rinTuiPatchesOwner.notice;
      if (value instanceof Error) throw value;
      return value;
    }
    export function getCurrentRinVersion() {
      return globalThis.__rinTuiPatchesOwner.currentVersion;
    }
    export function comparePackageVersions(left, right) { return String(left).localeCompare(String(right), undefined, { numeric: true }); }
    export function getRinStartupChangelogEntries(entries, lastVersion, currentVersion) {
      globalThis.__rinTuiPatchesOwner.events.push(["new-entries", lastVersion, currentVersion]);
      return globalThis.__rinTuiPatchesOwner.newEntries;
    }
    export async function processRinGitStartupChangelog(options) { globalThis.__rinTuiPatchesOwner.events.push(["git-changelog"]); return false; }
    export function readInstalledRinReleaseInfo() { return { channel: "stable", version: globalThis.__rinTuiPatchesOwner.currentVersion }; }
    export function getRinChangelogUrl() { return "https://example.test/changelog"; }
    export function parsePackageVersion(value) {
      return /^v?\\d+\\.\\d+\\.\\d+(?:[-+].*)?$/.test(String(value || "").trim()) ? {} : undefined;
    }
    export function readRinChangelogEntries() {
      return globalThis.__rinTuiPatchesOwner.entries;
    }
  `,
  "dist/core/session/factory.js": `
    export async function listBoundSessionPage(options) {
      globalThis.__rinTuiPatchesOwner.events.push(["list-page", options]);
      const next = globalThis.__rinTuiPatchesOwner.pages.shift();
      if (next instanceof Error) throw next;
      return next ?? { sessions: [], offset: options.offset, limit: options.limit, total: 0, hasMore: false };
    }
    export async function renameBoundSession(sessionPath, name, options) {
      globalThis.__rinTuiPatchesOwner.events.push(["rename", sessionPath, name, Boolean(options?.SessionManager)]);
    }
  `,
  "dist/core/platform/process.js": `
    export async function sleep(milliseconds) {
      globalThis.__rinTuiPatchesOwner.events.push(["sleep", milliseconds]);
    }
  `,
};
const urls = Object.fromEntries(
  Object.entries(sources).map(([key, source]) => [
    key,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hook = `
const target=${JSON.stringify(target)};const urls=${JSON.stringify(urls)};
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith(target) && urls[specifier]) {
    return { url: urls[specifier], shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  if (context.parentURL?.endsWith(target)) {
    for (const [key, url] of Object.entries(urls)) {
      if (resolved.url.endsWith(key)) return { url, shortCircuit: true };
    }
  }
  return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__rinTuiPatchesOwner ||= {
  events: [],
  notice: null,
  currentVersion: "1.2.3",
  entries: [],
  newEntries: [],
  pages: [],
  extensionStates: [],
  extensionError: undefined,
  footerLines: ["cwd", "stats", "tail"],
  selector: undefined,
  classes: undefined,
};
