import {
  TARGET_KIND_LABELS,
  findDeploymentProviders,
  normalizeTargetName,
} from "../rin-targets/registry.js";
import {
  findTarget,
  listTargets,
  removeTarget,
  setDefaultTarget,
  upsertTarget,
} from "../rin-targets/store.js";
import { safeString } from "../text-utils.js";

function usage() {
  return [
    "Usage:",
    "  rin target list",
    "  rin target use <name>",
    "  rin target remove <name>",
    "  rin target providers [container]",
  ].join("\n");
}

export async function runTargetCommand(rawArgv: string[]) {
  const args = rawArgv.slice();
  const commandIndex = args.indexOf("target");
  const subArgs = commandIndex >= 0 ? args.slice(commandIndex + 1) : args;
  const subcommand = safeString(subArgs[0]).trim() || "list";

  if (subcommand === "list") {
    const targets = listTargets();
    if (!targets.length) {
      console.log("No Rin targets configured.");
      return;
    }
    for (const target of targets) {
      const marker = target.default ? "*" : " ";
      const label = TARGET_KIND_LABELS[target.kind] || target.kind;
      console.log(
        `${marker} ${target.name}\t${label}\t${describeRuntime(target.runtime)}`,
      );
    }
    return;
  }

  if (subcommand === "use") {
    const name = normalizeTargetName(subArgs[1] || "");
    if (!name) throw new Error("rin_target_name_required");
    setDefaultTarget(name);
    console.log(`Default Rin target: ${name}`);
    return;
  }

  if (subcommand === "remove") {
    const name = normalizeTargetName(subArgs[1] || "");
    if (!name) throw new Error("rin_target_name_required");
    const removed = removeTarget(name);
    console.log(
      removed ? `Removed Rin target: ${name}` : `Rin target not found: ${name}`,
    );
    return;
  }

  if (subcommand === "providers") {
    const kind = safeString(subArgs[1]).trim();
    const providers =
      !kind || kind === "container" ? findDeploymentProviders("container") : [];
    for (const provider of providers) {
      console.log(
        `${provider.kind}/${provider.id}\t${provider.label}\t${provider.recommendedIsolation}`,
      );
    }
    return;
  }

  if (subcommand === "register-local-user") {
    const name = normalizeTargetName(subArgs[1] || "");
    const user = safeString(subArgs[2]).trim();
    if (!name || !user) throw new Error("rin_target_register_local_user_usage");
    upsertTarget({
      name,
      kind: "local-user",
      runtime: { kind: "local-user", user },
    });
    console.log(`Registered Rin target: ${name}`);
    return;
  }

  if (subcommand === "show") {
    const name = normalizeTargetName(subArgs[1] || "");
    const target = findTarget(name);
    if (!target) throw new Error(`rin_target_not_found:${name}`);
    console.log(JSON.stringify(target, null, 2));
    return;
  }

  console.log(usage());
}

function describeRuntime(runtime: any) {
  if (runtime?.kind === "local-user") return runtime.user;
  if (runtime?.kind === "ssh")
    return runtime.user ? `${runtime.user}@${runtime.host}` : runtime.host;
  if (runtime?.kind === "container")
    return `${runtime.engine}:${runtime.container}`;
  return "unknown";
}
