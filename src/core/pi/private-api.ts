// Centralized access to Pi implementation details that Rin still needs while
// keeping Pi as an npm dependency. Code outside src/core/pi should not import
// node_modules/@earendil-works/pi-coding-agent/dist directly.

export { APP_NAME } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/config.js";
export { formatKeyText } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.js";
export {
  initTheme,
  onThemeChange,
  theme,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
export {
  ensureTool,
  getToolPath,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js";

export type PiManagedTool = "fd" | "rg";
export type PiEnsureTool = (
  tool: PiManagedTool,
  silent?: boolean,
) => Promise<string | undefined>;

export function getPiToolsManagerModuleUrl() {
  return new URL(
    "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js",
    import.meta.url,
  ).href;
}

export async function loadPiToolsManagerModule(
  moduleUrl = getPiToolsManagerModuleUrl(),
): Promise<{
  ensureTool?: PiEnsureTool;
  getToolPath?: (name: string) => string;
}> {
  return (await import(moduleUrl)) as {
    ensureTool?: PiEnsureTool;
    getToolPath?: (name: string) => string;
  };
}
