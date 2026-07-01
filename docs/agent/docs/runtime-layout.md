# Runtime Layout

Use this document when a task needs to locate Rin runtime files, installed documentation, launcher metadata, install manifests, service files, or the active app release.

Runtime layout work is a target-identification contract. The agent must identify the active agent directory, the installed runtime entrypoint, and the owner account before changing or reporting installed-runtime state.

## Prompt brief

Target surface:

- agent directory under `~/.rin/`;
- installed docs under `docs/rin/`, `docs/pi/`, and `docs/release/`;
- launcher metadata and service files;
- installer manifests;
- `app/current/` and `app/releases/<id>/`.

Goal:

- determine the real installed runtime target and verify which files, launcher, service, and release are active.

Trusted inputs:

- `rin status` / `rin status --json`;
- launcher metadata;
- target-home locator manifest;
- install manifest inside `~/.rin/`;
- managed service files;
- filesystem state for `app/current/` and release directories.

Output contract:

- target user and agent directory;
- manifest path used;
- active runtime entrypoint;
- current and previous release names when relevant;
- service or launcher ownership evidence when relevant;
- source checkout vs installed runtime boundary when both are present.

## Success criteria

A runtime-layout inspection is complete when:

- the agent directory and `targetUser` come from a manifest, launcher, service, or explicit live state;
- `app/current/` identifies the active installed runtime entrypoint;
- source checkout paths and installed runtime paths are treated as separate surfaces;
- docs paths are resolved through the installed `docs/rin/` and `docs/pi/` roots;
- SDK import or installed-runtime edits name the verified target.

## Agent directory contract

The default agent directory is `~/.rin/`; use manifests to confirm the real target.

Common top-level paths under the agent directory:

- `auth.json`: model authentication data.
- `settings.json`: Rin/Pi settings.
- `i18n.json`: optional local i18n catalog, including chat command acknowledgement strings.
- `sessions/`: user-facing session data.
- `sessions/managed/<kind>/`: durable managed sessions for delegated or non-interactive work.
- `memory/`: markdown-backed memory data.
- `self_improve/`: prompt baselines, skills, indexes, and distilled guidance.
- `routines/`: routine prompts and task files.
- `data/`: runtime state grouped by owner, including `core/`, `chat/`, `scheduler/`, `sidecars/`, `extensions/`, `features/`, and shared `runtime/` helpers.
- `docs/rin/`: installed Rin-specific agent docs.
- `docs/pi/`: installed upstream Pi reference docs.
- `docs/release/`: release-note metadata used by `/changelog`.
- `app/current/`: stable entrypoint for the active installed runtime.
- `app/releases/<id>/`: installed runtime release directories.

Use `docs/execution-environment.md` for turn-level environment inspection and `docs/capabilities.md` for runtime feature behavior.

## Stable path contract

Use stable paths for agent guidance, durable references, scripts, and diagnostics:

- `~/.rin/docs/rin/...`
- `~/.rin/docs/pi/...`
- `~/.rin/docs/release/...`
- `~/.rin/settings.json`
- `~/.rin/i18n.json`
- `~/.rin/auth.json`
- `~/.rin/sessions/...`
- `~/.rin/memory/...`
- `~/.rin/self_improve/...`
- `~/.rin/app/current/...`

Use `app/current/...` for the active runtime. Use `app/releases/<id>/...` when auditing a release recorded in the manifest.

## Locator contract

Find installed-runtime ownership in this order when the task depends on the active installation:

1. `rin status --json` for live daemon/runtime data.
2. `<targetHome>/.rin/installer.json` as the stable locator manifest under the target home.
3. `<targetHome>/.rin/installer.json` as the primary install manifest.
4. User launcher metadata:
   - Linux: `~/.config/rin/install.json`
   - macOS: `~/Library/Application Support/rin/install.json`
5. Managed service files:
   - Linux user service: `~/.config/systemd/user/rin-daemon*.service`
   - macOS launch agent: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

These surfaces identify:

- agent directory;
- `targetUser`;
- active release metadata in `currentRelease`;
- rollback metadata in `previousRelease`;
- installer-managed file inventory under `managedFiles.trees`;
- managed service launch context.

## Launcher and service contract

Rin launchers are user-scoped.

Typical launcher paths:

- `~/.local/bin/rin`
- `~/.local/bin/rin-install`

The installer also writes `~/.rin/env`, a small sourceable shell fragment that prepends the launcher directory to `PATH` for the current shell. Public POSIX install commands source this file after a successful install so a first-time shell can run `rin` immediately without editing shell startup files.

The installer can write launchers for both the installer user and the daemon target user when those accounts differ. Launcher metadata records the current user's default `targetUser` and agent directory.

For normal agent operation, call `rin`. For launcher repair or ownership audits, compare:

- launcher path;
- launcher metadata;
- target-home locator manifest;
- install manifest;
- managed service launch context.

## Installed runtime entrypoint

`app/current/` points at the active installed runtime. The target behind the symlink may change during update or rollback, while `app/current/` remains the stable entrypoint.

Use `app/current/` for:

- reading installed runtime resources;
- importing installed SDK modules from scripts;
- inspecting the active build output;
- verifying that an installed update contains expected files.

Use a specific `app/releases/<id>/` path for auditing a recorded release.

## Maintenance target contract

Use this document to identify the installed runtime target for launcher maintenance. Update and rollback operation policy belongs to `docs/capabilities.md`.

Verify target ownership through:

- `<targetHome>/.rin/installer.json`;
- Linux service files under `~/.config/systemd/user/rin-daemon*.service`;
- macOS launch agents under `~/Library/LaunchAgents/com.rin.daemon.*.plist`.

After installed-runtime maintenance, verify:

- `app/current/` target;
- `currentRelease` and `previousRelease` in `<targetHome>/.rin/installer.json`;
- `rin status` or `rin status --json` for the running daemon layer when daemon liveness matters.

## Source checkout boundary

Source checkout maintenance and installed runtime maintenance are different surfaces. A repository checkout can contain newer source than the runtime behind `~/.rin/app/current/`.

For source work, inspect the repository root, branch, status, scripts, and tests. For installed-runtime work, inspect `~/.rin/`, manifests, service files, and `app/current/`.

## Documentation install contract

Rin-specific agent docs are installed under stable `docs/rin/` paths so system prompts and agent guidance can refer to them across updates.

Installed upstream Pi docs live under `docs/pi/`. Release-note metadata lives under `docs/release/` so changelog content stays separate from agent guidance.

## Report contract

For runtime-layout work, report:

- target user;
- agent directory;
- manifest path used;
- active runtime entrypoint;
- current/previous release when relevant;
- launcher or service ownership evidence when relevant;
- validation performed;
- source checkout vs installed runtime boundary when it affects the result.
