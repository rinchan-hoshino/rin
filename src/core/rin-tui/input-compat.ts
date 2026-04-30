import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";

export function isExplicitNewlineInput(data: string): boolean {
  return matchesKey(data, "ctrl+j");
}

class TuiInputCompatEditor extends CustomEditor {
  handleInput(data: string): void {
    // Compatibility alias for terminals / transport stacks that surface
    // Ctrl+J as the most reliable explicit newline shortcut.
    if (isExplicitNewlineInput(data)) {
      this.insertTextAtCursor("\n");
      return;
    }

    super.handleInput(data);
  }
}

export default function tuiInputCompatModule(): RinCapabilityDefinition {
  return {
    name: "tui-input-compat",
    hooks: {
      session_start: [
        (_event, ctx) => {
          ctx.ui.setEditorComponent(
            (tui: any, theme: any, keybindings: any) =>
              new TuiInputCompatEditor(tui, theme, keybindings),
          );
        },
      ],
    },
  };
}
