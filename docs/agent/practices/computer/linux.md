# Linux Computer Practices

Use this for Linux desktop or server UI work, systemd user services, local files, processes, and graphical sessions.

## Inspection first

- Use `ps`, `pgrep`, `systemctl --user`, `journalctl --user`, `ls`, `stat`, and `cat` for read-only inspection.
- Distinguish source checkout, installed runtime, and user data paths.
- Avoid `sudo` unless the owner explicitly authorized elevated work.

## GUI operation

- Confirm display/session context before using GUI automation.
- Prefer app-native CLI or config files for reversible settings; use screenshots for visual evidence.
- Do not kill long-running user processes unless they are clearly the target and owner-approved.

## Evidence

Include commands run, relevant stdout/stderr, unit status/journal snippets, paths changed, and screenshot paths for GUI claims.
