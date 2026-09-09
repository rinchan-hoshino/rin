# Validation status

Automated verification covers the shared AgentBridge contract, native command construction for Claude Code, pi, and OpenCode, per-session serialization, Codex app-server client behavior, chat admission and delivery policy, durable Nerve delivery, isolated updates, stable launchers, and Rin service lifecycle.

These checks use local fixtures and subprocesses. They establish code behavior; they are not agent or chat-platform end-to-end acceptance.

## Current environment

- Codex CLI 0.153.4 is installed. This refactor did not start or restart its app-server and did not submit a real task.
- Claude Code, pi, and OpenCode are not installed, so their real session-resume flows are unverified.
- Discord, Telegram, and OneBot were not connected to live accounts during this refactor.

## CLI protocol probes

On 2026-09-09, isolated installs were used to exercise the real command
surfaces without importing the owner's configuration or sending private
context:

- Claude Code `2.1.266` accepted `-p --resume <session> --output-format text`.
  A disposable unknown session returned a non-zero "conversation not found"
  error. A fresh `--session-id` probe returned JSONL `system`, `assistant`, and
  `result` records with an authentication error and no model request.
- pi `0.85.1` accepted `-p --session <id> <prompt>`. Its RPC help exposes a
  JSON stdin/stdout protocol; a no-key probe returned a non-zero no-API-key
  error. No private session was opened.
- OpenCode `1.18.30` accepted `run --session <id> <prompt>` and exposes
  `--format json`; an unknown disposable session returned "Session not found".
  An isolated `--pure --format json --model openai/gpt-4o` no-key run returned
  a JSON `UnknownError` and non-zero exit; a separate fresh probe attempted a
  network tool step and was stopped, so no OpenCode model completion is
  claimed.

These probes validate argv and failure boundaries only. They do not establish
authenticated model output, cancellation, restart recovery, or chat-platform
delivery. The adapters must continue to report those items as unverified until
an operator supplies credentials and a disposable native session.

## Remaining acceptance

1. With an operator-started Codex app-server, bind a disposable task and verify one input, intermediate output, final output, attachment, restart recovery, and the no-server failure path.
2. Install and authenticate each selected CLI agent independently. Verify its documented non-interactive session-resume command with a disposable native session before enabling that adapter.
3. For each enabled chat transport, verify an authorized message, a rejected identity, allow and deny chat rules, a registered command outside the chat lists, quiet delivery, attachments, and restart recovery.
4. On Telegram and OneBot, verify private-like routing only with a complete live member list containing the bot and exactly one configured owner.
5. Run the public installation prompt in a clean per-user directory. Verify launcher ownership checks, service registration, update rollback, and removal on every supported operating system that will be documented as accepted.

Record the real CLI version, platform, session type, checks, and observed receipts for each completed item. Keep credentials, account IDs, task IDs, and private paths outside the public repository.
