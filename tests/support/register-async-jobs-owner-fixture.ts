import { register } from "node:module";

const fixtureSource = `
export async function maintainMemory(_context, options) {
  globalThis.__rinAsyncJobsOwnerCalls.push({ ...options });
  const behavior = globalThis.__rinAsyncJobsOwnerBehaviors.shift() || {};
  if (behavior.throwMessage) throw new Error(behavior.throwMessage);
  return behavior.result || {
    skipped: "",
    output: "owner maintenance complete",
    changedFiles: [],
  };
}
`;
const replacementUrl = `data:text/javascript,${encodeURIComponent(fixtureSource)}`;
const hookSource = `
const replacementUrl = ${JSON.stringify(replacementUrl)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith("dist/core/self-improve/maintainer.js")) {
    return { url: replacementUrl, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
