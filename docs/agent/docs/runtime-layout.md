# Runtime Layout

Rin's agent working directory is usually `~/.rin/`.

## Top-level layout

- `auth.json`: model authentication data
- `settings.json`: Rin / pi settings
- `sessions/`: user-facing session data; direct TUI sessions live at this root. Non-interactive CLI runs do not create a session by default; when an agent needs durable delegated context, create or use a dedicated session under `sessions/managed/<kind>/`.
- `memory/`: markdown-backed memory data
- `routines/`: routine prompts and task files
- `data/`: daemon, index, chat bridge, web-search, and other runtime state
  - custom chat bridge / Chat adapter packages, when used, are installed here via the generated runtime `package.json`
- `docs/rin/`: Rin-specific agent docs
- `docs/pi/`: installed copies of upstream Pi docs
- `docs/release/`: release-note metadata used by `/changelog`
- `app/current/`: the currently active runtime
- `app/releases/<timestamp>/`: runtime release directories

## User-scoped launcher paths

Rin launchers are user-scoped, not global.

Typical launcher paths:

- `~/.local/bin/rin`
- `~/.local/bin/rin-install`

Launcher metadata is also user-scoped.

Typical metadata paths:

- Linux: `~/.config/rin/install.json`
- macOS: `~/Library/Application Support/rin/install.json`

The installer writes these launchers for both the current installer user and the selected daemon target user when those accounts differ. If the current shell PATH does not include the launcher directory, the installer prints the absolute launcher path and a PATH hint instead of relying on a bare `rin` command.

This metadata records the current user's default `targetUser` and `installDir`. It is useful when recovering or auditing an installed target, but normal agent-facing guidance should use the `rin` command instead of asking agents to locate runtime entry files.

Important implications for the agent:

- prefer the `rin` command for normal use and self-update
- if either expected account has no `rin` launcher, treat that as an installation repair or migration issue rather than normal runtime discovery work
- keep the current installer user, daemon target user, and current local execution account distinct when auditing ownership or permissions

## Install manifests and service files

Besides launchers, Rin exposes install ownership through stable metadata and managed service files.

Useful locations:

- `<installDir>/installer.json`: install manifest written into the target runtime directory
- `<targetHome>/.rin/installer.json`: stable locator manifest under the target home; for custom install dirs it points to the real `installDir`
- Linux user service: `~/.config/systemd/user/rin-daemon*.service`
- macOS launch agent: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

These files are the main way to audit `installDir` and `targetUser` or repair an installation whose launchers are missing.
Service files expose the runtime directory through `RIN_DIR`, and once `installDir` is known the next stop should be `<installDir>/installer.json`.

## Installed update path

Keep `rin update` as the canonical workflow. If the launcher is missing for an account that should have it, repair or rerun the installer/update path so the launcher is restored instead of documenting ad-hoc direct runtime entry invocations as the normal agent workflow.

Typical places to audit `installDir` during repair:

- `<targetHome>/.rin/installer.json`
- Linux: `~/.config/systemd/user/rin-daemon*.service`
- macOS: `~/Library/LaunchAgents/com.rin.daemon.*.plist`
- default target-home install directory: `<targetHome>/.rin/`

This keeps installed-runtime maintenance separate from repo-checkout maintenance.
Do not treat rerunning `install.sh`, ad-hoc rebuilds, or repo-local `git pull` workflows as the normal way to update an already installed Rin runtime.

## `app/current/`

`app/current/` is the stable entrypoint for the currently active runtime.

For the agent, the important part is:

- treat it as the stable path for the current runtime version
- do not depend on a specific `app/releases/<timestamp>/...` path
- if you must reference read-only resources from the current runtime, prefer entering through `app/current/`

The contents behind it may be fully refreshed during updates.

## Stable vs unstable paths

Prefer these stable paths when possible:

- `~/.rin/docs/rin/...`
- `~/.rin/docs/pi/...`
- `~/.rin/settings.json`
- `~/.rin/auth.json`
- `~/.rin/sessions/...`
- `~/.rin/memory/...`
- `~/.rin/app/current/...`

Avoid baking a specific `app/releases/<timestamp>/...` path into long-lived configs or instructions.

## Documentation install policy

Rin-specific agent docs are installed into the stable `docs/rin/` path rather than a release-specific directory.
This lets the system prompt point to stable documentation paths across updates.

Release-note metadata is installed separately under `docs/release/` so agent guidance does not mix with changelog content.
