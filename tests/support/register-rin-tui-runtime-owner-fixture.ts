import { register } from "node:module";

const target = "dist/core/rin-tui/runtime.js";
const sources: Record<string, string> = {
  "dist/core/rin-lib/profile.js": `
    export function resolveRuntimeProfile() {
      return globalThis.__rinTuiRuntimeOwner.profile;
    }
    export function getRuntimeSessionDir(cwd, agentDir) {
      globalThis.__rinTuiRuntimeOwner.events.push(["session-dir", cwd, agentDir]);
      return agentDir + "/sessions";
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
  const resolved = await nextResolve(specifier, context);
  if (context.parentURL?.endsWith(target)) {
    for (const [key, url] of Object.entries(urls)) {
      if (resolved.url.endsWith(key)) return { url, shortCircuit: true };
    }
  }
  return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__rinTuiRuntimeOwner ||= {
  profile: { cwd: "/owner/work", agentDir: "/owner/agent" },
  events: [],
};
