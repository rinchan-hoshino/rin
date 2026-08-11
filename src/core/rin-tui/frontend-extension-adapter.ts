import { withPiDefaultExtensionFactories } from "../pi/private-api.js";
import { loadRinAgentRuntime } from "../rin-lib/agent-runtime.js";
import type { TuiResourceOptions } from "./cli-options.js";

export async function loadRinFrontendExtensionDefinitions(options: {
  cwd: string;
  agentDir: string;
  resources: Partial<TuiResourceOptions>;
}): Promise<{ extensions: any[]; runtime: any }> {
  const PiAgent = await loadRinAgentRuntime();
  const settingsManager = PiAgent.SettingsManager.create(
    options.cwd,
    options.agentDir,
  );
  const loader = new PiAgent.DefaultResourceLoader(
    withPiDefaultExtensionFactories({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
      additionalExtensionPaths: [
        ...(options.resources.additionalExtensionPaths ?? []),
      ],
      noExtensions: options.resources.noExtensions,
    }),
  );
  await loader.reload();
  const result = loader.getExtensions();
  return { extensions: result.extensions, runtime: result.runtime };
}
