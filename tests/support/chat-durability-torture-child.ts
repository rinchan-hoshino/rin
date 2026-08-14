import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist/core/chat/database.js")).href
);
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist/core/chat/outbox.js")).href
);

const [mode, agentDir, chatKey, value, outputPath] = process.argv.slice(2);
if (!mode || !agentDir || !chatKey || !value) {
  throw new Error("torture_child_arguments_required");
}

if (mode === "crash-after-claim") {
  if (!outputPath) throw new Error("torture_child_output_required");
  const dispatchBits = [...value].map((bit) => bit === "1");
  const items = dispatchBits.map((dispatchStarted, index) => {
    const id = outbox.enqueueChatOutboxPayload(
      agentDir,
      {
        createdAt: new Date().toISOString(),
        chatKey,
        parts: [{ type: "text", text: `crash-${index}` }],
      },
      { deliveryKind: "interim" },
    );
    const claimed = outbox.claimChatOutboxItem(agentDir, id, {
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    if (!claimed) throw new Error(`torture_claim_failed:${id}`);
    if (
      dispatchStarted &&
      !outbox.markChatOutboxDispatchStarted(agentDir, claimed)
    ) {
      throw new Error(`torture_dispatch_marker_failed:${id}`);
    }
    return { id, dispatchStarted };
  });
  fs.writeFileSync(outputPath, JSON.stringify({ items }));
  process.exit(91);
}

if (mode === "allocate") {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("torture_allocation_count_invalid");
  }
  const allocations = Array.from({ length: count }, () =>
    database.allocateChatSequence(agentDir, chatKey),
  );
  database.closeChatDatabase(agentDir);
  process.stdout.write(JSON.stringify(allocations));
} else {
  throw new Error(`torture_child_mode_unknown:${mode}`);
}
