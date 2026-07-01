import { safeString, stripRinWrapperArgs } from "./shared-lite.js";

export function printRunHelp() {
  console.log(`rin - AI coding assistant with read, bash, edit, write tools

Usage:
  rin [options] [@files...] [messages...]

Options:
  --mode <mode>                  Output mode: text (default) or json
  --print, -p                    Non-interactive mode: process prompt and exit
  --provider <name>              Provider name
  --model <provider/model>       Model pattern or ID (supports provider/model)
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh
  --session <file>               Use a specific session file
  --managed-session <leaf>       Create and keep a session under sessions/managed/<leaf>/
  --name <name>                  Set the session display name
  --tools, -t <tools>            Comma-separated allowlist of tool names
  --exclude-tools, -xt <tools>   Comma-separated denylist of tool names
  --no-tools, -nt                Disable all tools
  --no-builtin-tools, -nbt       Disable built-in tools
  --timeout <seconds>            Maximum wait time (default: 1800)
  --help, -h                     Show this help

Examples:
  rin -p "Summarize this repository"
  cat README.md | rin -p "Summarize this text"
  rin --mode json "List all .ts files in src/"
  rin --mode json --managed-session subagent -p "Scout the auth module"
  rin --name "release audit" -p "Audit this repository"
  rin --model openai/gpt-5.5 --thinking low -p "Draft release notes"
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
