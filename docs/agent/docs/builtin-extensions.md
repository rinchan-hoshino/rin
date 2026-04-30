# Builtin Capabilities

This document describes the extra capabilities Rin gives the agent.
These capabilities are now registered directly by Rin core rather than being force-loaded through the app layer as builtin extensions.

## Default extra capabilities

- `web-search`
  - provides live web search
- `fetch`
  - provides direct URL text fetching
- `memory`
  - provides `*_memory` tools and memory-related prompt support
- `reset-system-prompt`
  - adds Rin's default stance and chat style prefix to the agent
- `message-header`
  - adds message metadata such as `sent at`; adds chat-specific context in chat bridge scenarios
- `freeze-session-runtime`
  - keeps the effective system prompt stable within a session
- `tui-input-compat`
  - smooths over some TUI input compatibility issues
- `subagent`
  - provides `run_subagent` and `list_models`
- `task`
  - provides task management tools such as `list_tasks`, `save_task`, and `pause_task`
- `chat`
  - provides `chat_bridge`, `get_chat_msg`, `list_chat_log`, and `save_chat_user_identity`
  - provides `/chat` for official adapter setup inside the TUI
  - `/chat` enters platform selection directly, keeps installer-only opt-in confirmation, prefers the minimum runnable fields, defaults to polling / socket modes when supported, and includes direct official links for required values
- `token-usage`
  - records detailed token telemetry under `~/.rin/data/token-usage/usage.db`
  - powers the `rin usage` text dashboard and grouped usage queries

## Usage note

These capabilities are part of normal Rin behavior.
`src/core/builtins/` now holds only the builtin registry and wiring layer. Concrete code lives directly in its owning domains such as `src/core/chat/`, `src/core/subagent/`, `src/core/memory/`, `src/core/self-improve/`, `src/core/rin-lib/`, `src/core/chat-bridge/`, and `src/core/rin-tui/`.
