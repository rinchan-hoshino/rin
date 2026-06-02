# Computer Use Practices

Rin does not ship a built-in `computer_use` extension. Use these patterns when a task needs desktop or OS interaction and the live tool list does not already provide a dedicated computer-control tool.

## Selection rule

Prefer the least visual interface that can finish the task:

1. File/API/CLI/log access.
2. OS-native automation in the owning user session.
3. Screen inspection plus mouse/keyboard input.
4. Remote desktop only when the target machine or visible UI is remote.

Always verify the active machine, user, display session, and authority before sending input.

## Local Linux

- Prefer shell commands, project CLIs, DBus commands, and config files before GUI input.
- Check the display stack first: `XDG_SESSION_TYPE`, `DISPLAY`, `WAYLAND_DISPLAY`, and the desktop environment.
- For screenshots, use the installed desktop's tool when available, such as `gnome-screenshot`, `spectacle`, `grim`, `import`, or `scrot`.
- For input on X11, `xdotool` is the usual minimal option. On Wayland, use compositor-specific tools such as `wtype` only when the compositor allows it.
- Do not install screenshot/input packages or attach to a live desktop without user authority.

## Local Windows

- Prefer PowerShell, app CLIs, registry/query commands, logs, and file edits before GUI input.
- For a VM or owner Windows machine, use the approved Windows-agent, SSH, PowerShell Direct, or WinRM path for that machine.
- For screenshots or UI automation, use Windows-native APIs from the owning desktop session; avoid mixing service/session-0 execution with an interactive user desktop.
- GUI clicks should be last-mile actions after confirming the target window, scale/DPI, and current focus.

## Local macOS

- Prefer CLI tools, app-specific commands, Shortcuts, and AppleScript before raw mouse/keyboard control.
- Use `screencapture` for screenshots and `osascript` for AppleScript/JXA when the app exposes scriptable actions.
- Use tools such as `cliclick` only when they are already installed or the user approves installing them.
- Screen Recording and Accessibility permissions are account-scoped. If automation fails because permission is missing, report that exact permission boundary.

## Remote computer use

Remote control has two independent questions: command access and visible desktop access.

- **Remote Linux:** use SSH for commands. For GUI work, confirm the remote display (`DISPLAY`/Wayland) or use an explicit VNC/RDP/noVNC session owned by the target user.
- **Remote Windows:** use PowerShell remoting, SSH, WinRM, or PowerShell Direct for commands. Use RDP or the approved Windows-agent path for visible desktop work.
- **Remote macOS:** use SSH for commands and AppleScript only against a logged-in GUI session with the required permissions. For visible work, use Screen Sharing/VNC under the owning account.
- Never expose control ports publicly. Tunnel them over SSH/VPN or bind them to loopback.

## Operating checklist

1. State the target host, OS, user/session, and local vs remote path.
2. Take a read-only observation first: file state, process/window list, or screenshot.
3. Plan the smallest input sequence and avoid coordinate clicks when a semantic control exists.
4. After action, verify the visible or file-level result.
5. Preserve user-authored content and avoid hidden fallback behavior that masks the real boundary.
