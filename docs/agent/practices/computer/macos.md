# macOS Computer Practices

Use this for macOS desktop work, LaunchAgents, app bundles, permissions prompts, and GUI automation.

## Inspection first

- Use `ps`, `launchctl`, `plutil`, `defaults read`, `ls`, `stat`, and app bundle paths for read-only checks.
- Treat Accessibility, Screen Recording, Keychain, and browser profile prompts as owner-controlled permission boundaries.

## GUI operation

- Identify the frontmost app and window title before interacting.
- Prefer AppleScript or app CLI only when it is task-appropriate and reversible.
- Do not approve permission prompts, keychain prompts, payments, or account changes without owner approval.

## Evidence

Include window/app name, screenshot path when visual state matters, changed plist/path, and whether logout/restart is required.
