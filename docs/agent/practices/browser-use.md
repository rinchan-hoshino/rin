# Browser Use Practices

Use this page when a task needs a browser path and the current live tools or project harness require the agent to choose how to drive it.

The job of this page is selection and evidence: choose headless or headful, choose local or remote, use the owning profile boundary, capture artifacts, and verify the visible or page-level result.

## Selection rule

Choose the smallest browser path that proves the required fact:

- **Direct HTTP/API** for stable endpoints, downloads, metadata, and static page content.
- **Headless browser** for deterministic navigation, login-free page inspection, JavaScript-rendered pages, CI-like checks, screenshots, PDFs, and download capture.
- **Headful browser** for account flows, visual layout checks, extension-dependent behavior, downloads that need the desktop shell, consent dialogs, human-verification surfaces, and pages that behave differently with a visible browser.
- **Existing profile** when saved cookies, account state, browser extensions, or site trust are part of the requested proof.
- **Fresh isolated profile** for reproducible checks where account state is irrelevant.

## Headless browser path

Use a project-local Playwright, Puppeteer, Selenium, WebDriver, CDP, or test harness when the repository already provides one. Keep the run reproducible:

- create a fresh temporary user-data directory for isolated checks;
- set explicit navigation/action timeouts;
- collect the URL, status, console errors, network failures, screenshot, DOM snapshot, trace, and downloaded artifacts that explain the result;
- close the browser and remove temporary profiles after verification;
- store artifacts under the task workspace or another path the final report can name clearly.

Good headless tasks:

- verify a public page renders expected text;
- collect a screenshot/PDF for a known URL;
- reproduce a login-free web bug;
- inspect console/network failures after navigation;
- run the repository's browser tests.

## Headful browser path

Use headful mode when the visible browser state is the evidence or when the site path is account/profile dependent.

Before input, establish:

- target machine and desktop session;
- browser app and profile path;
- account/profile owner;
- current URL and visible page state;
- the exact UI state that counts as success.

Prefer semantic browser automation through selectors, accessibility names, WebDriver, Playwright locators, or CDP. Use coordinates only as a last-mile action after a screenshot identifies the target window, scale, focus, and control.

## Local browser path

For local browser work:

- use the repository's browser test harness and browser binaries when available;
- place temporary profiles and downloads under the task workspace or `/tmp` with a clear prefix;
- for Linux headful runs, confirm `DISPLAY`, `WAYLAND_DISPLAY`, and `XDG_SESSION_TYPE`;
- for macOS headful runs, run inside the logged-in GUI user session;
- for Windows headful runs, run inside the interactive desktop session for the target user;
- leave an existing profile exactly in its owning boundary and record only the profile identity needed for the report.

## Remote browser path

For remote browser work, keep the proof tied to the machine where the page ran.

- Run remote headless browsers on the remote host and collect artifacts back through SSH, the workspace, or the project harness.
- Run remote headful browsers through an explicit visible path such as RDP, VNC/noVNC, Screen Sharing, or an approved browser VM/agent.
- Publish CDP/WebDriver endpoints through loopback plus SSH/VPN tunnel.
- Label artifacts by host and browser path so the report clearly distinguishes remote screenshots from local desktop screenshots.

## Evidence bundle

A useful browser evidence bundle names:

- target URL and final URL;
- browser path: direct HTTP/API, headless, headful, local, remote, existing profile, or isolated profile;
- status/result and relevant console/network errors;
- screenshot, DOM snapshot, trace, downloaded file, or test output path;
- account/profile boundary when it affects the result;
- final verification step.

Keep raw artifacts compact in the final response. Name paths and summarize findings instead of pasting large HTML, logs, or binary output.

## Practical workflow

1. State the target site, required proof, and selected browser path.
2. Start with a read-only navigation or status check.
3. Capture baseline evidence before a page mutation.
4. Perform the smallest action sequence that reaches the target state.
5. Verify the final state with a visible screenshot, DOM/test assertion, downloaded artifact, or platform result.
6. Close temporary browser state and report the evidence bundle.

## Read next

- Desktop/session control and screenshots outside the browser: `computer-use.md`.
- Chat delivery of screenshots/files: `../docs/rich-text-output-format.md`.
