# Rin Changelog

## 0.2.0

- Startup changelog tracking keeps the existing single `lastChangelogVersion` value while comparing stable, beta, nightly, and build-metadata version strings correctly.
- Startup update checks now run in the background without blocking TUI input; git-channel probes use an asynchronous child process.

## 0.1.0

- Rin TUI update notices now use Rin release metadata and link to Rin release notes instead of Pi update feeds.
- `/changelog` now displays Rin-native release notes from `docs/release/CHANGELOG.md`.
- Beta, stable, and hotfix release workflows now verify that Rin changelog notes exist for the user-facing release version before publishing metadata.

## 0.0.0

- Start tracking Rin-native release notes under `docs/release/CHANGELOG.md`.
- Install and update now resolve release channels through `release-manifest.json`.
- Stable is the default channel and is intended to resolve through npm release metadata.
- Beta remains an explicit opt-in channel backed by GitHub release-train branches.
