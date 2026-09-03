import fs from "node:fs";

import {
  canConnectDaemonSocket,
  requestDaemonCommand,
} from "../rin-daemon/client.js";
import {
  captureInternalRinCommand,
  createTargetExecutionContext,
  extractSubcommandArgv,
  type ParsedArgs,
  safeString,
} from "./shared.js";

type NerveCliOptions = {
  action: "status" | "abort" | "reload" | "emit";
  id: string;
  dedupeKey: string;
  body: string;
  json: boolean;
  help: boolean;
};

function printHelp() {
  console.log(
    [
      "rin nerve <status|abort|reload|emit> [options]",
      "",
      "  status                         show brain, queue, and trigger state",
      "  abort                          abort the active main-agent turn",
      "  reload [trigger-id]            reload one trigger or all triggers",
      "  emit --body <text>             enqueue one opaque sensation",
      "",
      "Options:",
      "  --dedupe-key <key>             opaque key for idempotent retries",
      "  --body-file <path>             read the sensation from a file",
      "  --json                         print JSON",
    ].join("\n"),
  );
}

function parseArgs(rawArgv: string[]): NerveCliOptions {
  const args = extractSubcommandArgv(rawArgv, "nerve");
  const actionValue = safeString(args.shift()).trim();
  const action =
    actionValue === "abort" ||
    actionValue === "reload" ||
    actionValue === "emit"
      ? actionValue
      : "status";
  const options: NerveCliOptions = {
    action,
    id: "",
    dedupeKey: "",
    body: "",
    json: false,
    help:
      actionValue === "help" ||
      actionValue === "--help" ||
      actionValue === "-h",
  };
  if (action === "reload" && args[0] && !args[0].startsWith("-")) {
    options.id = safeString(args.shift()).trim();
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--dedupe-key") {
      options.dedupeKey = safeString(args[++index]);
    } else if (arg === "--body") {
      options.body = safeString(args[++index]);
    } else if (arg === "--body-file") {
      const filePath = safeString(args[++index]).trim();
      if (!filePath) throw new Error("nerve_body_file_required");
      options.body = fs.readFileSync(filePath, "utf8");
    } else {
      throw new Error(`nerve_unknown_argument:${arg}`);
    }
  }
  return options;
}

async function runCommand(options: NerveCliOptions, socketPath?: string) {
  if (options.action === "status") {
    return await requestDaemonCommand(
      { type: "nerve_status" },
      { socketPath, timeoutMs: 30_000 },
    );
  }
  if (options.action === "abort") {
    return await requestDaemonCommand(
      { type: "nerve_abort" },
      { socketPath, timeoutMs: 30_000 },
    );
  }
  if (options.action === "reload") {
    return await requestDaemonCommand(
      {
        type: "nerve_reload_trigger",
        payload: options.id ? { id: options.id } : {},
      },
      { socketPath, timeoutMs: 30_000 },
    );
  }
  return await requestDaemonCommand(
    {
      type: "nerve_emit",
      payload: {
        ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
        body: options.body,
      },
    },
    { socketPath, timeoutMs: 30_000 },
  );
}

async function runLocal(options: NerveCliOptions, socketPath?: string) {
  if (!(await canConnectDaemonSocket(socketPath, 500))) {
    throw new Error("nerve_daemon_unavailable");
  }
  const result = await runCommand(options, socketPath);
  console.log(
    options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2),
  );
}

export async function runNerveInternal(rawArgv: string[]) {
  const options = parseArgs(rawArgv);
  if (options.help) return printHelp();
  await runLocal(options);
}

export async function runNerve(parsed: ParsedArgs, rawArgv: string[]) {
  const options = parseArgs(rawArgv);
  if (options.help) return printHelp();
  const context = createTargetExecutionContext(parsed);
  if (!context.isTargetUser) {
    process.stdout.write(
      captureInternalRinCommand(context, "__nerve_internal", rawArgv, "nerve"),
    );
    return;
  }
  await runLocal(options, context.socketPath);
}
