# Installation

Install and authenticate one supported agent first. Then paste [the installation prompt](../prompts/install.md) into that agent.

The guided flow verifies a clean release before it writes an installation record or private configuration. It asks separately about the agent, chat transports, identity and chat admission, quiet behavior, the Rin user service, and the optional Nerve MCP endpoint.

Rin never changes the selected agent's global settings, installs optional products, reads an old `~/.rin` tree by default, or replaces an unrelated launcher.

After installation, the stable CLI provides:

```text
rin update
rin start
rin stop
rin restart
rin app-server start
rin app-server restart
```

The last two commands are explicit Codex operator actions. The daemon never invokes them.

`rin update` prepares a detached candidate, installs locked dependencies without package scripts, runs the full test suite, and switches the atomic installation record. A failed service transition restores the prior record and attempts to restore the previous service.

Real integration status must be reported separately for each installed agent and chat platform. A fixture, mocked CLI, or successful configuration check is not an end-to-end acceptance.
