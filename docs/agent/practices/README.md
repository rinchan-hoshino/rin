# Practices

This directory collects recommended operating patterns for agent tasks that need extra environment control. They are starting points, not universal answers; choose the smallest path that matches the live tools, host, user authority, and risk.

## Topics

- [Browser Use](browser-use.md): headless/headful browser work, local and remote.
- [Computer Use](computer-use.md): Linux, Windows, and macOS desktop work, local and remote.

## First check

Before following any practice page:

1. Trust the current live tool list over old docs or assumptions.
2. Prefer non-visual APIs, CLIs, files, logs, and SDKs before screen control.
3. Keep credentials, browser profiles, and desktop sessions inside their owning account boundary.
4. For irreversible or owner-visible actions, stop at the confirmation unless the user explicitly authorized the exact control to press.
