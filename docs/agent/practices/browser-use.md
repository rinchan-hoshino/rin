# Browser Use Practices

Rin does not ship a built-in `browser_use` extension. Use these patterns when a task needs browser automation and the live tool list does not already provide a dedicated browser-control tool.

## Selection rule

Choose by what the browser must prove:

- Use **headless** for deterministic, login-free, CI-like, or page-inspection work.
- Use **headful** for account flows, visual checks, extension-dependent behavior, downloads, consent dialogs, CAPTCHAs, or pages that behave differently without a visible browser.
- Prefer direct HTTP/API access when a browser is not needed.

## Headless browser use

- Use project-local Playwright, Puppeteer, Selenium, or another already-approved browser harness when available.
- Keep a fresh isolated profile unless the task explicitly requires an existing account session.
- Record enough evidence to debug: URL, status, console/network errors, screenshot, DOM snapshot, trace, or downloaded artifact.
- Set timeouts and close browsers so background processes do not survive the turn.
- Do not use headless mode to bypass site rules, account protections, or human-verification boundaries.

## Headful browser use

- Use headful mode when the human-visible page state matters.
- Confirm the browser profile owner before using saved sessions, cookies, or credentials.
- Prefer semantic automation through Playwright/Selenium/CDP selectors; use screen coordinates only as a last step after a screenshot confirms the target.
- Stop at irreversible confirmations unless the user explicitly names the exact control to press.
- For owner-owned credentials or profiles, repair through the owning browser/account path; do not print secrets or move cookies into a different boundary.

## Local browser use

- Prefer a project-local harness and local browser binaries for reproducible tests.
- For local headless work, use an isolated temporary user-data directory and clean it up.
- For local headful work, launch in the owning desktop session. Check `DISPLAY`/Wayland on Linux, the logged-in user on macOS, and the interactive desktop session on Windows.
- If an existing browser profile is required, use the approved profile path and avoid changing it for unrelated tasks.

## Remote browser use

- For remote headless work, run the browser on the remote host and collect artifacts back through SSH, a workspace, or the test harness.
- For remote headful work, use an explicit remote desktop path such as RDP, VNC/noVNC, Screen Sharing, or an approved browser VM/agent.
- If using CDP or WebDriver remotely, bind to loopback and reach it through an SSH/VPN tunnel. Do not expose browser debugging ports to the public network.
- Keep local-vs-remote artifacts clear: a screenshot from the remote browser proves the remote page, not the local desktop.

## Practical workflow

1. Verify the target site, account boundary, and whether headless or headful is required.
2. Start with a minimal navigation or status check.
3. Capture evidence before mutation: screenshot, DOM/snapshot, URL, and relevant console/network failures.
4. Perform the smallest action sequence.
5. Verify the final state and close or intentionally leave the browser according to the task boundary.
