import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";

export default function taskModule(): RinCapabilityDefinition {
  return {
    name: "task",
    tools: [],
  };
}
