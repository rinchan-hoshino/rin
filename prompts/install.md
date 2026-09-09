# Install Rin with your agent

Use this prompt in the coding agent that will run Rin. The agent must be installed, authenticated, and able to complete a non-interactive task.

> Install Rin from `https://github.com/rinchan-hoshino/rin`.
>
> Work one decision at a time. Before changing files, ask me:
>
> 1. Which installed agent Rin should use: Codex, Claude Code, pi, or OpenCode.
> 2. Which chat transports to enable: Discord, Telegram, or OneBot v11. QQ uses OneBot v11.
> 3. The installation directory, data directory, project directory, and the agent session ID to bind. Offer standard per-user paths as defaults.
> 4. The authorized user IDs, then optional chat allow and deny rules. A deny rule wins. Never infer an ID from a display name.
> 5. Whether quiet delivery is the default and any per-chat overrides. Explain that quiet hides progress while final answers and errors remain visible.
> 6. Whether to register Rin as a user service and whether to expose Nerve's local MCP endpoint.
>
> Show the complete plan and paths before writing. Keep agent authentication and private credentials in the agent's approved private locations. Rin owns only its release record, private configuration, chat data, and Nerve data.
>
> Clone the repository into a temporary directory, confirm Node.js 24 or newer and Git are present, run `npm ci` and `npm test`, and stop if verification fails. Use the verified commit as an immutable release under the chosen Rin home. Create `install.json`, stable launchers through `dist/install/launchers.js`, and a private `daemon.json`. Create chat and Nerve configuration only for the choices I approved. Keep tokens in `private/secrets.json` or named environment variables with owner-only permissions.
>
> For `agent` configuration use one of `codex`, `claude-code`, `pi`, or `opencode`. Codex bindings use an existing Codex task ID or explicit Codex auto-bind. The other three use an existing native session ID. Do not claim an agent is verified unless its real CLI accepted an input and returned output.
>
> Validate configuration with the release's `rin.mjs check` command. If I chose a service, register it with `dist/install/service.js` only after all files validate. Start Rin only when I asked for it. Test one authorized text message, one rejected identity, one configured chat rule when present, and one final response. Record any agent or platform that could not be tested as unverified instead of simulating success.
>
> Finish with the installed commit, launcher path, private configuration paths, enabled transports, exact checks run, real integrations verified, and remaining manual checks. Do not include secrets in the report.
