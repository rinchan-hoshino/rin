# Android Mobile Practices

Use this for Android devices and emulators through ADB, scrcpy, Android Studio, or a live mobile-control tool.

## Inspection first

```bash
adb devices -l
adb shell getprop ro.product.model
adb shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'
adb shell pm list packages | grep -i '<app-name>'
```

- Confirm the target serial when multiple devices are attached.
- Keep separate, task-scoped screenshots before and after UI actions so later evidence cannot overwrite the baseline:

```bash
adb exec-out screencap -p > /tmp/android-screen-before.png
# perform the inspected UI action
adb exec-out screencap -p > /tmp/android-screen-after.png
```

Use a narrower task identifier in the filenames when multiple devices or jobs may run concurrently.

## UI operation

- Prefer semantic mobile tool actions when available; fall back to ADB taps/swipes only after locating coordinates from a screenshot.
- For text input, escape shell-sensitive characters and verify the target field is focused.
- Do not unlock the device, approve MFA, change security settings, purchase, uninstall, clear app data, or grant broad permissions without owner approval.

## Browser/app flows

- Use Chrome/Brave/target app only after confirming package and account boundary.
- For deep links, record the exact URI and resulting app/screen.
- For downloads or shared files, record Android path and host-side pulled path if copied.

## Evidence

Include device serial/model, app package/activity, screenshot path, command output, and any owner-required manual step.
