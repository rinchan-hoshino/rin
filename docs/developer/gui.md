# GUI shell

> Audience: agent/developer implementation reference for Rin maintainers. This page records the current GUI boundary while the desktop UI is paused for redesign; it is not end-user installation documentation.

Rin's desktop GUI entry points are temporarily disabled. The supported interactive entry point on every platform is the command-line `rin` command, which launches the TUI through the installed runtime.

## Disabled user-facing entry points

These routes are intentionally not exposed while the GUI is being redesigned:

- `rin gui`
- `rin-gui`
- `rin-desktop-host`
- `rin-install --gui`
- Windows Start Menu/Desktop GUI launchers
- Windows GUI-first installer startup

The GUI source tree may remain in the repository as dormant implementation material, but installers and public package bins must not advertise or install GUI launchers until the redesign reintroduces a supported product surface.

## Current installer behavior

Interactive installs use the terminal installer on every platform. Windows installs write native `.cmd` launchers for the supported command-line entry points and keep the background daemon Startup launcher, but they do not create GUI shortcuts.

## Future GUI work

When the desktop UI is redesigned, reintroduce it as an explicit product boundary with updated README, installer flow, package bins, command help, tests, and release notes in the same change. Do not leave Windows with a different default command than other platforms; `rin` should remain the primary user command.
