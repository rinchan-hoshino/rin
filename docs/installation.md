# Git installation

Rin installs from the `main` branch of its Git repository. It does not publish an npm package. Node.js and npm run the source and install its locked dependencies; Codex itself remains an independent product.

## Interactive setup

Run `install.sh` on macOS/Linux or `install.ps1` in Windows PowerShell. A local checkout uses its local installer; the remote entrypoint clones `main` into a temporary bootstrap directory. The bootstrap handles missing prerequisites and prepares locked npm dependencies before starting the English-only setup. The installer uses `@clack/prompts` 0.10.1, the same framework and version as the legacy installer, declared independently in this package. Navigate choices with arrow keys, toggle products with Space, confirm with Enter, or cancel with Ctrl+C/Escape. The sequence is introduction, optional legacy replacement, product selection, configuration and instructions, a final installation plan, then progress and completion. Declining the final confirmation leaves the installation and personal files untouched (bootstrap dependencies may already have been prepared).

If Git or Node.js 24 is missing, the bootstrap explains the changes and asks before installing them. Git uses Homebrew/Command Line Tools on macOS, a supported Linux package manager, or Windows `winget`. Node is downloaded into the installation's `runtime/` directory from the pinned [official Node.js release](https://nodejs.org/download/release/v24.18.0/) and checked against `SHASUMS256.txt`; an existing suitable Node outside old `~/.rin` is reused. A macOS Command Line Tools dialog may require user interaction. The Linux managed Node archive requires a compatible GNU/Linux system; existing compatible Node installations can also be used. Bootstrap does not copy or rely on the old Rin runtime.

The setup asks whether to replace an old Pi-based Rin, which products to install (Codex CLI, ChatGPT desktop app, both, or neither), whether to apply the Rin recommended Codex profile, and what initial global AGENTS instructions to use (type a paragraph or read a UTF-8 Markdown file for multiline text). On macOS and Linux, a selected Codex CLI is installed under the user's `~/.local` prefix; the installer neither needs `sudo` nor changes npm's configured global prefix. An existing Codex executable remains user-owned when Codex CLI installation is not selected. An existing AGENTS file is preserved unless the user chooses to append instructions. After the custom-instruction step, a separate `Append Rin subagent guidance after your instructions?` choice previews and optionally appends this guidance: “Actively use a separate subagent for each independent subtask. For example, use Astra subagents for work that can run in parallel, and Luna subagents for simple tasks.” It defaults to no, preserves the original file text, and skips the identical existing text. It does not change permissions or create subagents during setup. `rin update` replaces Rin's exact previous managed guidance when present while preserving all other instructions; it does not add guidance to an installation that has none.

The optional profile uses Codex's configuration write protocol to merge only these choices into the user's existing configuration: GPT-6-Astra as the default model (`model = "gpt-6-astra"`) with medium reasoning (`model_reasoning_effort = "medium"`); context management and memories enabled; a 4,000-token budget per tool output stored in history (`tool_output_token_limit`); full filesystem access and `approval_policy = "never"`; desktop sleep prevention while work is running and remote-control wake while plugged in; an empty Git branch prefix, squash pull-request merge, and best-effort worktree upstream refresh; Sites, Hotline, and Safety Settings connectors disabled. Other keys and comments are preserved. In particular, the profile does not set the service tier, Chronicle, or unrelated connectors. The setup preview explains both full filesystem access and the `never` execution-approval policy before the user opts in. Sandbox access and approval policy are separate settings in the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). Declining the profile preserves the existing configuration; `rin update` does not apply it. Updates handled by this release remove the obsolete Rin-managed `model_auto_compact_token_limit` key without applying any other profile setting. When an older updater selects this release while the managed daemon is running, daemon readiness waits for the same idempotent migration to succeed.

After preparing and testing a candidate, the installer sets up the selected products, registers a disabled Rin service, and installs FFF session-text search as part of Rin, without a separate opt-in. It reads the old installer manifest and platform launcher metadata to resolve custom installation directories, disables the recognized old Pi service, copies installation records to `.pi-disabled` backups, and renames its detected `rin` and `rin-install` launchers with `.pi-disabled` before publishing the new `rin` entrypoint. Existing backup collisions stop the cutover before service changes. Old private data is retained, never imported into the new runtime. Unrecognized legacy service records stop the cutover with an explanation. Existing unrelated CLI launchers are not overwritten.

