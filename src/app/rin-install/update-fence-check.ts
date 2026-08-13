#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoDaemonUpdateInProgress } from "../../core/rin-daemon/lock.js";
import { formatRuntimeErrorForUser } from "../../core/presentation/error.js";
import { socketPathForUser } from "../../core/rin-lib/system.js";

export async function main(argv = process.argv.slice(2)) {
  const [agentDir, targetUser] = argv;
  if (!agentDir || !targetUser) {
    throw new Error("rin_update_fence_check_args_missing");
  }
  await assertNoDaemonUpdateInProgress(agentDir, {
    socketPath: socketPathForUser(targetUser),
  });
}

const invoked = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${formatRuntimeErrorForUser(error)}\n`);
    process.exit(1);
  });
}
