[English](README.md) · [简体中文](readme/README.zh-CN.md) · [日本語](readme/README.ja.md) · [Español](readme/README.es.md) · [Français](readme/README.fr.md) · [More languages](readme/README.md)

# Rin

> **Your personal AI assistant, living on your computer.**<br>
> Rin remembers what matters, helps with real tasks, and gets better as you use it.

Rin is not just another chat window. It is one assistant you can keep around: local, inspectable, connected to your tools when you allow it, and able to carry useful memory across sessions.

> [!NOTE]
> Rin is also built with Rin. The project uses its own assistant to plan, edit, review, translate, and maintain this repository, so self-improvement is tested in the product itself.

## ✨ Why try Rin

| You want...                           | Rin is designed to...                                            |
| ------------------------------------- | ---------------------------------------------------------------- |
| fewer repeated explanations           | remember durable facts, preferences, projects, and instructions  |
| an assistant that improves over time  | turn repeated corrections and workflows into memory and skills   |
| something usable without building one | ship memory, scheduling, tools, chat bridges, and UI paths       |
| control over what it touches          | run locally and show the tools, files, and configuration it uses |
| one assistant in many places          | connect terminal, desktop app, automation, and chat apps         |

## 🧰 What Rin can help with

Rin is a general-purpose assistant. Depending on what you configure, it can:

- summarize, rewrite, and organize documents
- search the web for current information
- inspect and manage files
- create reminders and scheduled tasks
- keep long-term notes from repeated work
- help with code and repositories
- operate connected services or local commands under your supervision
- respond through the terminal, desktop app, automation, or connected chat apps as the same assistant

## 🌱 What makes Rin different

### Global memory

Normal chat sessions forget too much. Rin can keep durable facts and reusable lessons outside a single conversation, then bring them back when they matter.

### Learns from you

You should not need to become a prompt engineer to teach your assistant. Rin can turn repeated corrections and successful workflows into compact instructions and skills.

### Always on in the background

Rin is designed as an assistant you keep around, not a tab you discard. Its background process lets different interfaces connect to the same assistant state.

### Rin helps build Rin

Rin is maintained with Rin. This repository is a live demonstration that the assistant can help improve the assistant itself.

## ⚠️ Current status

> [!WARNING]
> Rin is still young. Most everyday use should be treated as experimental: you may meet rough edges, missing documentation, unstable behavior, or occasional breaking changes.

Rin may use more model tokens, API quota, or subscription capacity than a one-off chat because it can keep context, write memory, run scheduled work, search the web, and call models repeatedly.

Use supervision for important actions. Do not let Rin perform irreversible or sensitive work unless you understand the risk and can review or roll back the result.

## 🚀 Install

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

### Existing checkout

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

## ⌨️ Basic commands

```bash
rin            # open Rin
rin doctor     # inspect health and configuration
rin status     # show live worker and scheduled-task activity
rin start      # start the background runtime
rin stop       # stop the background runtime
rin restart    # restart the background runtime
rin update     # update the installed Rin runtime
rin -p "..."   # run a non-interactive assistant turn
```

<details>
<summary>🧭 For technical readers</summary>

Rin is built on Pi and keeps Pi's KISS-first spirit:

- keep the core small and understandable
- show the model the real tools and context
- let the model decide when that is the simplest reliable design
- avoid model-specific tricks and over-tuned prompts
- prefer transparent local state over remote platform lock-in

Rin is not trying to be a heavy agent framework. It is trying to be a practical everyday assistant that can remember, act, and improve while staying inspectable.

</details>

## 🔄 Updating

For a normal installed Rin update, use:

```bash
rin update              # stable release (default)
rin update --beta       # current weekly beta candidate
rin update --nightly    # current nightly build
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

Stable is the default for install and update. `--beta` selects the current weekly beta candidate, `--nightly` selects the current nightly build from `main`, and `--git` without a suffix selects `main`.

Avoid treating repo-local workflows like `git pull`, ad-hoc rebuilds, or rerunning `install.sh` as the default way to update an already installed Rin.

## 📚 Documentation

This README is the public user overview. Translations live in `readme/README.*.md` and should stay aligned with this English version.

If you are changing Rin itself, start with [`docs/developer/README.md`](docs/developer/README.md). Agent-facing runtime guidance and installed docs are kept separately from this public README.
