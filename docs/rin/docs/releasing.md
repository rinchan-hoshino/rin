# Releasing Rin

This document describes the operator workflow for Rin's fixed-cadence release train.

## Preconditions

- keep `main` as the development source of truth
- configure the repository secret `NPM_TOKEN` so `publish-stable.yml` and `publish-hotfix.yml` can publish `@rinchanai20260422/rin`
- confirm the focused release validation set passes on `main`
- update `docs/rin/CHANGELOG.md` before a promotion if release notes changed
- keep stable/hotfix versioning aligned with the current policy: each regular stable release advances `minor + 1` and resets `patch` to `0`, while each hotfix advances the current stable line by `patch + 1`

## Channel contract

- stable: default install and update channel, published to npm with dist-tag `latest`
- beta: explicit opt-in only; `--beta` means the current weekly beta candidate
- nightly: explicit opt-in only; `--nightly` means the current nightly build pinned from `main`
- git: explicit opt-in only; `--git` means `main` and `--git <name>` resolves that branch or ref directly

## Cadence

The default cadence is:

- nightly: daily scheduled cut from `main`
- beta: weekly scheduled cut from `main`
- stable: weekly scheduled promotion of the previous beta candidate
- hotfix: manual patch release outside the fixed cadence

The stable workflow must promote the beta candidate's exact pinned ref.
It must not silently replace that ref with newer `main` content.

## Scheduled workflows

### Nightly

`publish-nightly.yml` runs on a daily schedule and can also be started manually.
It:

1. resolves the nightly source ref, defaulting to `main` HEAD
2. computes a nightly version as a prerelease of the next regular stable target
3. validates the focused release test set
4. updates `release-manifest.json -> nightly`
5. commits the manifest update back to `main`
6. refreshes `bootstrap`

### Beta

`publish-beta.yml` runs on a weekly schedule and can also be started manually.
It:

1. resolves the beta source ref, defaulting to `main` HEAD
2. computes the next regular stable target from the current stable version by advancing `minor + 1` and resetting `patch` to `0`
3. creates the weekly beta version for that promotion target
4. validates the focused release test set
5. updates `release-manifest.json -> beta`
6. commits the manifest update back to `main`
7. refreshes `bootstrap`

### Stable

`publish-stable.yml` runs on a weekly schedule and can also be started manually.
It:

1. reads the current beta candidate ref and version from `release-manifest.json`
2. computes the stable promotion version by stripping the beta suffix
3. if a rerun or earlier release already used that version, bumps to the next available patch version on that stable line
4. checks out the beta candidate ref in a detached worktree
5. validates that candidate with the focused release test set
6. sets the package version only inside the candidate worktree
7. publishes `@rinchanai20260422/rin` to npm using dist-tag `latest`
8. updates `release-manifest.json -> stable` with the promoted ref and beta provenance
9. tags the promoted candidate ref as `v<version>`
10. commits the manifest update back to `main`
11. refreshes `bootstrap`

### Hotfix

`publish-hotfix.yml` is manual only.
It expects an explicit `ref` and patch `version`.
Use it for urgent stable fixes outside the weekly train; the patch version should be the current stable line plus `patch + 1`.
It:

1. checks out the requested ref in a detached worktree
2. validates the candidate with the focused release test set
3. sets the requested patch version in the candidate worktree
4. publishes that patch to npm as `latest`
5. updates `release-manifest.json -> stable`
6. tags the hotfix ref as `v<version>`
7. refreshes `bootstrap`

After a hotfix, merge or cherry-pick the fix back to `main` and into any still-relevant train work before the next regular cycle.

## Bootstrap branch

`bootstrap` is generated output, not a development branch.

It should contain only:

- `install.sh`
- `update.sh`
- `scripts/bootstrap-entrypoint.sh`
- `release-manifest.json`
- `docs/rin/CHANGELOG.md`
- generated bootstrap `README.md`

To regenerate locally:

```bash
npm run release:bootstrap -- --output /path/to/bootstrap-worktree
```

## Local manifest maintenance

Stable:

```bash
node scripts/release/update-release-manifest.mjs \
  --channel stable \
  --version <x.y.z> \
  --ref <sha> \
  --from-beta-version <x.y.z-beta.yyyymmdd>
```

Beta:

```bash
node scripts/release/update-release-manifest.mjs \
  --channel beta \
  --version <x.y.z-beta.yyyymmdd> \
  --ref <sha> \
  --promotion-version <x.y.z>
```

Nightly:

```bash
node scripts/release/update-release-manifest.mjs \
  --channel nightly \
  --version <x.y.z-nightly.yyyymmdd+sha> \
  --ref <sha> \
  --branch main
```

## Validation set used by release workflows

The release workflows intentionally use the focused validation set that already covers the channel/bootstrap/install paths:

```bash
npm run build
npm run test:release
```

This keeps the focused release-path gate aligned with one package script and the canonical TypeScript test buckets.
