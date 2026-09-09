# Install Rin with your agent

Use this prompt in the coding agent that will run Rin. The agent itself must already be installed, authenticated, and able to complete a non-interactive task.

> Install the lightweight Rin release from `https://github.com/rinchan-hoshino/rin`.
>
> Work one decision at a time. Before changing files, ask me:
>
> 1. Which installed agent Rin should use: Codex, Claude Code, pi, or OpenCode.
> 2. Which chat transports to enable: Discord, Telegram, or OneBot v11. QQ through OneBot is supported; the QQ official Bot API is not.
> 3. The installation directory, data directory, project directory, and the existing agent session ID to bind. Offer standard per-user paths as defaults.
> 4. The authorized user IDs, then optional chat allow and deny rules. A deny rule wins. Never infer an ID from a display name.
> 5. Whether quiet delivery is the default, and any per-chat overrides. Explain that quiet hides progress while final answers and errors remain visible.
> 6. Whether to run Rin manually or register its user service. Ask separately whether to expose Nerve's local MCP endpoint.
>
> Show the complete plan and paths before writing. Never read or import an old `~/.rin` installation except when I explicitly name a file as migration evidence. Never install or reconfigure the selected agent, never start or stop an agent server, and never replace an unrelated launcher.
>
> Clone the repository into a temporary directory, confirm Node.js 24 or newer and Git are present, run `npm ci` and `npm test`, and stop if verification fails. Use the verified commit as an immutable release under the chosen Rin home. Create `install.json`, the stable launchers through `dist/install/launchers.js`, and a private `daemon.json`. Create chat and Nerve configuration only for the choices I approved. Keep tokens in `private/secrets.json` or named environment variables with owner-only permissions.
>
> For `agent` configuration use one of these types: `codex`, `claude-code`, `pi`, or `opencode`. Codex bindings use an existing Codex task ID or explicit Codex auto-bind. The other three use an existing native session ID and do not auto-bind. Do not add fake compatibility commands or claim an agent is verified unless its real installed CLI accepted an input and returned output.
>
> Validate configuration with the release's `rin.mjs check` command. If I chose a service, register it with `dist/install/service.js` only after all files validate. Start Rin only when I asked for it. Test one authorized text message, one rejected identity, one allowed or denied chat rule when configured, and one final response. Record any agent or platform that could not be tested as unverified instead of simulating success.
>
> Finish with the installed commit, launcher path, private configuration paths, enabled transports, exact checks run, real integrations verified, and remaining manual checks. Do not include secrets in the report.

