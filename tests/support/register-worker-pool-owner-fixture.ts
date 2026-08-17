import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "dist/core/rin-daemon/worker-pool.js";
const childProcessSource = `
  import * as childProcess from "node:child_process";
  export function spawn(...args) {
    globalThis.__rinWorkerPoolOwnerSpawnCalls.push(args);
    const replacement = globalThis.__rinWorkerPoolOwnerSpawn;
    return replacement ? replacement(...args) : childProcess.spawn(...args);
  }
`;
const childProcessUrl = `data:text/javascript,${encodeURIComponent(childProcessSource)}`;
const hookSource = `
const target = ${JSON.stringify(target)};
const childProcessUrl = ${JSON.stringify(childProcessUrl)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:child_process" && context.parentURL?.endsWith(target)) {
    return { url: childProcessUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);

(globalThis as any).__rinWorkerPoolOwnerSpawnCalls ||= [];
