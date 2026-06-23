# Browser Use Practices

Use this document for web tasks that need page state, login/session state, downloads, screenshots, or evidence from a rendered browser. The preferred browser stack is Brave plus `agent-browser` when available.

## Selection rule

1. **Direct URL/open evidence:** if the user provides a URL and a browser tool exists, open it directly.
2. **Search first:** if the task needs discovery, use `search/README.md` to construct a Google URL or run SearXNG, then open promising results in Brave.
3. **Headless automation:** use when rendering is enough and no user login, passkey, captcha, or visual manual step is needed.
4. **Headful Brave + agent-browser:** use when session cookies, visual state, downloads, account flows, or screenshots matter.
5. **Owner-assisted step:** request owner action only for credentials, MFA, payments, irreversible changes, or blocked automation.

## Brave + agent-browser baseline

- Browser: Brave.
- Automation layer: `agent-browser` or the live browser tool wrapping it.
- Profile: use a task-scoped or configured agent profile; do not reuse arbitrary owner profiles unless the owner explicitly asks.
- Evidence: capture URL, title, relevant text, screenshot when visual state matters, and downloaded file paths.

Recommended launch pattern when a shell is the available surface:

```bash
# Example shape; adapt to the installed agent-browser command in the environment.
agent-browser open --browser brave --url 'https://example.com'
agent-browser screenshot --browser brave --output /tmp/evidence.png
```

If only a browser tool is available, use that tool's native open/click/type/screenshot primitives rather than shelling out.

## Operating rules

- Before typing, identify the focused field and the expected site/domain.
- Before clicking destructive or account-changing controls, state the action and confirm when the owner has not pre-authorized it.
- For downloads, record the final path, file size if available, and source URL.
- For login/session issues, do not ask for passwords in chat. Ask the owner to complete the login/MFA in the visible browser.
- For blocked pages, collect the block text and browser/network evidence before trying a workaround.

## Evidence bundle

For final answers or handoff, include:

- source URL(s) and page title(s);
- timestamp or page date when visible;
- key quoted text or concise extracted fact;
- screenshot path for visual claims;
- downloaded artifact path and hash when a file matters;
- any unresolved manual step or account boundary.
