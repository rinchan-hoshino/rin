# Releasing Rin

This document describes the operator workflow for Rin's fixed-cadence release train.

## Preconditions

- keep `main` as the development source of truth
- run the executor with Node `24.18.0` and authenticated `gh` access
- for stable or hotfix publishing, set `NPM_CONFIG_USERCONFIG` to a dedicated mode-`0600` npmjs config outside the repository; the executor requires `npm whoami` to resolve to `hoshinorin` before candidate validation
- confirm the focused release validation set passes on `main`
- update `docs/release/CHANGELOG.md` before beta, stable, or hotfix publishing; the local executor requires a `## <stable-version>` heading, at least one user-facing bullet, and a commit coverage block for the candidate range
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

The stable lane must promote the beta candidate's exact pinned ref.
It must not silently replace that ref with newer `main` content.

Rin's scheduler decides whether a lane should publish. The repository-owned local executor performs the selected release on the managed release host:

```bash
npm run release:local -- --channel nightly
npm run release:local -- --channel beta
npm run release:local -- --channel stable
npm run release:local -- --channel hotfix --ref <ref> --version <x.y.z>
```

Stable and hotfix perform the npm identity preflight because they publish to npm. Nightly and beta skip it because their current contracts publish GitHub bundles only.

Append `--no-publish` to run validation and bundle construction without tags, releases, npm publication, manifest commits, or bootstrap pushes.

## Local release lanes

### Nightly

The daily scheduler invokes `release:local -- --channel nightly` when a nightly is needed. It:

1. resolves the nightly source ref, defaulting to `main` HEAD
2. computes a nightly version as a prerelease of the next regular stable target
3. validates the focused release test set
4. builds the nightly `linux-x64` platform bundle with the managed Node runtime
5. tags the nightly source ref as `v<version>` and uploads the platform bundle to that prerelease GitHub release
6. updates `release-manifest.json -> nightly` with platform bundle asset metadata
7. commits the manifest update back to `main`
8. refreshes `bootstrap`

### Beta

The weekly beta decision invokes `release:local -- --channel beta` when a candidate is needed. It:

1. resolves the beta source ref, defaulting to `main` HEAD
2. computes the next regular stable target from the current stable version by advancing `minor + 1` and resetting `patch` to `0`
3. creates the weekly beta version for that promotion target
4. verifies `docs/release/CHANGELOG.md` contains the target promotion heading, release-note bullets, and commit coverage from the current stable ref to the beta source ref
5. validates the focused release test set
6. builds the beta `linux-x64` platform bundle with the managed Node runtime
7. tags the beta source ref as `v<version>` and uploads the platform bundle to that prerelease GitHub release
8. updates `release-manifest.json -> beta` with platform bundle asset metadata
9. commits the manifest update back to `main`
10. refreshes `bootstrap`

### Stable

The weekly stable decision invokes `release:local -- --channel stable` only for the already pinned candidate. It:

1. reads the current beta candidate ref and version from `release-manifest.json`
2. computes the stable promotion version by stripping the beta suffix
3. if a rerun or earlier release already used that version, bumps to the next available patch version on that stable line
4. checks out the beta candidate ref in a detached worktree
5. verifies the candidate `docs/release/CHANGELOG.md` contains the stable version heading, release-note bullets, and commit coverage from the previous stable ref to the beta candidate ref
6. validates that candidate with the focused release test set
7. sets the package version only inside the candidate worktree
8. builds the stable `linux-x64` platform bundle with the managed Node runtime
9. publishes `@hoshinorin/rin` to npm using dist-tag `latest`
10. tags the promoted candidate ref as `v<version>` and uploads the platform bundle to that GitHub release
11. updates `release-manifest.json -> stable` with the promoted ref, beta provenance, and platform bundle asset metadata

The stable release tag intentionally points at the promoted candidate ref. The later manifest commit is release metadata on `main`, not part of the tagged runtime source.

12. commits the manifest update back to `main`
13. refreshes `bootstrap`

### Hotfix

The hotfix lane is manual only and uses `release:local -- --channel hotfix --ref <ref> --version <version>`.
It expects an explicit `ref` and patch `version`.
Use it for urgent stable fixes outside the weekly train; the patch version should be the current stable line plus `patch + 1`.
It:

