import console from "node:console";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startDaemon } from "../../dist/core/rin-daemon/daemon.js";

const [socketPath, workerPath] = process.argv.slice(2);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const daemon = await startDaemon({
  socketPath,
  workerPath,
  selfImproveWorkerPath: path.join(
    rootDir,
    "dist",
    "app",
    "rin-daemon",
    "self-improve-worker.js",
  ),
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await daemon.shutdown();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
