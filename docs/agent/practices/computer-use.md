# Computer Use Practices

Use this page when a task needs desktop or OS interaction and the current live tools require the agent to choose a control path.

The job of this page is selection and evidence: choose command, OS-native automation, visible desktop automation, or remote desktop; act in the target user session; capture artifacts; verify the visible or file-level result.

## Selection rule

Choose the least visual path that proves the required fact:

- **File/API/CLI/log access** for stable state, configuration, processes, services, installers, and reproducible diagnostics.
- **OS-native automation** for scriptable application actions through DBus, AppleScript/JXA, PowerShell, app CLIs, registry/query commands, or platform APIs.
- **Window-level automation** for UI state that has semantic controls, accessibility names, window handles, or app automation APIs.
- **Screen plus input** for last-mile work where the visual state is the proof or the application exposes the required control only visually.
- **Remote desktop** for a visible UI running on another machine.

Before input, identify the target host, OS, desktop user, session, active window, display scale, and success state.

## Local Linux path

Prefer shell commands, project CLIs, DBus commands, desktop portals, app-specific tools, and config files for reproducible checks.

For visible desktop work, establish:

- `XDG_SESSION_TYPE`;
- `DISPLAY`;
- `WAYLAND_DISPLAY`;
- desktop environment or compositor;
- target window title/class/process.

Useful tools by layer:

- screenshots: `gnome-screenshot`, `spectacle`, `grim`, `import`, `scrot`;
- X11 windows/input: `xdotool`, `wmctrl`, `xprop`, `xwininfo`;
- Wayland input: compositor-specific tools such as `wtype` where the compositor supports them;
- app state: DBus, desktop portals, app CLIs, logs, config files.

## Local Windows path

Prefer PowerShell, app CLIs, event logs, registry/query commands, service controls, and file inspection for reproducible checks.

For visible desktop work, run inside the interactive desktop session for the target user. Keep service/session-0 commands separate from UI actions in the logged-in session.

Useful tools by layer:

- system state: PowerShell, `Get-Process`, `Get-Service`, Event Viewer logs, registry queries;
- app state: app CLIs, COM/PowerShell automation, log files, config files;
- UI state: UI Automation, accessibility names, window handles, screenshots;
- last-mile input: mouse/keyboard actions after confirming target window, focus, scale/DPI, and control position.

## Local macOS path

Prefer CLI tools, app-specific commands, Shortcuts, AppleScript, and JXA for reproducible checks.

For visible desktop work, run inside the logged-in GUI user session. Screen Recording and Accessibility permissions are account-scoped; report the exact permission requested by the operating system for observation or input.

Useful tools by layer:

- screenshots: `screencapture`;
- app automation: `osascript`, AppleScript, JXA, Shortcuts;
- app state: app CLIs, logs, preferences, config files;
- last-mile input: existing installed input tools or the live desktop tool list after confirming window, focus, and scale.

## Remote computer path

Remote work has two separate paths: command access and visible desktop access.

- **Remote Linux:** use SSH for command work. For GUI work, use the remote display owned by the target user or an explicit VNC/RDP/noVNC session.
- **Remote Windows:** use PowerShell remoting, SSH, WinRM, or PowerShell Direct for command work. Use RDP or a live runtime desktop tool for visible desktop work.
- **Remote macOS:** use SSH for command work. Use Screen Sharing/VNC for visible work inside the owning GUI session.

For remote control endpoints, bind to loopback or tunnel through SSH/VPN. Label artifacts by host and session so the report clearly distinguishes remote evidence from local evidence.

## Evidence bundle

A useful computer-use evidence bundle names:

- target host, OS, desktop user/session, and local vs remote path;
- selected control layer: CLI/API, OS-native automation, window-level automation, screen plus input, or remote desktop;
- baseline observation: file state, process/window list, screenshot, or app status;
- action sequence at a concise level;
- final verification: screenshot, window state, file state, service state, log line, app result, or test output;
- artifact paths for screenshots, logs, traces, exports, or downloaded files.

Keep raw artifacts compact in the final response. Name paths and summarize findings instead of pasting large logs or screenshots as text.

## Practical workflow

1. State the target host, OS, desktop user/session, and selected control path.
2. Capture a read-only baseline observation.
3. Prefer semantic controls, app APIs, and OS-native automation before coordinates.
4. Use coordinates as a last-mile action after a screenshot confirms target window, scale, focus, and control.
5. Verify the final state through the same layer that matters to the user: visible screen, app state, file state, service state, or test output.
6. Close temporary sessions, collect artifacts, and report the evidence bundle.

## Read next

- Browser-specific page state, headless/headful browser choice, and downloads: `browser-use.md`.
- Chat delivery of screenshots/files: `../docs/rich-text-output-format.md`.
