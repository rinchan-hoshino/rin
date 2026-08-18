import { safeString, stripRinWrapperArgs } from "./shared-lite.js";

export function printRunHelp() {
  console.log(`rin - Local, general-purpose AI assistant

Usage:
  rin [options] [@files...] [messages...]

Package and account commands:
  rin install <source>             Install an extension source
  rin remove <source>              Remove an extension source
  rin list                         List installed extensions
  rin config                       Configure package resources
  rin auth <command>               Check or print provider credentials
  rin <command> --help             Show command-specific help

Options:
  --mode <mode>                  Output mode: text (default) or json
  --print, -p                    Non-interactive mode: process prompt and exit
  --provider <name>              Provider name
  --model <provider/model>       Model pattern or ID (supports provider/model)
  --api-key <key>                Provider API key
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --continue, -c                 Continue the previous session
  --resume, -r                   Select a session to resume
  --session <file>               Use a specific session file
  --session-id <id>              Use an exact project session ID
  --managed-session <leaf>       Create and keep a session under sessions/managed/<leaf>/
  --name <name>                  Set the session display name
  --tools, -t <tools>            Comma-separated allowlist of tool names
  --exclude-tools, -xt <tools>   Comma-separated denylist of tool names
  --no-tools, -nt                Disable all tools
  --no-builtin-tools, -nbt       Disable built-in tools
  --extension, -e <path>         Load an extension file
  --skill <path>                 Load a skill file or directory
  --timeout <seconds>            Maximum wait time (default: 1800)
  --yes                          Confirm install/update prompts non-interactively
  --user <name>                  Target another local user's runtime
  --target <name>                Target a configured deployment
  --maint                        Start the TUI in maintenance mode
  --help, -h                     Show this help

Examples:
  rin -p "Summarize this document"
  cat notes.md | rin -p "Extract the action items"
  rin --mode json "Compare these options"
  rin --mode json --managed-session research -p "Check the cited sources"
  rin --name "weekly planning" -p "Draft next week's plan"
  rin --model provider/model --thinking low -p "Rewrite this clearly"
`);
}

export function shouldRunNonInteractive(
  rawArgv: string[],
  stdinIsTTY = process.stdin.isTTY,
) {
  const args = stripRinWrapperArgs(rawArgv);
  for (let index = 0; index < args.length; index += 1) {
    const arg = safeString(args[index]).trim();
    if (arg === "--") break;
    if (arg === "--print" || arg === "-p") return true;
    if (arg === "--mode" && safeString(args[index + 1]).trim() === "json") {
      return true;
    }
    if (arg === "--mode=json") return true;
  }
  return !stdinIsTTY;
}
