# Installation

Install and authenticate one supported agent first. Then paste [the installation prompt](../prompts/install.md) into that agent. The guided flow collects the agent session, chat transports, identity rules, bindings, delivery preferences, service choice, and optional Nerve endpoint before writing configuration.

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
