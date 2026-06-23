# Agent Practices

This directory is the first stop for agent-operated external surfaces: browser work, desktop/computer work, mobile-device work, and network search. Read it when the live tool list, task wording, or owner request mentions a browser, webpage, desktop app, OS UI, phone, Android device, Google, SearXNG, search engine, current web evidence, login flow, download, screenshot, or manual account workflow.

## Route map

| Need                                                                           | Read first           | Then read                                                          |
| ------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------ |
| Web pages, login flows, downloads, screenshots, headful/headless browser state | `browser/README.md`  | `search/README.md` when search is needed                           |
| Desktop or OS UI work                                                          | `computer/README.md` | `computer/windows.md`, `computer/linux.md`, or `computer/macos.md` |
| Phone/tablet work                                                              | `mobile/README.md`   | `mobile/android.md`                                                |
| Fast web search, Google URL construction, or local/private meta-search setup   | `search/README.md`   | `browser/README.md` for opening result pages                       |

## General contract

- Prefer the live tool list and owner-approved credentials/accounts over assumptions.
- Keep evidence: URLs, titles, timestamps, screenshots, downloaded file paths, command output, or exact UI state.
- Use the least invasive path first: direct URL/search -> browser automation -> desktop/mobile automation -> owner-assisted manual step.
- Do not alter owner accounts, processes, files, OS settings, or devices without task-relevant need and clear approval.
- If a task needs current external facts and no search/browser tool exists in the current environment, state the missing surface instead of fabricating evidence.

## Repository sync

Rin may seed these practices at install time and refresh the installed copy from the external practices repository. Treat the installed path `~/.rin/docs/rin/practices/` as the stable read path for agents.
