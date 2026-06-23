import { syncAgentPracticesDocs } from "../docs/practices-sync.js";
import { resolveRuntimeProfile } from "../rin-lib/profile.js";

export async function runDocsInternal(argv: string[]) {
  const command = String(argv[0] || "").trim();
  if (command !== "sync-practices") {
    throw new Error(`unknown_docs_internal_command:${command || "<empty>"}`);
  }
  const profile = resolveRuntimeProfile({});
  const result = await syncAgentPracticesDocs(profile.agentDir, {
    logger: console,
  });
  console.log(
    JSON.stringify({
      synced: true,
      source: result.source,
      targetDir: result.targetDir,
      fileCount: result.files.length,
      syncedAt: result.syncedAt,
    }),
  );
}
