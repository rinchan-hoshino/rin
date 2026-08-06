import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const controlTarget = "dist/core/rin/control.js";
const usersTarget = "dist/core/rin-install/users.js";
const controlReplacement = `
  import fs from "node:fs";
  export async function runRestart(parsed) {
    fs.appendFileSync(
      process.env.RIN_TEST_VERSIONS_RESTART_LOG,
      JSON.stringify({ targetUser: parsed.targetUser, installDir: parsed.installDir }) + "\\n",
    );
  }
`;
const actualUsersUrl = `${
  pathToFileURL(path.resolve("dist/core/rin-install/users.js")).href
}?owner-actual`;
const usersReplacement = `
  export * from ${JSON.stringify(actualUsersUrl)};
  export function findSystemUser(name) {
    return { name, home: process.env.RIN_TEST_VERSIONS_HOME, uid: 1000, gid: 1000 };
  }
  export function homeForUser() {
    return process.env.RIN_TEST_VERSIONS_HOME;
  }
  export function targetHomeForUser() {
    return process.env.RIN_TEST_VERSIONS_HOME;
  }
`;
const replacements = {
  [controlTarget]: `data:text/javascript,${encodeURIComponent(controlReplacement)}`,
  [usersTarget]: `data:text/javascript,${encodeURIComponent(usersReplacement)}`,
};
const hookSource = `
const replacements = ${JSON.stringify(replacements)};
const actualUsersUrl = ${JSON.stringify(actualUsersUrl)};
export async function resolve(specifier, context, nextResolve) {
  if (String(specifier).includes("owner-actual")) {
    return { url: actualUsersUrl, shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  if (
    String(context.parentURL || "").startsWith("data:text/javascript") &&
    resolved.url.includes("dist/core/rin-install/users.js")
  ) {
    return resolved;
  }
  for (const [target, replacementUrl] of Object.entries(replacements)) {
    if (resolved.url.endsWith(target)) {
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

if (
  !process.env.RIN_TEST_VERSIONS_RESTART_LOG ||
  !process.env.RIN_TEST_VERSIONS_HOME
) {
  fs.writeSync(
    2,
    "RIN_TEST_VERSIONS_RESTART_LOG and RIN_TEST_VERSIONS_HOME are required\n",
  );
  process.exit(2);
}
