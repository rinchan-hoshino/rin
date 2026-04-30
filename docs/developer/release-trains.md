# Release trains

Rin uses a four-channel release model.

## Channels

- stable: default for install and update, resolved from npm release metadata
- beta: explicit opt-in only, resolved from the current weekly beta candidate pinned in `release-manifest.json`
- nightly: explicit opt-in only, resolved from the current nightly candidate pinned in `release-manifest.json`
- git: explicit opt-in only, resolved directly from GitHub refs

## Source of truth

- `main`: ongoing development source of truth
- `release-manifest.json`: bootstrap source of truth for stable, beta, and nightly selection
- `bootstrap`: dedicated branch that only stores:
  - `install.sh`
  - `update.sh`
  - `install.ps1`
  - `update.ps1`
  - `scripts/bootstrap-entrypoint.sh`
  - `scripts/bootstrap-entrypoint.ps1`
  - `release-manifest.json`
  - `docs/release/CHANGELOG.md`

## User-facing rules

- stable install and update resolve through the published npm package by default; they do not fetch GitHub source archives
- `./install.sh`, `./install.ps1`, and `rin update` target stable by default
- `--beta` selects the current weekly beta candidate
- `--nightly` selects the current nightly build
- `--git` with no suffix means `main`
- `--git <name>` means that branch or ref directly
- `--branch` / `--version` remain supported as explicit selectors for direct stable/git resolution when needed
- `/changelog` and bootstrap changelog docs read Rin-native notes from `docs/release/CHANGELOG.md`; startup update checks use `release-manifest.json` and do not persist a separate last-seen version in settings

## Cadence

- nightly: every day from `main`
- beta: once per week from `main`
- stable: once per week by promoting the previous beta candidate
- hotfix: manual patch release outside the fixed cadence

## Versioning policy

- each regular stable release advances `minor + 1` and resets `patch` to `0`
- each hotfix advances the current stable line by `patch + 1`
- beta and nightly are prereleases of that next regular stable target

## Promotion rule

Stable is not rebuilt from a fresh weekly snapshot of `main`.
It is promoted from the previously cut beta candidate.
That means the stable workflow publishes the beta candidate's exact pinned ref, not a newer ref.

## Release manifest

`release-manifest.json` stores:

- stable npm metadata and the promoted source ref
- the current beta candidate version plus pinned source ref
- the current nightly version plus pinned source ref
- git default branch metadata
- train metadata such as the nightly source branch

## Automation

- `publish-nightly.yml`: scheduled daily nightly cut from `main`
- `publish-beta.yml`: scheduled weekly beta cut from `main`
- `publish-stable.yml`: scheduled weekly promotion of the current beta candidate to stable npm
- `publish-hotfix.yml`: manual patch release from an explicit ref
- `npm run release:changelog -- --version <x.y.z>`: verify `docs/release/CHANGELOG.md` contains the target user-facing release heading; beta, stable, and hotfix workflows run this before publishing or updating release metadata
- `npm run release:manifest -- --channel stable|beta|nightly ...`: local manifest maintenance helper
- `npm run release:bootstrap -- --output <dir>`: export the `bootstrap` payload
