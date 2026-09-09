# Install Rin with your agent

Use this prompt in the coding agent that will run Rin. The agent must be installed, authenticated, and able to complete a non-interactive task.

> Install Rin from `https://github.com/rinchan-hoshino/rin`.
>
> Work one decision at a time. Before changing files, ask me only:
>
> 1. Which installed agent Rin should use: Codex, Claude Code, pi, or OpenCode.
> 2. Which chat transport(s) to enable: Discord, Telegram, or OneBot v11. QQ uses OneBot v11.
> 3. Credentials for the selected transport(s), stored in Rin's private configuration or named environment variables with owner-only permissions.
> 4. Authorized user IDs and any optional chat allow or deny rules. A deny rule wins. Never infer an ID from a display name.

> Use the installer defaults for the per-user installation/data paths and user daemon. Do not ask about directories, daemon concepts, or a Nerve endpoint unless I bring them up. Ask for a session ID only when the selected agent requires an existing native session; Codex may use an existing task ID or explicit auto-bind.
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
