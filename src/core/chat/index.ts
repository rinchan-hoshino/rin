import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";

export default function chatModule(): RinCapabilityDefinition {
  return { name: "chat" };
}
