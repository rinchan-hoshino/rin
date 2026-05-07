[English](README.md) · [简体中文](readme/README.zh-CN.md) · [日本語](readme/README.ja.md) · [Español](readme/README.es.md) · [Français](readme/README.fr.md) · [More languages](readme/README.md)

# Rin

Rin is your personal AI assistant, designed to live right on your computer.

If you're familiar with AI tools like ChatGPT, Rin takes it a step further. It's an assistant that remembers important details across conversations, learns your preferences, and helps with real tasks efficiently, so you don't have to start over every time.

Rin isn't just an idea; it's a real-world demonstration of what it can do. The entire Rin project is developed by Rin itself—meaning Rin acts as the continuous assistant that plans, edits, reviews, translates, and maintains its own development.

## Why Rin exists

Have you ever found yourself repeating the same information to an AI in every new chat? Most AI conversations are easy to start, but also easy to lose.

You explain your preferences, your projects, your tools, and your habits. Then you open a new chat and explain them again. Rin tries to make that relationship less disposable.

Rin addresses this by offering a simple, core promise:

- keep the same assistant across sessions
- remember useful long-term facts globally
- improve with regular use, so you don't need to write complex instructions every time
- connect to local files, web information, schedules, and various chat applications
- stay understandable enough that you can inspect and control it

## What you can use Rin for

You talk to Rin in plain language. Rin can then use the tools available on your machine and in your configured accounts.

Here are some examples of what Rin can do:

- remember preferences, names, projects, and recurring instructions
- summarize or rewrite documents
- inspect and organize files
- search the web for current information
- create reminders and recurring tasks
- keep useful notes from repeated work
- help you manage your computer or other services, always under your supervision
- respond through a command-line interface (CLI), a graphical user interface (GUI), or connected chat apps, always as the same assistant

Rin is meant to be a general assistant, not only a coding tool. Coding and repository work are just one kind of task it can help with.

## What makes Rin different

### Ready to use

Rin comes as a complete product you can start with a single command: `rin`. You won't need to build your own system for memory, scheduling, or connecting to chats.

### Global memory

Rin can keep durable facts and reusable experience outside a single conversation. New sessions can start with more of the context that matters.

### Implicit self-improvement

Rin can turn repeated practice into reusable instructions and skills. You shouldn't need to become an expert at writing prompts just to teach your assistant how you work.

### A long-running local assistant

Rin runs continuously in the background, so your assistant isn't limited to a single open window. Various ways to interact with Rin (like different apps or interfaces) can all connect to the same assistant.

### Self-bootstrapped development

Rin is maintained with Rin. The project is a practical test of its own design: the assistant that the product provides is also used to build, review, translate, and improve the product.

## How Rin thinks about technology

For those interested in the technical design, Rin is built with these core principles:

- keep the system as simple as possible
- clearly show the tools available and the information being used
- allow the AI model to make decisions when appropriate
- avoid rigid, pre-set ways of working that only fix problems with poor instructions
- ensure the product doesn't rely on specific "tricks" or a single AI model
- prioritize transparent, locally managed data over systems that lock you into a remote platform

**Note for Developers:** Rin aims to be a practical daily assistant rather than a complex agent platform or a research tool. It's designed to be efficient, providing the AI with useful tools and memory while focusing on long-term, everyday functionality.

## Quick start

### Linux and macOS

Install with one command, no clone required:

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

Other release channels:

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

### Windows

To install on Windows from PowerShell or Windows Terminal, ensure you have Node.js and npm installed (these are technical prerequisites, often used for web development), then run this command—no need to download the repository first:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

Other release channels:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

On Windows, the interactive installer opens the GUI installer by default. It walks through language, target user, install directory, provider/model/auth, plan review, and final apply. If Windows asks for permission to make system changes, the GUI will show a simple command you can run in your terminal to complete the process, rather than asking for administrator passwords directly within the GUI.

After installation, Windows gets a GUI-first setup: the default `rin` launch opens the desktop GUI, and the installer writes direct GUI launchers plus a user-scoped Startup launcher for the background runtime. Use `rin gui` explicitly if you want to open the GUI from a terminal, or `rin-install --tui` / `rin-install --no-gui` if you need the terminal installer.

