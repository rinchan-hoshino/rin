# Installation

Open your installed, authenticated coding agent and send it [the installation prompt](../prompts/install.md). It identifies its own environment, guides you through chat accounts and access, and runs the platform installer. The bootstrap verifies Node.js 24+, Git, dependencies, the build, and tests before installing a per-user `rin` command and user daemon.

The guided setup enables `autoBind` with a workspace for the agent and an empty `bindings` list. The first admitted message in each chat creates a fresh conversation. Later messages continue it across Rin restarts. The native agent stores the conversation history; Rin persists the chat association and session reference.

Codex integrations require the configured executable to support `codex app-server daemon start`. Setup verifies that command and the resulting connection; Rin does not classify installation sources or fall back to a direct `codex app-server --listen` process.

Rin stores its release record, private configuration, credentials, chat database, and Nerve database in its installation data directory. Agent authentication stays with the agent.

After installation, the stable CLI provides:

```text
rin update
rin start
rin stop
rin restart
rin codex start
rin codex stop
rin codex restart
```

`rin start|stop|restart` manage Rin resources. The app-server commands are explicit Codex operator actions. `rin update` verifies an isolated candidate, switches the atomic release record, and recovers the previous service when a transition fails.

Validate configuration before starting the registered user service. Test an authorized message, an identity rejection, configured chat rules, a final response, and conversation continuity for every enabled transport. Record real agent and platform checks separately from fixture or mocked tests.

## Open your agent

Run `rin` to open the same agent configured for the chat bridge. Use `rin -- ...` to pass arguments to that CLI, for example `rin -- --help`. Other arguments are Rin commands. The configured executable, environment, and workspace are used; chat-only non-interactive protocol flags are not added.
