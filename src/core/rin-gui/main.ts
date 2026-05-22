import { installSettingsPath } from "../rin-install/paths.js";
import { RinDaemonFrontendClient } from "../rin-frontend-sdk/index.js";
import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  extractSubcommandArgv,
  ParsedArgs,
} from "../rin/shared.js";

import { runNativeDesktopGui } from "./native-desktop.js";
import { parseRinGuiArgs } from "./web-assets.js";

export async function runGui(parsed: ParsedArgs, rawArgv: string[] = []) {
  const guiArgs = extractSubcommandArgv(rawArgv, "gui");
  parseRinGuiArgs(guiArgs);
  const context = createTargetExecutionContext(parsed);

  await ensureDaemonAvailable(context);

  const client = new RinDaemonFrontendClient(context.socketPath);
  await client.connect();
  try {
    await runNativeDesktopGui({
      client,
      settingsPath: installSettingsPath(context.installDir),
    });
  } finally {
    await client.disconnect();
  }
}
