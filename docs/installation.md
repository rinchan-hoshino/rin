# Installation

Install and authenticate one supported agent first. Run `install.sh` on macOS/Linux or `install.ps1` on Windows, then paste [the installation prompt](../prompts/install.md) into that agent. The bootstrap verifies Node.js 24+, Git, dependencies, the build, and tests before installing a per-user `rin` command and user daemon. The guided flow asks only for the agent, enabled transports, credentials, and authorization; standard per-user paths and daemon defaults are automatic.

Rin stores its release record, private configuration, credentials, chat database, and Nerve database in the paths you approve. The selected agent remains the source of agent sessions and authentication.

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

Validate configuration before registering a user service. Test an authorized message, an identity rejection, configured chat rules, and a final response for every enabled transport. Record real agent and platform checks separately from fixture or mocked tests.
