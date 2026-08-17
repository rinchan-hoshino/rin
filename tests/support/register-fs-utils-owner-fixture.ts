import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "dist/core/rin-install/fs-utils.js";
const sources: Record<string, string> = {
  "node:fs": `
    import realFs from "node:fs";
    const api = { ...realFs, readFileSync(...args) {
      const handler = globalThis.__rinFsUtilsOwnerScenario.readFileSync;
      return handler ? handler(...args) : realFs.readFileSync(...args);
    } };
    export default api;
  `,
  "node:child_process": `
    import { execFileSync as realExecFileSync } from "node:child_process";
    export function execFileSync(command, args, options) {
      globalThis.__rinFsUtilsOwnerEvents.push(["exec", command, args, options]);
      const handler = globalThis.__rinFsUtilsOwnerScenario.exec;
      return handler ? handler(command, args, options) : realExecFileSync(command, args, options);
    }
  `,
  "dist/core/rin-lib/system.js": `
    export function pickPrivilegeCommand() { return globalThis.__rinFsUtilsOwnerScenario.privilegeCommand || "/owner/privilege"; }
    export function shellQuote(value) { return "'" + String(value).replaceAll("'", String.fromCharCode(39, 34, 39, 34, 39)) + "'"; }
  `,
  "dist/core/time-utils.js": `export function nowFileTimestamp() { return "20260718-010203"; }`,
  "dist/core/rin-install/runtime-dependency-prune.js": `
    export function pruneDuplicatePiCodingAgentDependencies(root) { globalThis.__rinFsUtilsOwnerEvents.push(["prune", root]); }
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
export async function resolve(specifier,context,nextResolve){
 if((specifier === "node:child_process" || specifier === "node:fs") && context.parentURL?.endsWith(target)) return {url:urls[specifier],shortCircuit:true};
 const resolved=await nextResolve(specifier,context);
 if(context.parentURL?.endsWith(target)) for(const [key,url] of Object.entries(urls)) if(resolved.url.endsWith(key)) return {url,shortCircuit:true};
 return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__rinFsUtilsOwnerEvents ||= [];
(globalThis as any).__rinFsUtilsOwnerScenario ||= {};
