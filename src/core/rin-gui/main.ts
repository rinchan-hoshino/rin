import { installSettingsPath } from "../rin-install/paths.js";
import {
  RinDaemonFrontendClient,
  sourceFrontendIdentity,
} from "../rin-frontend-sdk/index.js";
import {
  assertDaemonAvailable,
  createTargetExecutionContext,
  extractSubcommandArgv,
  ParsedArgs,
} from "../rin/shared.js";

import { runNativeDesktopGui } from "./native-desktop.js";
import { parseRinGuiArgs } from "./web-assets.js";

export async function runGui(parsed: ParsedArgs, rawArgv: string[] = []) {
  const guiArgs = extractSubcommandArgv(rawArgv, "gui");
  parseRinGuiArgs(guiArgs);
  const context = createTargetExecutionContext(parsed);

  await assertDaemonAvailable(context);

  const client = new RinDaemonFrontendClient({
    socketPath: context.socketPath,
    frontendIdentity: sourceFrontendIdentity("gui"),
  });
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
