# Practices

Use this directory when a task needs extra environment-control guidance beyond the main topic docs.

Practice pages are routing contracts. Choose the page that owns the interaction surface, follow its selection rule, and report the evidence bundle from that page.

## Selection contract

Start with the least visual path that proves the required fact: API, CLI, file, log, SDK, or repository test harness. Move to browser or desktop control when the user-visible state lives there.

Use `browser-use.md` for:

- page navigation and JavaScript-rendered web state;
- headless/headful browser choice;
- browser profiles, downloads, screenshots, PDFs, DOM snapshots, network and console evidence;
- local or remote browser execution.

Use `computer-use.md` for:

- OS or desktop application state;
- windows, screenshots, keyboard/mouse input, accessibility controls, or native app automation;
- local or remote Linux, Windows, or macOS desktop sessions;
- file/service/process state tied to a visible desktop workflow.

When both apply, identify the desktop/session target with `computer-use.md`, then use `browser-use.md` for page-level proof inside the browser.

## Output contract

When a practice page guides the work, report:

- selected practice page;
- target host/app/browser/session;
- control path chosen;
- evidence bundle produced;
- validation that proves the final state.

## Topics

- [Browser Use](browser-use.md): browser-path selection and evidence for headless/headful, local, and remote browser work.
- [Computer Use](computer-use.md): desktop/OS control-path selection and evidence for local and remote Linux, Windows, and macOS work.

## Read next

- Turn target and capability alignment: `../docs/execution-environment.md`.
- Browser-specific page state and artifacts: `browser-use.md`.
- Desktop/session control and OS automation: `computer-use.md`.
