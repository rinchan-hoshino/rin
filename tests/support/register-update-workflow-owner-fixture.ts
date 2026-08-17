import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "dist/core/rin-install/update-workflow.js";
const fsSource = `
  import actual from "node:fs";
  const proxy = new Proxy(actual, {
    get(value, key) {
      if (key === "existsSync") {
        return (filePath) => {
          if (globalThis.__rinUpdateWorkflowScenario?.hideDownloadTools &&
              (filePath === "/usr/bin/curl" || filePath === "/usr/bin/wget")) return false;
          return value.existsSync(filePath);
        };
      }
      return value[key];
    }
  });
  export default proxy;
  export const Dirent = actual.Dirent;
`;
const cryptoSource = `
  import * as actual from "node:crypto";
  const expected = "e84875bb943e908557780f1eee5d9cfc7a67145730ae4b77ef10ccba30f96ded6096859af69ea3dc5b2fde60725d79aa247cbed9c12544c30bf28a4d4fbc4825";
  export function createHash(algorithm) {
    if (globalThis.__rinUpdateWorkflowScenario?.mockManagedNpmDownload && algorithm === "sha512") {
      return { update() { return this; }, digest() { return expected; } };
    }
    return actual.createHash(algorithm);
  }
`;
const childProcessSource = `
  import * as actual from "node:child_process";
  import fs from "node:fs";
  import os from "node:os";
  import path from "node:path";
  export const spawn = actual.spawn;
  export function execFileSync(command, args = [], options) {
    if (globalThis.__rinUpdateWorkflowScenario?.mockManagedNpmDownload && args.some((arg) => String(arg).includes("registry.npmjs.org/npm/-/npm-10.9.3.tgz"))) {
      const output = String(args[args.indexOf("-o") + 1]);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rin-owner-npm-"));
      try {
        const packageRoot = path.join(root, "package");
        fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "npm", version: "10.9.3" }));
        fs.writeFileSync(path.join(packageRoot, "bin", "npm-cli.js"), "console.log('10.9.3');\\n");
        actual.execFileSync("tar", ["-czf", output, "-C", root, "package"]);
        return Buffer.from("");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    return actual.execFileSync(command, args, options);
  }
`;
const progressSource = `
  export function restoreTerminalCursor() {
    globalThis.__rinUpdateWorkflowEvents.push(["restore-cursor"]);
  }
  export async function runInstallerProgress(message, action) {
    globalThis.__rinUpdateWorkflowEvents.push(["progress", message]);
    return await action();
  }
`;
const httpSource = `
  export function createRinHttpTransport() {
    return {
      fetch: (url, options) => globalThis.fetch(url, options),
      async close() {},
    };
  }
  export async function discardRinHttpResponseBody() {}
`;
const urls = {
  "node:fs": `data:text/javascript,${encodeURIComponent(fsSource)}`,
  "node:crypto": `data:text/javascript,${encodeURIComponent(cryptoSource)}`,
  "node:child_process": `data:text/javascript,${encodeURIComponent(childProcessSource)}`,
  "dist/core/rin-install/progress.js": `data:text/javascript,${encodeURIComponent(progressSource)}`,
  "dist/core/http/transport.js": `data:text/javascript,${encodeURIComponent(httpSource)}`,
};
const hook = `
const target=${JSON.stringify(target)};
const urls=${JSON.stringify(urls)};
export async function resolve(specifier,context,nextResolve){
  if(context.parentURL?.endsWith(target) && urls[specifier]) return {url:urls[specifier],shortCircuit:true};
  const resolved=await nextResolve(specifier,context);
  if(context.parentURL?.endsWith(target)) {
    for(const [key,url] of Object.entries(urls)) if(!key.startsWith("node:") && resolved.url.endsWith(key)) return {url,shortCircuit:true};
  }
  return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

globalThis.__rinUpdateWorkflowScenario ||= {};
globalThis.__rinUpdateWorkflowEvents ||= [];
