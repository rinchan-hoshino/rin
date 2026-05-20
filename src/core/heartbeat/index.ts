import { Type } from "typebox";

import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import { requestDaemonCommand } from "../rin-daemon/client.js";

function normalizeEntryIds(value: unknown) {
  const raw = Array.isArray(value) ? value : [value];
  return Array.from(
    new Set(raw.map((item) => String(item || "").trim()).filter(Boolean)),
  );
}

export default function heartbeatModule(
  _options: RinCapabilityOptions,
): RinCapabilityDefinition {
  return {
    name: "heartbeat",
    tools: [
      {
        name: "mark_heartbeat_info_read",
        label: "Mark Heartbeat Info Read",
        description:
          "Mark heartbeat inbox information entries as read after the root heartbeat has reviewed or delegated them.",
        promptSnippet:
          "Mark heartbeat inbox entries read after reviewing or delegating them.",
        promptGuidelines: [
          "Use mark_heartbeat_info_read only from a heartbeat inbox run, after you have reviewed or delegated the listed information.",
          "Do not use this tool to execute the requested work; the root heartbeat manages sub-persona heartbeat work instead of doing concrete execution itself.",
        ],
        parameters: Type.Object({
          heartbeatTaskId: Type.String({
            description:
              "The heartbeatTaskId from the heartbeat inbox context.",
          }),
          entryIds: Type.Array(Type.String(), {
            description: "Heartbeat inbox entry ids to mark read.",
          }),
          result: Type.Optional(
            Type.String({
              description:
                "Concise note about the review or delegation outcome.",
            }),
          ),
        }),
        execute: async (_toolCallId, params) => {
          const heartbeatTaskId = String(
            (params as any)?.heartbeatTaskId || "",
          ).trim();
          if (!heartbeatTaskId) throw new Error("heartbeat_task_id_required");
          const entryIds = normalizeEntryIds((params as any)?.entryIds);
          if (!entryIds.length) throw new Error("heartbeat_entry_ids_required");
          const result = String((params as any)?.result || "").trim();
          return await requestDaemonCommand({
            type: "heartbeat_mark_read",
            taskId: heartbeatTaskId,
            entryIds,
            actorId: heartbeatTaskId,
            result,
          });
        },
      },
    ],
  };
}
