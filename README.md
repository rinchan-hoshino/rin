[English](README.md) · [简体中文](readme/README.zh-CN.md) · [日本語](readme/README.ja.md) · [Español](readme/README.es.md) · [Français](readme/README.fr.md) · [More languages](readme/README.md)

# Rin

> **Your personal AI assistant, living on your computer.**<br>
> Rin remembers what matters, helps with real tasks, and gets better as you use it.

Rin is a local, general-purpose AI assistant with memory, tools, scheduling, UI entry points, and chat bridges built in. It can help with documents, web research, files, reminders, code, connected services, and repeated workflows — while sharing one assistant state across terminal, desktop, automation, and chat.

| What matters             | What Rin provides                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Global memory            | Useful facts, preferences, and lessons can survive beyond a single chat session.      |
| Learns from repeated use | Corrections and successful workflows can become compact instructions and skills.      |
| Local background runtime | Different interfaces connect to one assistant instead of isolated chat windows.       |
| Ready-to-use product     | Memory, scheduling, tools, chat bridges, and UI paths are provided out of the box.    |
| Self-bootstrapped        | Rin is used to build Rin, making this repository a live test of the assistant itself. |

> [!WARNING]
> Rin is still young. Treat everyday use as experimental: you may meet rough edges, missing documentation, unstable behavior, token/API cost, or occasional breaking changes.

## Support Rin

If Rin saves you time, you can support its maintenance on [Ko-fi](https://ko-fi.com/THE_cattail). Sponsorship is voluntary and supports ongoing maintenance costs; it does not buy feature priority or private support commitments.

## Installation

> [!TIP]
> Most users should start with the stable install command below. Pre-release and git channels are available in the folded sections.

Rin requires Node.js 22.19.0 or newer and npm on every platform.

### Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh
```

<details>
<summary>Other release channels</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

Install from PowerShell or Windows Terminal.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1)))
```

<details>
<summary>Other release channels</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git deadbeef
```

</details>

On Windows, the interactive installer opens the GUI installer by default. After installation, `rin` opens the desktop GUI by default, and Rin also writes GUI launchers plus a user-scoped Startup launcher for the background runtime.

## Safety and cost

Rin can keep context, write memory, run scheduled work, browse the web, and call models repeatedly. This may consume more model tokens, API quota, or subscription capacity than a one-off chat.

Use supervision for important actions. Do not let Rin perform irreversible or sensitive work unless you understand the risk and can review or roll back the result.

## Technical direction

Rin is built on Pi and keeps Pi's KISS-first spirit:

- keep the core small and understandable
- show the model the real tools and context
- let the model decide when that is the simplest reliable design
- avoid model-specific tricks and over-tuned prompts
- prefer transparent local state over remote platform lock-in

Rin is not trying to be a heavy agent framework. It is trying to be a practical everyday assistant that can remember, act, and improve while staying inspectable.

## Documentation

This README is the public user overview. Translations live in `readme/README.*.md` and should stay aligned with this English version.

If you are changing Rin itself, start with [`docs/developer/README.md`](docs/developer/README.md). Agent-facing runtime guidance and installed docs are kept separately from this public README.
