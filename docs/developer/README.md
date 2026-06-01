# Rin Developer Docs

These documents are for maintainers changing Rin itself. They describe source layout, validation, release operations, and technical boundaries. They are repository documentation only; the installer does not copy them into the agent's `docs/rin/` guidance set.

## Documentation boundaries

Use this decision table when adding or moving documentation:

| Audience or purpose                                           | Location                              | Rule                                                                                            |
| ------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| End-user install and usage                                    | `README.md` plus `readme/README.*.md` | English is canonical; update translations in the same change when user-facing content changes.  |
| Installed agent runtime guidance                              | `docs/agent/`                         | Installer syncs this tree to `agentDir/docs/rin/`, replacing obsolete installed Rin agent docs. |
| Maintainer architecture, testing, GUI, and release operations | `docs/developer/`                     | Repository-only; not copied to installed agent docs.                                            |
| Product release-note metadata                                 | `docs/release/CHANGELOG.md`           | Consumed by `/changelog` and release workflows; separate from agent guidance.                   |

Do not add planning documents, todo files, or ad-hoc AGENTS-style instruction files to replace the groups above.

## Topic map

- `architecture.md`: source layout, runtime layers, and major subsystem boundaries.
- `testing.md`: test bucket and validation rules.
- `gui.md`: GUI shell and installer implementation boundaries.
- `pi-integration.md`: governed Rin/Pi adapter seams for private Pi imports, session host helpers, and TUI patches.
- `release-trains.md`: stable, beta, nightly, git, and hotfix channel contract.
- `releasing.md`: operator workflow for publishing release trains.
- `first-stable-release-checklist.md`: first public stable release checklist.

## Maintainer rule of thumb

If a document tells an installed agent how to operate Rin, put it under `docs/agent/`. If it tells a contributor how to modify, test, or release Rin, put it under `docs/developer/`. If it is a user-facing onboarding or usage page, it belongs in the root README and matching translations instead of a new docs page.
