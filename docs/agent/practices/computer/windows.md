# Windows Computer Practices

Use this for Windows desktop work, including GUI apps, PowerShell, Windows services, Startup tasks, named pipes, and owner-visible windows.

## Inspection first

- Use PowerShell for read-only inspection: `Get-Process`, `Get-Service`, `Get-ChildItem`, `Get-Content`, `Test-Path`.
- Prefer absolute paths under `%USERPROFILE%` and quote paths with spaces.
- For Rin owner Windows access, use the configured remote channel only when authorized by the current task.

## GUI operation

- Identify the window title, process name, and target control before typing/clicking.
- Avoid spawning visible console windows for background Node/daemon work; use hidden-window options such as `windowsHide: true` when code controls process creation.
- Do not terminate owner apps or patch files in use without approval.

## Evidence

Include PowerShell command output, window title, screenshot path, relevant file path, and whether the change needs sign-out/restart.