1. checks out the requested ref in a detached worktree
2. verifies the candidate `docs/release/CHANGELOG.md` contains the hotfix version heading, release-note bullets, and commit coverage from the current stable ref to the hotfix ref
3. validates the candidate with the focused release test set
4. sets the requested patch version in the candidate worktree
5. builds the hotfix `linux-x64` platform bundle with the managed Node runtime
6. publishes that patch to npm as `latest`
7. tags the hotfix ref as `v<version>` and uploads the platform bundle to that GitHub release
8. updates `release-manifest.json -> stable` with platform bundle asset metadata

The hotfix release tag intentionally points at the requested hotfix ref. The later manifest commit is release metadata on `main`, not part of the tagged runtime source.

9. refreshes `bootstrap`

After a hotfix, merge or cherry-pick the fix back to `main` and into any still-relevant train work before the next regular cycle.

## Platform runtime bundles

Stable, beta, nightly, and hotfix release executors publish a `linux-x64` platform bundle for their selected ref. The bundle contains the built app runtime (`dist`, production `node_modules`, `extensions`, `package.json`) plus a managed Node runtime under `runtime/node/current`. The POSIX bootstrap scripts and the installed updater prefer matching platform bundle metadata; when available, install/update can start the installer/updater with the bundled Node instead of requiring system Node/npm for the prepared runtime.

`release-manifest.json` stores the durable asset URL/checksum metadata under each channel's `assets[platform]`, and `release-assets.env` is a shell-friendly projection for the bootstrap branch. If no matching platform asset is present, bootstrap/update falls back to the legacy source/npm path. Source/git installs still publish a managed Node runtime for launcher and daemon consistency by preserving an existing managed runtime or provisioning the current installer Node into `runtime/node/current`. PowerShell bootstrap remains on the legacy source/npm preparation path until Windows platform bundles are added.

## Bootstrap branch

`bootstrap` is generated output, not a development branch.

It should contain only:

- `install.sh`
- `update.sh`
- `install.ps1`
- `update.ps1`
- `scripts/bootstrap-entrypoint.sh`
- `scripts/bootstrap-entrypoint.ps1`
- `release-manifest.json`
- generated `release-assets.env`
- `docs/release/CHANGELOG.md`
- generated bootstrap `README.md`

To regenerate locally:

```bash
npm run release:bootstrap -- --output /path/to/bootstrap-worktree
```

## Local manifest maintenance

Before publishing a beta, stable, or hotfix build, add the user-facing notes under `docs/release/CHANGELOG.md`. The target section must include visible bullets plus a source-only coverage block listing every non-release-metadata commit in the candidate range:

```markdown
## <x.y.z>

- User-facing release note.

<!-- rin-changelog-coverage
- <short-sha> <commit subject>
- <short-sha> <commit subject>
-->
```

Verify the target stable version against the same range the local executor will publish:

```bash
npx tsx scripts/release/verify-changelog.ts \
  --version <x.y.z> \
  --from-ref <previous-stable-ref> \
  --to-ref <candidate-ref>
```

Stable:

```bash
npx tsx scripts/release/update-release-manifest.ts \
  --channel stable \
  --version <x.y.z> \
  --ref <sha> \
  --from-beta-version <x.y.z-beta.yyyymmdd>
```

Beta:

```bash
npx tsx scripts/release/update-release-manifest.ts \
  --channel beta \
  --version <x.y.z-beta.yyyymmdd> \
  --ref <sha> \
  --promotion-version <x.y.z>
```

Nightly:

```bash
npx tsx scripts/release/update-release-manifest.ts \
  --channel nightly \
  --version <x.y.z-nightly.yyyymmdd+sha> \
  --ref <sha> \
  --branch main
```

## Validation set used by the local executor

Every lane runs the repository gate before constructing or publishing assets:

```bash
npm run format:check
npm run lint
npm run build
npm run test:release
npm audit --audit-level=high
```

Stable and hotfix run the same gate in the detached candidate worktree. A real publish also requires a clean, current `main`; metadata pushes retry after fetching and rebasing `origin/main`.
