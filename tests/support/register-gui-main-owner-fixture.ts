import fs from "node:fs";
import { register } from "node:module";

const target = "dist/core/rin-gui/native-desktop.js";
const replacement = `
  import fs from "node:fs";
  export async function runNativeDesktopGui(options) {
    fs.appendFileSync(
      process.env.RIN_TEST_GUI_MAIN_LOG,
      JSON.stringify({
        connected: options.client.isConnected(),
        settingsPath: options.settingsPath,
        mode: process.env.RIN_TEST_GUI_MAIN_MODE || "success",
      }) + "\\n",
    );
    if (process.env.RIN_TEST_GUI_MAIN_MODE === "fail") {
      throw new Error("owner_gui_failure");
    }
  }
`;
const replacementUrl = `data:text/javascript,${encodeURIComponent(replacement)}`;
const hookSource = `
const target = ${JSON.stringify(target)};
const replacementUrl = ${JSON.stringify(replacementUrl)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith(target)) {
    return { url: replacementUrl, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);

if (!process.env.RIN_TEST_GUI_MAIN_LOG) {
  fs.writeSync(2, "RIN_TEST_GUI_MAIN_LOG is required\n");
  process.exit(2);
}
