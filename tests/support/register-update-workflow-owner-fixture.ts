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
const progressSource = `
  export function restoreTerminalCursor() {
    globalThis.__rinUpdateWorkflowEvents.push(["restore-cursor"]);
  }
  export async function runInstallerProgress(message, action) {
    globalThis.__rinUpdateWorkflowEvents.push(["progress", message]);
    return await action();
  }
`;
const urls = {
  "node:fs": `data:text/javascript,${encodeURIComponent(fsSource)}`,
  "dist/core/rin-install/progress.js": `data:text/javascript,${encodeURIComponent(progressSource)}`,
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
