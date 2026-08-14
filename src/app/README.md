# app

This directory is Rin's production executable and assembly boundary.

## Responsibilities

- own physical process termination and user-facing startup diagnostics
- wire executable arguments, signals, and dependencies into callable core runtimes
- provide executable entrypoints for the CLI, installer, daemon, workers, TUI, migrations, and updater payloads
- assemble app-specific capabilities around callable implementations from `src/core/`

## Invariants

- keep domain and protocol logic in `src/core/`
- keep core modules callable from tests or alternate hosts
- never make a core module terminate its importing process
- keep `src/app/` as the only production executable boundary

Builtin Rin capabilities remain implemented and registered from `src/core/`.