### From an existing checkout

If you already have the repo locally, the bundled install wrappers run the same release-selection flow:

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

## Current status, safety, and costs

Rin is actively developed and still early. Expect rough edges, unstable behavior, missing documentation, and occasional breaking changes.

Because Rin can keep context, write memory, run scheduled work, search the web, and call models repeatedly, it can use more tokens, API quota, or subscription capacity than a normal one-off chat.

Use supervision for important work. Do not let Rin perform irreversible, sensitive, or production-critical actions unless you understand the risk and can review or roll back the result.

## Deployment scenarios

The installer is still a local installer, but several deployment shapes are already practical as wrappers around the same Linux/macOS/Windows entry points. The target environment still needs the normal Rin prerequisites, including Node.js and npm:

| Scenario                    | Feasibility                                             | Notes                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local or cross-user install | Supported today                                         | The interactive installer can target the current account or another local user, then writes that user's launchers and background service.                                                      |
| SSH install                 | Feasible today                                          | Run the bootstrap command over SSH on the remote host. A dedicated `rin install --ssh` wrapper could improve discovery and error reporting later.                                              |
| Containerized install       | Feasible with a headless Linux image                    | Use a persistent volume for the Rin home/install directory and run the background runtime or CLI inside the container. GUI launchers and host user services do not apply inside the container. |
| Virtual machine install     | Supported through the normal OS installer               | Install Rin inside the guest OS exactly like a physical machine. VM snapshots make rollback easier, but Rin still manages only the guest environment.                                          |
| NAS install                 | Feasible when the NAS can run Node.js or containers     | Prefer the normal Linux path on open NAS systems, or the container pattern on appliance-style NAS devices. Vendor package managers and restricted shells may need device-specific notes.       |
| Cloud host install          | Supported through SSH or cloud-init style bootstrapping | Treat the cloud VM as a remote Linux host. Persist `.rin` data on durable disk and configure background startup according to the host OS.                                                      |

These are deployment scenarios, not separate release channels. Stable, beta, nightly, and git selection keep using the same install/update contract above.

## Built in today

Rin includes a focused default stack:

- long-term memory
- scheduled tasks and reminders
- live web search
- file and shell tools
- chat bridge support
- GUI, TUI, CLI, and RPC-style access paths
- non-interactive `rin -p` / `rin --mode json` for delegated or scriptable assistant turns

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

If `rin` is confirmed missing on the current account, treat that as “this is not the launcher-owning user”. Recover the real target install through the installed metadata:

- `<targetHome>/.rin/installer.json`
- Linux: `~/.config/systemd/user/rin-daemon*.service`
- macOS: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

Then invoke the stable installed runtime entry directly:

```bash
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

This is the canonical update path for the installed runtime. It refreshes the core runtime and installed docs. It does not replace the user-scoped CLI launcher or installer.

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
rin start      # start the background runtime
rin stop       # stop the background runtime
rin restart    # restart the background runtime
rin update     # update the installed Rin core runtime
```

Normally, use `rin`. `rin --std` is a troubleshooting fallback for foreground recovery or debugging when the default RPC path is not working.

## Documentation

This README is the user documentation. Translations live in `readme/README.*.md` and must stay aligned with this English version; update them in the same change when user-facing README content changes.

Internal documentation is intentionally separated:

- Agent-facing runtime guidance lives in `docs/agent/` and is installed to `agentDir/docs/rin/`.
- Developer technical documentation lives in `docs/developer/`.
- Release-note metadata lives in `docs/release/CHANGELOG.md` for `/changelog` and release workflows.

If you are changing Rin itself, start with [`docs/developer/README.md`](docs/developer/README.md).

## Project status

Rin is moving toward a cleaner core, stronger reliability, better install and update flows, and a more useful everyday assistant experience.

It is still early. If you want a finished, fully settled product, Rin is not there yet. If you want to try a local AI assistant that remembers, improves, and is already being used to build itself, that is what Rin is trying to become.