Product installation uses [official Codex installation guidance](https://learn.chatgpt.com/docs/codex/cli), the [macOS desktop download](https://learn.chatgpt.com/docs/app), the [Windows Store command](https://learn.chatgpt.com/docs/windows/windows-app), and the [supported Linux packages](https://learn.chatgpt.com/docs/linux/linux-app). The current macOS desktop download requires Apple Silicon. Linux desktop packages support the distributions listed in the official guide; the installer rejects unsupported targets before installing a selected product. Existing macOS applications are retained.

FFF is included even when no product is selected. Its binary is downloaded and verified; an existing different `session-history` MCP entry is preserved. The installation needs a usable Codex CLI for `rin` and MCP registration. The launcher can also find the bundled executable in standard macOS ChatGPT/Codex app locations. On other systems, select Codex CLI if an executable is not already available. Sign-in remains an ordinary Codex or ChatGPT interaction.

## Layout

The default installation root is `$XDG_DATA_HOME/rin` (or `~/.local/share/rin`) on macOS/Linux and `%LOCALAPPDATA%/Rin` on Windows. `RIN_HOME` overrides it during installation. The CLI launcher is placed in `~/.local/bin`; setup adds it to the user's Windows PATH or common shell profile when missing. Open a new terminal afterward. Installer paths are independent of old `~/.rin` data and any earlier transitional service deployment.

| Path under the installation root | Purpose |
|---|---|
| `source.git/` | Git fetch repository |
| `releases/<commit>/` | Independently verified source and dependencies |
| `install.json` | Atomic current/previous version record |
| `launcher.mjs`, `daemon-run.mjs` | Stable entrypoints |
| `private/daemon.json` | Selected chat and Nerve configuration files |
| `private/` | Account settings, logs, databases and other local state |
| `tools/` | Verified FFF binary included with Rin |

Do not edit a prepared release as a development checkout. Develop in a separate clone. Do not commit private configuration or use a real private installation as a test fixture.

## One daemon, only when needed

`rin` without a management command launches Codex with the user's cwd, terminal and arguments. The environment is inherited with the selected Node directory added to PATH, so a managed Node installation remains usable in a new terminal. It needs no background Rin process. `rin -- ...` always forwards arguments to Codex. Only the exact leading commands `update`, `start`, `stop`, and `restart` belong to Rin; they accept no extra arguments. Old commands such as `doctor` or `rollback` are not Rin management commands.

The installed daemon combines ChatBridge and Nerve in one Node process. Codex CLI invocations and on-demand MCP processes are external clients/tools, not additional Rin daemons. The service is registered but disabled until there is configured background work:

```json
{
  "chat": "/absolute/path/to/private/chat.json",
  "nerve": "/absolute/path/to/private/nerve.json"
}
```

Either value may be `null`. Both default to `null`; `rin start` rejects this empty state. Relative config paths resolve beside `daemon.json`. In a Nerve config, relative database and cwd paths resolve beside that Nerve config. Use absolute paths for attention configuration references and MCP configuration to avoid ambiguity. Chat configuration is described in [chat-bridge.md](chat-bridge.md); Nerve configuration and its MCP registration are described in [nerve.md](nerve.md).

macOS uses the user LaunchAgent `com.rin.service`, Linux uses `systemd --user` unit `rin.service`, and Windows uses a `Rin` scheduled task at logon. Start enables automatic startup; stop disables it. Nerve acquires its exclusive loopback port before recovery. Chat shares the existing bridge PID lock, so an old bridge using the same state directory prevents a duplicate start. Startup failure closes already-opened components. Normal daemon shutdown stops chat before Nerve; uncertain external operations retain their conservative recovery semantics. Windows Task Scheduler termination can be abrupt, so pending work may require inspection after restart.

Do not run this installer against a live transitional chat/Nerve deployment as an implicit migration. The new Git installation does not stop or copy that deployment. A deliberate cutover must stop its exact service entries, carry over its selected private configuration and state, and verify that no second bot receiver exists. This packaging change itself does not perform that cutover.

Agents replacing a Pi-based or transitional Rin should follow the [legacy migration guide](legacy-migration.md). It defines the no-import boundary, private reconfiguration, single-receiver cutover, evidence levels, and rollback discipline.

Windows task settings explicitly remove the default execution time limit, allow battery operation, avoid duplicate instances, and request up to 999 one-minute failure restarts. Startup also requires a live, matching-release readiness marker written only after module initialization. These settings are checked by generated-configuration tests; Windows real-machine installation remains unverified.

## Update and failure recovery

`rin update` fetches `main`, requires the new commit to descend from the installed commit, clones a separate candidate, runs `npm ci --ignore-scripts` and the test suite, then atomically changes `install.json`. It does not update Codex, ChatGPT, FFF, account configuration or AGENTS. A stopped daemon stays stopped. A running daemon is stopped for the switch and restarted; a start failure restores the previous record and attempts to restart that version. No force pull, reset of user work, or npm publication occurs.

The install/update lock prevents concurrent switches. A process crash can leave `install.lock`; inspect whether an installer is still running before removing that directory. Previous releases are retained for inspection and manual recovery, without exposing a separate `rin rollback` command. A cutover failure restores renamed old CLI launchers; the error explicitly states if the old service remains stopped. Run service management from a separate terminal rather than from a task owned by the daemon being stopped.

## Original-session text search

Optional FFF setup pins [upstream release v0.10.6](https://github.com/dmtrKovalenko/fff/releases/tag/v0.10.6) and verifies the selected executable against its upstream SHA-256 digest. The platform matrix covers macOS, GNU/musl Linux and Windows on x64/ARM64. Its `session-history` MCP points only at the user's Codex `sessions` and `archived_sessions` directories via links (directory junctions on Windows). It is not an old-Rin archive importer. An existing different MCP entry is preserved and reported rather than overwritten.

## Verification limits

Automated checks cover real temporary Git repositories, rejected history rewrites, candidate failure, rollback, stable launcher execution, daemon lifecycle, manager command generation, and product selection/checksums. Fixtures never register real services or install products on the host. macOS/Linux/Windows installer branches do not all have real-machine acceptance evidence. Codex App IPC retains its separate version and platform constraints; installing a desktop app does not prove end-to-end chat delivery.
