import type { RinCapabilityDefinition } from "./capability-types.js";

import {
  consumeCompactionContinuationMarker,
  clearCompactionContinuationMarker,
} from "./compaction-continuation.js";

const CONTINUATION_BLOCK = [
  "Context compacted; treat this as a routine internal checkpoint.",
  "Resume the current task immediately from its current state. Execute the next concrete step directly without narration, and keep going if work remains.",
].join("\n");

export default function autoCompactContinueModule(): RinCapabilityDefinition {
  return {
    name: "auto-compact-continue",
    hooks: {
      session_start: [
        async (_event, ctx) => {
          clearCompactionContinuationMarker(ctx);
        },
      ],
      before_agent_start: [
        async (event, ctx) => {
          const marker = consumeCompactionContinuationMarker(ctx);
          if (!marker) return;
          const systemPrompt = String(event?.systemPrompt || "").trim();
          return {
            systemPrompt: systemPrompt
              ? `${systemPrompt}\n\n${CONTINUATION_BLOCK}`
              : CONTINUATION_BLOCK,
          };
        },
      ],
    },
  };
}
