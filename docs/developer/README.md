# Rin Developer Docs

These documents are for maintainers changing Rin itself. They describe source layout, validation, release operations, and technical boundaries. They are repository documentation only; the installer does not copy them into the agent's `docs/rin/` guidance set.

## Funding

Rin's public sponsorship link is <https://ko-fi.com/THE_cattail>. Keep sponsorship copy voluntary and maintenance-focused: it must not promise feature priority, paid private support, or access to secrets/account operations.

## Documentation boundaries

Use this decision table when adding or moving documentation:

| Audience or purpose                                      | Location                              | Rule                                                                                            |
| -------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| End-user install and usage                               | `README.md` plus `readme/README.*.md` | English is canonical; update translations in the same change when user-facing content changes.  |
| Installed agent runtime guidance                         | `docs/agent/`                         | Installer syncs this tree to `agentDir/docs/rin/`, replacing obsolete installed Rin agent docs. |
| Maintainer architecture, testing, and release operations | `docs/developer/`                     | Repository-only; not copied to installed agent docs.                                            |
| Product release-note metadata                            | `docs/release/CHANGELOG.md`           | Consumed by `/changelog` and the local release executor; separate from agent guidance.          |

Do not add planning documents, todo files, or ad-hoc AGENTS-style instruction files to replace the groups above.

## Topic map

- `architecture.md`: source layout, runtime layers, and major subsystem boundaries.
- `testing.md`: test bucket and validation rules.
- `pi-integration.md`: governed Rin/Pi adapter seams for private Pi imports, session host helpers, and TUI patches.
- `extensions.md`: Pi-compatible session extensions, Rin command metadata, and optional Chat platform contributions.
- `persistence-write-and-archive.md`: write-reduction invariants, transcript-index experiments, and full-fidelity chat archive tiers.
- `releasing.md`: current channel contract and operator workflow for publishing release trains.

## Maintainer rule of thumb

If a document tells an installed agent how to operate Rin, put it under `docs/agent/`. If it tells a contributor how to modify, test, or release Rin, put it under `docs/developer/`. If it is a user-facing onboarding or usage page, it belongs in the root README and matching translations instead of a new docs page.
