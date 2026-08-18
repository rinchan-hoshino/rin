import {
  TARGET_KIND_LABELS,
  normalizeTargetName,
} from "../rin-targets/registry.js";
import { listTargets, removeTarget } from "../rin-targets/store.js";
import { safeString } from "../text-utils.js";

function usage() {
  return ["Usage:", "  rin target list", "  rin target remove <name>"].join(
    "\n",
  );
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
      const marker = " ";
      const label = TARGET_KIND_LABELS[target.kind] || target.kind;
      console.log(
        `${marker} ${target.name}\t${label}\t${describeRuntime(target.runtime)}`,
      );
    }
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
