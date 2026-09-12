# Validation

Automated checks cover the shared agent contract, native command construction for Claude Code, pi, and OpenCode, per-session serialization, Codex app-server behavior, chat admission and delivery, durable Nerve delivery, isolated updates, launchers, and service lifecycle.

Fixtures and subprocess probes establish code behavior. They do not replace acceptance with real agent credentials or live chat accounts.

## Acceptance sequence

1. Verify that Rin invokes the configured Codex executable with `app-server daemon start` before connecting. Verify that explicit stop and restart invoke `app-server daemon stop` and `app-server daemon restart`, with a fresh handshake after restart. Confirm that command failure is reported without classifying the installation source or falling back to `app-server --listen`. Bind a task and verify input, intermediate output, final output, attachments, restart recovery, and the no-server error path.
2. Install and authenticate each selected CLI agent. Starting from an empty chat configuration, verify that the first admitted message creates a native conversation, concurrent follow-ups share it, another chat gets a separate conversation, and a Rin restart preserves continuity. Check native errors and interrupted creation separately.
3. For every enabled transport, verify an authorized message, rejected identity, configured allow and deny rules, registered command, quiet delivery, attachments, and restart recovery.
4. For Telegram and OneBot, verify private-like routing only with a fresh complete member list containing the bot and exactly one configured owner.
5. Run the installation flow in a clean per-user directory and verify launcher ownership, service registration, update rollback, and removal on each documented platform.

Record the real agent version, platform, session type, checks, and observed receipts. Keep credentials, account IDs, task IDs, and private paths outside the public repository.
