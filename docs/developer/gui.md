# GUI shell

> Audience: agent/developer implementation reference for Rin maintainers. This page documents current product and runtime boundaries; it is not end-user installation documentation.

Rin's user-facing `rin gui` shell is a native desktop surface, not a browser-hosted page. The Rin runtime side owns one reusable native desktop host contract: start the target user's daemon, launch a desktop GUI framework host over stdio, then bridge UI commands and daemon events as JSON lines.

The concrete host shipped by this line is `rin-desktop-host`, an Electron desktop host. Core Rin uses Electron as the cross-platform GUI framework instead of carrying separate WPF/Cocoa/Tk implementations in the runtime. The reused boundary is the daemon RPC frontend plus the stdio JSON host protocol.

## Launch

```bash
rin gui
```

`rin gui` starts the target user's Rin daemon when needed and launches the native desktop host command. The default host command is `rin-desktop-host --stdio`; advanced packaging or local development can point `RIN_GUI_NATIVE_HOST` at another compatible host command while preserving the same stdio JSON protocol.

No browser fallback is exposed. Browser-style switches such as `--web`, `--host`, `--port`, `--open`, `--no-open`, and `--app` are rejected. The former `--native` compatibility spelling is also rejected instead of being kept as a no-op before that interface has shipped.

On Windows, the default `rin` launch path is GUI-first and enters `rin gui`. Linux and macOS keep the existing TUI default, while still allowing explicit `rin gui` once the desktop host is installed.

## GUI installer shell

```bash
rin-install --gui
```

On Windows, interactive `rin-install` enters the GUI-first installer path by default unless `--tui` or `--no-gui` is passed. The installer now uses the same Electron desktop host contract as `rin gui`: `rin-install` launches `rin-desktop-host --stdio --installer`, the renderer talks through the preload IPC bridge, and the installer process handles local model discovery, plan refresh, auth saving, and final apply commands over stdio JSON lines. It does not start a browser server and no longer exposes browser-only `--host`, `--port`, `--open`, or `--no-open` switches.

The installer window is a step-by-step wizard for language/target user/install directory, provider/model/thinking-level selection from the local model registry, default-target choice, safety boundary, provider API-key auth saving, and install plan preview. When the selected provider already has stored auth and no terminal privilege prompt is required, it applies the installation directly through the existing child apply-plan boundary. If cross-user or protected-directory writes need terminal confirmation, the installer writes a private apply-plan file and shows a one-line terminal handoff command instead of embedding credentials in UI text. Update mode and non-interactive child install paths stay non-GUI so release updates keep their existing automation boundary.

## Scope

The installer writes direct `rin-gui` launchers and, on finalized Windows installs, a user-scoped Start Menu/Desktop `Rin GUI.cmd` launcher plus a Startup launcher for the daemon. That gives Windows a GUI-first installed entry, daemon autostart, and terminal handoff without requiring a machine-wide service install.

Preview artifacts for issue review should be posted in the GitHub issue or PR discussion instead of being committed under `docs/developer/` or `docs/agent/`.
