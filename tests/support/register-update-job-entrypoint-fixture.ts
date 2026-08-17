import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "dist/app/rin-install/update-job.js";
const replacement = `
export async function runUpdateJobExecutor(jobPath) {
  if (process.env.RIN_TEST_UPDATE_JOB_THROW === "run") throw new Error("fixture run failed");
  return Number(process.env.RIN_TEST_UPDATE_JOB_EXIT_CODE || 0);
}
export async function launchWindowsDetachedUpdateJob(entryPath, jobPath) {
  if (process.env.RIN_TEST_UPDATE_JOB_THROW === "detach") throw new Error("fixture detach failed");
}
`;
const hook = `
const target=${JSON.stringify(target)};
const replacement=${JSON.stringify(`data:text/javascript,${encodeURIComponent(replacement)}`)};
export async function resolve(specifier,context,nextResolve){
 const resolved=await nextResolve(specifier,context);
 if(context.parentURL?.includes(target) && resolved.url.endsWith("dist/core/rin/update-job.js")) return {url:replacement,shortCircuit:true};
 return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
