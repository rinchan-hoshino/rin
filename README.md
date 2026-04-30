[English](README.md) · [简体中文](readme/README.zh-CN.md) · [日本語](readme/README.ja.md) · [Español](readme/README.es.md) · [Français](readme/README.fr.md) · [More languages](readme/README.md)

# Rin

Rin is a daemon-style local AI assistant built on Pi.
It is terminal-first, keeps a small customizable core, and ships with a practical default toolset.

> [!WARNING]
> Rin is still a work in progress.
> Expect rough edges, unstable behavior, and occasional breaking changes.
> Agentic workflows can also consume noticeable model tokens and cost depending on how you use them.

## Why Rin

- Built on Pi and shaped into a daemon agent you can keep around for daily work.
- Small core by design: easier to understand, customize, and maintain.
- Practical built-ins for file work, memory, scheduled tasks, web search, and chat bridging.
- One product entrypoint: `rin`.
- KISS-first direction instead of a sprawling extension-first surface.

## What Rin is good for

Rin is for people who want a local assistant they can actually keep using.

- Ask in plain language.
- Inspect and modify files.
- Keep useful long-term memory.
- Run reminders and recurring tasks.
- Look up fresh information on the web.
- Bridge the same assistant into chat platforms.

## Quick start

### Linux and macOS

Install with one command, no clone required:

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

The public bootstrap branch now only carries the install and update entry wrappers. Stable installs and updates hand off to the published npm package, while `--beta`, `--nightly`, and `--git` continue to resolve through the bootstrap manifest and GitHub refs.

### Windows

Install from PowerShell or Windows Terminal with Node.js and npm available, no clone required:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

The Windows PowerShell bootstrap follows the same release-channel contract as `install.sh`: stable launches the published npm installer, while `--beta`, `--nightly`, and `--git` download the selected source archive, build it locally, and run its installer without cloning the repository.

On Windows, the interactive installer opens the GUI installer by default. It walks through language, target user, install directory, provider/model/auth, plan review, and final apply. If protected writes need confirmation, the GUI shows a one-line terminal handoff command instead of asking for privileged credentials inside the window.

After installation, Windows gets a GUI-first setup: the default `rin` launch opens the desktop GUI, and the installer writes direct GUI launchers plus a user-scoped Startup launcher for the daemon. Use `rin gui` explicitly if you want to open the GUI from a terminal, or `rin-install --tui` / `rin-install --no-gui` if you need the terminal installer.

If you already have the repo locally, the bundled `install.sh` and `install.ps1` wrappers run the same release-selection flow:

```bash
./install.sh              # stable release (default)
./install.sh --beta       # current weekly beta candidate
./install.sh --nightly    # current nightly build
./install.sh --git        # main
./install.sh --git main
./install.sh --git deadbeef
```

```powershell
.\install.ps1
.\install.ps1 --beta
.\install.ps1 --nightly
.\install.ps1 --git
.\install.ps1 --git main
.\install.ps1 --git deadbeef
```

Open Rin:

```bash
rin
```

Check health if needed:

```bash
rin doctor
rin status --watch  # live worker and scheduled-task activity
```

### Deployment scenarios

The installer is still a local installer, but several deployment shapes are already practical as wrappers around the same Linux/macOS/Windows entry points. The target environment still needs the normal Rin prerequisites, including Node.js and npm:

| Scenario                    | Feasibility                                             | Notes                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local or cross-user install | Supported today                                         | The interactive installer can target the current account or another local user, then writes that user's launchers and daemon service.                                                    |
| SSH install                 | Feasible today                                          | Run the bootstrap command over SSH on the remote host. A dedicated `rin install --ssh` wrapper could improve discovery and error reporting later.                                        |
| Containerized install       | Feasible with a headless Linux image                    | Use a persistent volume for the Rin home/install directory and run the daemon or CLI inside the container. GUI launchers and host user services do not apply inside the container.       |
| Virtual machine install     | Supported through the normal OS installer               | Install Rin inside the guest OS exactly like a physical machine. VM snapshots make rollback easier, but Rin still manages only the guest environment.                                    |
| NAS install                 | Feasible when the NAS can run Node.js or containers     | Prefer the normal Linux path on open NAS systems, or the container pattern on appliance-style NAS devices. Vendor package managers and restricted shells may need device-specific notes. |
| Cloud host install          | Supported through SSH or cloud-init style bootstrapping | Treat the cloud VM as a remote Linux host. Persist `.rin` data on durable disk and configure daemon startup according to the host OS.                                                    |

These are deployment scenarios, not separate release channels. Stable, beta, nightly, and git selection keep using the same install/update contract above.

## Built in today

Rin includes a focused default stack:

- file and shell tools
- long-term memory
- scheduled tasks and reminders
- live web search
- chat bridge support
- Pi-style non-interactive `rin -p` / `rin --mode json` for delegated, scriptable agent turns

## Updating Rin

For a normal installed Rin update, use:

```bash
rin update              # stable release (default)
rin update --beta       # current weekly beta candidate
rin update --nightly    # current nightly build
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

If `rin` is confirmed missing on the current account, treat that as “this is not the launcher-owning user”.
In that case, recover the real target install through the installed metadata:

- `<targetHome>/.rin/installer.json`
- Linux: `~/.config/systemd/user/rin-daemon*.service`
- macOS: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

Then invoke the stable installed runtime entry directly:

```bash
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

This is the canonical update path for the installed runtime.
It refreshes the core runtime and installed docs.
It does not replace the user-scoped CLI launcher or installer.

Important release-channel rule:

- stable is the default for install and update
- `--beta` means the current weekly beta candidate
- `--nightly` means the current nightly build from `main`
- `--git` with no suffix means `main`

Avoid treating repo-local workflows like `git pull`, ad-hoc rebuilds, or rerunning `install.sh` as the default way to update an already installed Rin.

## Core commands

```bash
rin            # open Rin
rin doctor     # inspect health and configuration
rin status     # show live worker and scheduled-task activity
rin target     # list and select deployment targets
rin --target x # run Rin against a configured target environment
rin start      # start the daemon
rin stop       # stop the daemon
rin restart    # restart the daemon
rin update     # update the installed Rin core runtime
```

## Documentation

This README is the user documentation. Translations live in `readme/README.*.md` and must stay aligned with this English version; update them in the same change when user-facing README content changes.

Internal documentation is intentionally separated:

- Agent-facing runtime guidance lives in `docs/agent/` and is installed to `agentDir/docs/rin/`.
- Developer technical documentation lives in `docs/developer/`.
- Release-note metadata lives in `docs/release/CHANGELOG.md` for `/changelog` and release workflows.

If you are changing Rin itself, start with [`docs/developer/README.md`](docs/developer/README.md).

## Project status

Rin is actively evolving.
The current direction is a cleaner core, stronger daemon reliability, and better day-to-day usefulness without losing simplicity.

If you want a fully settled surface, it is still early.
If you want a small, understandable, hackable daemon agent that is already useful, that is what Rin is trying to be.
