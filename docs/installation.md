# Installation

Open your installed, authenticated coding agent and send it [the installation prompt](../prompts/install.md). It identifies its own environment, guides you through chat accounts and access, and runs the platform installer. The bootstrap verifies Node.js 24+, Git, dependencies, the build, and tests before installing a per-user `rin` command and user daemon.

The guided setup enables `autoBind` with a workspace for the agent and an empty `bindings` list. The first admitted message in each chat creates a fresh conversation. Later messages continue it across Rin restarts. The native agent stores the conversation history; Rin persists the chat association and session reference.

Rin stores its release record, private configuration, credentials, chat database, and Nerve database in its installation data directory. Agent authentication stays with the agent.

After installation, the stable CLI provides:

```text
rin update
rin start
rin stop
rin restart
rin app-server start
rin app-server restart
```

`rin start|stop|restart` manage Rin resources. The app-server commands are explicit Codex operator actions. `rin update` verifies an isolated candidate, switches the atomic release record, and recovers the previous service when a transition fails.

Validate configuration before starting the registered user service. Test an authorized message, an identity rejection, configured chat rules, a final response, and conversation continuity for every enabled transport. Record real agent and platform checks separately from fixture or mocked tests.
