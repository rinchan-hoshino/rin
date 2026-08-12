import { register } from "node:module";

const target = "dist/core/self-improve/audit-observer.js";
const dependency = "dist/core/self-improve/run-audit.js";
const source = `
  const state = () => globalThis.__rinAuditObserverOwnerState ?? {};
  export function sanitizeSelfImproveHistoryText(value) {
    const text = String(value).slice(0, 40);
    return { text, truncated: text.length !== String(value).length };
  }
  export async function beginSelfImproveRunAudit(options) {
    if (state().beginError) throw state().beginError;
    state().calls?.push(["begin", options]);
    return { auditId: "owner-audit", runId: options.runId };
  }
  export async function completeSelfImproveRunAudit(options) {
    if (state().completeError) throw state().completeError;
    state().calls?.push(["complete", options]);
    return {
      path: "runs/owner.json",
      changedFiles: [{ path: "owner.ts", change: "updated" }],
    };
  }
`;
const replacement = `data:text/javascript,${encodeURIComponent(source)}`;
const hook = `
const target=${JSON.stringify(target)};
const dependency=${JSON.stringify(dependency)};
const replacement=${JSON.stringify(replacement)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (context.parentURL?.endsWith(target) && resolved.url.endsWith(dependency)) {
    return { url: replacement, shortCircuit: true };
  }
  return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
