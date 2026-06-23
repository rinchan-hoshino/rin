# Computer Use Practices

Use computer/desktop automation when the task needs OS UI state, local GUI applications, files opened in a desktop app, browser windows outside browser-tool control, or cross-application workflows.

## Selection rule

1. **Command-line inspection:** use shell commands first for read-only file, process, package, network, and configuration facts.
2. **Desktop automation:** use GUI automation when the visible UI state, a local app, or cross-application workflow is the actual target.
3. **OS-specific procedure:** read the matching page before acting: Windows (`windows.md`), Linux (`linux.md`), or macOS (`macos.md`).
4. **Owner-assisted boundary:** ask for help before credentials, MFA, payments, destructive file changes, privacy-sensitive windows, or irreversible OS settings.

## OS pages

- Windows: `windows.md`
- Linux: `linux.md`
- macOS: `macos.md`

## Shared rules

- Prefer command-line inspection for read-only facts; use GUI automation when UI state itself matters.
- Avoid killing, moving, editing, or deleting owner processes/files without explicit task need and approval.
- Keep a visible evidence trail: screenshot, window title, process name, path, command output, or exact setting label.
- For multi-step UI work, narrate the intended action before irreversible clicks.
- If the active machine is remote, state which machine/session you are controlling.

## Evidence bundle

For final answers or handoff, include the controlled machine/OS, command output or screenshot path, relevant file/app/window names, exact setting labels changed or inspected, and unresolved owner/manual steps.
