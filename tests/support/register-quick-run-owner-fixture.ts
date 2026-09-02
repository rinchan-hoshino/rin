import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "dist/core/rin-install/quick-run.js";
const sources: Record<string, string> = {
  "node:os": `
    export default { homedir() { return globalThis.__rinQuickRunScenario.home; } };
  `,
  "node:child_process": `
    import { EventEmitter } from "node:events";
    class FixtureChild extends EventEmitter {
      killed = false;
      exitCode = null;
      signalCode = null;
      constructor(kind) {
        super();
        this.kind = kind;
      }
      finish(code, signal = null) {
        if (this.exitCode != null || this.signalCode) return;
        this.exitCode = code;
        this.signalCode = signal;
        this.emit("exit", code, signal);
      }
      kill(signal = "SIGTERM") {
        if (this.exitCode != null || this.signalCode) return false;
        this.killed = true;
        queueMicrotask(() => this.finish(null, signal));
        return true;
      }
    }
    export function spawn(command, args, options) {
      const scenario = globalThis.__rinQuickRunScenario;
      const kind = String(args[0]).includes("rin-daemon") ? "daemon" : "tui";
      const child = new FixtureChild(kind);
      globalThis.__rinQuickRunEvents.push(["spawn", kind, command, args, options]);
      globalThis.__rinQuickRunChildren.push(child);
      if (kind === "daemon" && scenario.daemonExit) {
        queueMicrotask(() => child.finish(scenario.daemonExit, null));
      }
      if (kind === "tui" && !scenario.holdTui) {
        queueMicrotask(() => child.finish(scenario.tuiCode ?? 0, scenario.tuiSignal ?? null));
      }
      return child;
    }
  `,
  "@clack/prompts": `
    export function isCancel(value) { return value === Symbol.for("rin-owner-cancel"); }
    export function cancel(message) { globalThis.__rinQuickRunEvents.push(["cancel", message]); }
    export async function select(options) { globalThis.__rinQuickRunEvents.push(["select", options]); return "selected"; }
    export async function text(options) { globalThis.__rinQuickRunEvents.push(["text", options]); return "text"; }
    export async function confirm(options) { globalThis.__rinQuickRunEvents.push(["confirm", options]); return true; }
  `,
  "dist/core/rin-daemon/client.js": `
    export async function canConnectDaemonSocket(socketPath, timeout) {
      const scenario = globalThis.__rinQuickRunScenario;
      const call = ++globalThis.__rinQuickRunConnectCalls;
      globalThis.__rinQuickRunEvents.push(["connect", call, socketPath, timeout]);
      if (call === 1) return Boolean(scenario.alreadyRunning);
      if (scenario.daemonExit || scenario.neverReady) return false;
      if (scenario.shutdownTrigger && !scenario.shutdownScheduled) {
        scenario.shutdownScheduled = true;
        setTimeout(() => {
          if (scenario.shutdownTrigger === "stdin") process.stdin.emit("end");
          else process.emit(scenario.shutdownTrigger);
        }, 10);
      }
      return true;
    }
  `,
  "dist/core/rin-lib/common.js": `
    export function defaultDaemonSocketPath() { return globalThis.__rinQuickRunScenario.socketPath; }
  `,
  "dist/core/rin-install/common.js": `
    export function detectCurrentUser() { return globalThis.__rinQuickRunScenario.currentUser; }
    export function repoRootFromHere() { return globalThis.__rinQuickRunScenario.sourceRoot; }
  `,
  "dist/core/rin-install/finalize.js": `
    import fs from "node:fs";
    import path from "node:path";
    export async function finalizeQuickRunInstall(plan) {
      globalThis.__rinQuickRunEvents.push(["finalize", plan]);
      fs.writeFileSync(path.join(plan.installDir, "quick-run-finalized.json"), JSON.stringify(plan));
      return { plan };
    }
  `,
  "dist/core/product-copy.js": `
    export function createInstallerCopy(language) {
      return {
        language,
        loadingModelChoicesMessage: "loading models",
        preparingInstallerMessage: "preparing quick run",
        installStepComplete: "complete",
        installStepFailed: "failed",
        confirmActiveLabel: "yes",
        confirmInactiveLabel: "no",
      };
    }
  `,
  "dist/core/rin-install/interactive.js": `
    export async function promptProviderSetup(promptApi, installDir, readJsonFile, defaults, copy) {
      globalThis.__rinQuickRunEvents.push(["prompt-provider", installDir, defaults, copy.language]);
      promptApi.ensureNotCancelled(await promptApi.select({ message: "provider" }));
      await promptApi.text({ message: "model" });
      await promptApi.confirm({ message: "confirm", initialValue: true });
      return globalThis.__rinQuickRunScenario.promptSetup;
    }
  `,
  "dist/core/rin-install/provider-auth.js": `
    export async function loadModelChoices(installDir, readJsonFile) {
      globalThis.__rinQuickRunEvents.push(["load-models", installDir]);
      return globalThis.__rinQuickRunScenario.models;
    }
  `,
  "dist/core/rin-install/progress.js": `
    export async function runInstallerProgress(message, action, options) {
      globalThis.__rinQuickRunEvents.push(["progress", message, options]);
      return await action();
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
const target = ${JSON.stringify(target)};
const urls = ${JSON.stringify(urls)};
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith(target) && urls[specifier]) {
    return { url: urls[specifier], shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  if (context.parentURL?.endsWith(target)) {
    for (const [key, url] of Object.entries(urls)) {
      if (!key.startsWith("node:") && !key.startsWith("@") && resolved.url.endsWith(key)) {
        return { url, shortCircuit: true };
      }
    }
  }
  return resolved;
}
`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

globalThis.__rinQuickRunEvents ||= [];
globalThis.__rinQuickRunChildren ||= [];
globalThis.__rinQuickRunConnectCalls ||= 0;
globalThis.__rinQuickRunScenario ||= {};
