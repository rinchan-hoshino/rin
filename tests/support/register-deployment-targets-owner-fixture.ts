import { register } from "node:module";

const childProcessSource = `
  export function spawnSync(command, args = [], options = {}) {
    globalThis.__rinDeploymentOwnerEvents.push(["spawn", command, args, options]);
    return globalThis.__rinDeploymentOwnerSpawn(command, args, options);
  }
  export function execFileSync(command, args = [], options = {}) {
    globalThis.__rinDeploymentOwnerEvents.push(["capture", command, args, options]);
    return globalThis.__rinDeploymentOwnerCapture(command, args, options);
  }
`;
const osSource = `
  const os = {
    homedir() { return process.env.RIN_TEST_DEPLOYMENT_HOME; },
    tmpdir() { return process.env.RIN_TEST_DEPLOYMENT_TMP; },
  };
  export default os;
  export const homedir = os.homedir;
  export const tmpdir = os.tmpdir;
`;
const storeSource = `
  export function upsertTarget(target) {
    globalThis.__rinDeploymentOwnerEvents.push(["upsert", target]);
    return target;
  }
`;
const replacements = {
  "node:child_process": `data:text/javascript,${encodeURIComponent(childProcessSource)}`,
  "node:os": `data:text/javascript,${encodeURIComponent(osSource)}`,
  "dist/core/rin-targets/store.js": `data:text/javascript,${encodeURIComponent(storeSource)}`,
};
const hookSource = `
const replacements = ${JSON.stringify(replacements)};
export async function resolve(specifier, context, nextResolve) {
  if (replacements[specifier]) return { url: replacements[specifier], shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  for (const [target, replacementUrl] of Object.entries(replacements)) {
    if (!target.startsWith("node:") && resolved.url.endsWith(target)) {
      return { url: replacementUrl, shortCircuit: true };
    }
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
