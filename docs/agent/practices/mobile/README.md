# Mobile Use Practices

Use mobile practices when the task involves a phone, tablet, emulator, mobile app, push notification, mobile browser, app store flow, or device-specific account state.

## Selection rule

1. **Identify target device:** confirm the physical device, emulator, OS, and connection method before acting.
2. **Read-only inspection:** prefer `adb devices`, package listings, current activity, screenshots, and logs before input.
3. **Platform-specific procedure:** read Android guidance (`android.md`) before Android work.
4. **Owner-assisted boundary:** ask the owner before unlocking a device, approving MFA, purchasing, deleting data, or changing account/device settings.

## Current coverage

- Android: `android.md`

## General rules

- Confirm which device/emulator is targeted before acting.
- Prefer read-only inspection (`adb devices`, app package listing, screenshots) before input.
- Keep the screen awake only when needed and restore state when practical.
- Do not unlock devices, approve MFA, purchase, delete data, or change account/device settings without owner approval.

## Evidence bundle

For final answers or handoff, include the device/emulator name, OS/API level if known, app package/activity, screenshot path for visual claims, command/log snippets used as evidence, and unresolved owner/manual steps.
