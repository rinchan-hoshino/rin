import "./require-test-sandbox.ts";
import { register } from "node:module";

const replacement = `data:text/javascript,${encodeURIComponent(`
export async function enqueueSelfImproveMaintenanceJob(job) {
  globalThis.__rinSelfImproveIndexOwnerCalls.push(job);
  if (globalThis.__rinSelfImproveIndexOwnerError) {
    throw globalThis.__rinSelfImproveIndexOwnerError;
  }
  return { status: "queued" };
}
`)}`;
const hook = `
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.includes("dist/core/self-improve/maintenance-queue.js")) {
    return { url: ${JSON.stringify(replacement)}, shortCircuit: true };
  }
  return resolved;
}
`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
(globalThis as any).__rinSelfImproveIndexOwnerCalls ||= [];
(globalThis as any).__rinSelfImproveIndexOwnerError = undefined;
