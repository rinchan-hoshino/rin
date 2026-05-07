[English](README.md) · [简体中文](readme/README.zh-CN.md) · [日本語](readme/README.ja.md) · [Español](readme/README.es.md) · [Français](readme/README.fr.md) · [More languages](readme/README.md)

# Rin

> **Your personal AI assistant, living on your computer.**<br>
> Rin remembers what matters, helps with real tasks, and gets better as you use it.

Rin is a local, general-purpose AI assistant with memory, tools, scheduling, UI entry points, and chat bridges built in. It is also built with Rin: the project uses its own assistant to plan, edit, review, translate, and maintain this repository.

> [!WARNING]
> Rin is still young. Treat everyday use as experimental: you may meet rough edges, missing documentation, unstable behavior, token/API cost, or occasional breaking changes.

## Installation

> [!TIP]
> Most users should start with the stable install command below. Pre-release and git channels are available in the folded sections.

### Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

<details>
<summary>Other release channels</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

Install from PowerShell or Windows Terminal. Node.js and npm must be available first.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

<details>
<summary>Other release channels</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

</details>

On Windows, the interactive installer opens the GUI installer by default. After installation, `rin` opens the desktop GUI by default, and Rin also writes GUI launchers plus a user-scoped Startup launcher for the background runtime.

## Basic usage

```bash
rin            # open Rin
rin -p "..."   # run a one-shot assistant turn
rin doctor     # inspect health and configuration
```

## Capabilities

Rin is designed for everyday assistant work, not only coding:

- remember durable facts, preferences, projects, and recurring instructions
- summarize, rewrite, and organize documents
- search the web for current information
- inspect and manage files
- create reminders and scheduled tasks
- keep long-term notes from repeated work
- help with code and repositories
- operate connected services or local commands under your supervision
- respond through the terminal, desktop app, automation, or connected chat apps as the same assistant

## Key features

| Feature                  | What it means                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Global memory            | Useful facts and lessons can survive beyond a single chat session.                    |
| Learns from repeated use | Corrections and successful workflows can become compact instructions and skills.      |
| Local background runtime | Different interfaces can connect to one assistant state instead of isolated windows.  |
| Ready-to-use product     | Memory, scheduling, tools, chat bridges, and UI paths are provided out of the box.    |
| Self-bootstrapped        | Rin is used to build Rin, so the repository is a live test of the assistant workflow. |

## Safety and cost

Rin can keep context, write memory, run scheduled work, search the web, and call models repeatedly. This may consume more model tokens, API quota, or subscription capacity than a one-off chat.

Use supervision for important actions. Do not let Rin perform irreversible or sensitive work unless you understand the risk and can review or roll back the result.

<details>
<summary>Technical direction</summary>

Rin is built on Pi and keeps Pi's KISS-first spirit:

- keep the core small and understandable
- show the model the real tools and context
- let the model decide when that is the simplest reliable design
- avoid model-specific tricks and over-tuned prompts
- prefer transparent local state over remote platform lock-in

Rin is not trying to be a heavy agent framework. It is trying to be a practical everyday assistant that can remember, act, and improve while staying inspectable.

</details>

## Documentation

This README is the public user overview. Translations live in `readme/README.*.md` and should stay aligned with this English version.

If you are changing Rin itself, start with [`docs/developer/README.md`](docs/developer/README.md). Agent-facing runtime guidance and installed docs are kept separately from this public README.
