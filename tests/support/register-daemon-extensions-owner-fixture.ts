import { register } from "node:module";

const target = "dist/core/rin-daemon/extensions.js";
const sources: Record<string, string> = {
  "node:child_process": `export function execFileSync(...args) { globalThis.__rinExtensionsOwnerEvents.push(["exec", ...args]); if (globalThis.__rinExtensionsOwnerScenario.installError) throw globalThis.__rinExtensionsOwnerScenario.installError; return Buffer.from(""); }`,
  "dist/core/rin-bundled-extensions.js": `export function applyBundledRinExtensionAliases(manager) { globalThis.__rinExtensionsOwnerEvents.push(["aliases", manager]); }`,
  "dist/core/rin-extension-settings.js": `
    import fs from "node:fs"; import path from "node:path";
    export function readRuntimeSettings(agentDir) { globalThis.__rinExtensionsOwnerEvents.push(["settings", agentDir]); return globalThis.__rinExtensionsOwnerScenario.settings; }
    export function listRinDaemonExtensionConfigs(settings) { globalThis.__rinExtensionsOwnerEvents.push(["configs", settings]); return globalThis.__rinExtensionsOwnerScenario.entries || []; }
    export function getRinExtensionRuntimeRoot(agentDir) { return path.join(agentDir, "data", "extensions", "runtime"); }
    export function ensureRuntimeImporter(runtimeRoot, name) { const file = path.join(runtimeRoot, name); fs.mkdirSync(runtimeRoot, { recursive: true }); fs.writeFileSync(file, "export async function importProvider(name){ return globalThis.__rinExtensionsOwnerModules[name]; }\\n"); return file; }
  `,
  "dist/core/rin-lib/agent-runtime.js": `
    export async function loadRinAgentRuntime() { globalThis.__rinExtensionsOwnerEvents.push(["load-runtime"]); if (globalThis.__rinExtensionsOwnerScenario.resolveError) throw globalThis.__rinExtensionsOwnerScenario.resolveError; return {
      SettingsManager: { create(cwd, agentDir) { return { cwd, agentDir }; } },
      DefaultPackageManager: class { constructor(options) { this.options = options; } async resolve() { globalThis.__rinExtensionsOwnerEvents.push(["resolve", this.options]); return { extensions: globalThis.__rinExtensionsOwnerScenario.piEntries || [] }; } }
    }; }
  `,
  "dist/core/memory/external-results.js": `
    export function normalizeExternalMemoryLimit(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback; }
    export function normalizeExternalMemoryResults(value, options) { const rows = Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : []; return rows.map((row, index) => ({ sourceType: "external", provider: options.provider, score: row.score ?? options.startScore - index, ...row })); }
  `,
  "dist/core/platform/fs.js": `
    import fs from "node:fs";
    export function ensureDir(dir) { globalThis.__rinExtensionsOwnerEvents.push(["ensure", dir]); fs.mkdirSync(dir, { recursive: true }); }
    export function stringifyJson(value) { return JSON.stringify(value, null, 2) + "\\n"; }
  `,
  "dist/core/platform/process.js": `export async function sleep(ms) { globalThis.__rinExtensionsOwnerEvents.push(["sleep", ms]); }`,
  "dist/core/text-utils.js": `export function safeString(value) { return value == null ? "" : String(value); }`,
};
const urls = Object.fromEntries(
  Object.entries(sources).map(([key, source]) => [
    key,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hook = `
const target=${JSON.stringify(target)};const urls=${JSON.stringify(urls)};
export async function resolve(specifier,context,nextResolve){
 if(specifier === "node:child_process" && context.parentURL?.endsWith(target)) return {url:urls[specifier],shortCircuit:true};
 const resolved=await nextResolve(specifier,context);
 if(context.parentURL?.endsWith(target)) for(const [key,url] of Object.entries(urls)) if(resolved.url.endsWith(key)) return {url,shortCircuit:true};
 return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__rinExtensionsOwnerEvents ||= [];
(globalThis as any).__rinExtensionsOwnerScenario ||= {};
(globalThis as any).__rinExtensionsOwnerModules ||= {};
