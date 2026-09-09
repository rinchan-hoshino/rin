# Validation

Automated checks cover the shared agent contract, native command construction for Claude Code, pi, and OpenCode, per-session serialization, Codex app-server behavior, chat admission and delivery, durable Nerve delivery, isolated updates, launchers, and service lifecycle.

Fixtures and subprocess probes establish code behavior. They do not replace acceptance with real agent credentials or live chat accounts.

## Acceptance sequence

1. Start a disposable Codex app-server, bind a task, and verify input, intermediate output, final output, attachments, restart recovery, and the no-server error path.
2. Install and authenticate each selected CLI agent. Verify its documented non-interactive resume command with a disposable native session.
3. For every enabled transport, verify an authorized message, rejected identity, configured allow and deny rules, registered command, quiet delivery, attachments, and restart recovery.
4. For Telegram and OneBot, verify private-like routing only with a fresh complete member list containing the bot and exactly one configured owner.
5. Run the installation flow in a clean per-user directory and verify launcher ownership, service registration, update rollback, and removal on each documented platform.

Record the real agent version, platform, session type, checks, and observed receipts. Keep credentials, account IDs, task IDs, and private paths outside the public repository.
