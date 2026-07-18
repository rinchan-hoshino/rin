# Testing architecture

Rin uses separate permanent test layers for separate failure signals. A test belongs to exactly one layer; its directory declares what a failure means. Pre-restructure checks stay in an explicit characterization bucket until they are migrated rather than being mislabeled as unit or regression tests.

## Choose the test layer

| Directory                | Purpose                                                   | Allowed boundary                                                          |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `tests/unit`             | Prove one production module's public contract             | One catalogued module; deterministic local collaborators only             |
| `tests/regression`       | Preserve a concrete failure that escaped earlier coverage | The smallest reproduction that still demonstrates the original bug        |
| `tests/characterization` | Hold pre-restructure behavior checks during migration     | Historical checks only; no new tests                                      |
| `tests/integration`      | Prove several modules or adapters work together           | In-process or controlled cross-component chain                            |
| `tests/system`           | Exercise the built product as a user would                | Disposable HOME/Rin/runtime roots, container, process, or pseudo-terminal |
| `tests/architecture`     | Enforce repository and test-system structure              | Source, config, catalog, and policy inspection                            |

Support code belongs in `tests/support` and is not a test layer. `tests/characterization` is transitional debt, not a permanent target layer.

Use this decision order:

1. If one module can prove the behavior completely, write a unit test.
2. If a bug crossed a boundary or depended on a past failure shape, add a separate regression test.
3. If correctness depends on several modules cooperating, write an integration test.
4. If confidence requires the built CLI, daemon, installer, terminal, or user workflow, write a system test in a disposable environment.

TDD is a development method, not a permanent test category. Remove temporary red/green scaffolding after the change, or promote each useful check into exactly one layer above.

## Unit tests

A unit test must:

- map to one entry in `tests/unit/catalog.json`;
- exercise one production module through its public exports;
- cover success, boundary, and error behavior rather than implementation text;
- avoid subprocess, network, worker, and ambient `process` dependencies;
- meet the catalog's per-file line, function, and branch thresholds.

The architecture gate rejects unregistered unit files and unit tests that import process or network boundaries. A filesystem module may use a disposable temporary directory, but it must not use the developer's real home or Rin state.

Run:

```bash
npm run test:unit
npm run test:unit:coverage
```

## Regression tests

Regression tests exist only to preserve failures that unit coverage did not fully prevent. Keep the reproduction separate from module unit tests so later refactors can distinguish a broken module contract from a reintroduced historical failure.

Each regression file must be registered in `tests/regression/catalog.json` with its concrete escaped failure, issue or fixing commit. Keep one failure family per file. Broad feature matrices and migration-only behavior checks are rejected from this layer.

Run:

```bash
npm run test:regression
```

## Characterization migration

`tests/characterization` contains the old requirement-shaped checks that cannot honestly be called unit tests or concrete bug regressions. `tests/characterization/catalog.json` preserves their origin while they are migrated.

Do not add files or test cases to this bucket. Locked file and test-call inventories allow deletion but reject debt growth. When touching a characterized area:

1. extract module contracts into strict unit tests;
2. keep only concrete escaped failures as regression tests;
3. move cross-module behavior into integration tests;
4. delete the characterization file when all useful evidence has an honest owner.

Run the transitional checks with:

```bash
npm run test:characterization
```

## Integration tests

Integration tests cover high-dimensional links such as normalization → persistence → retrieval, scheduler → prompt context, or frontend → daemon protocol. Assert the shared outcome at the boundary instead of repeating every module's unit cases.

Integration tests must use controlled collaborators and may not read or modify the live installed Rin runtime.

Run:

```bash
npm run test:integration
```

## System and interactive sandbox tests

All repository test scripts launch Node with a generated HOME, temporary/XDG roots, an unreachable user D-Bus address, an environment allowlist, and poisoned outbound proxies. Direct Linux runs additionally enter a user-owned network namespace with loopback only; other platforms must use the networkless local-CI container rather than run without isolation. This protects live Rin state, user services, and external network state even when historical tests spread `process.env`; it does not set product behavior flags such as `RIN_OFFLINE` or `RIN_SKIP_VERSION_CHECK`. The shared TAP result wrapper rejects every skipped or todo test even when Node itself exits successfully. Use the npm scripts rather than invoking `node --test` directly.

System tests operate the built product while isolating user state. Use `tests/support/test-sandbox.ts` for temporary HOME, XDG, runtime, cache, and `RIN_DIR` roots. It builds an environment allowlist, enables Rin's real offline/version-check switches, removes provider and unrelated `RIN_*` state, and poisons host proxy routes. Installer and TUI flows use `tests/support/install-to-tui-harness.ts`, whose container has no network, a read-only repository mount, temporary writable filesystems, and no access to the installed Rin state.

The system harness uses the repository's prebuilt `rin-local-ci:latest` Linux image, which contains `npm ci` dependencies, curl, and `util-linux`. It runs with `--pull=never`, copies source without host `node_modules`, and fails when the runtime or image is unavailable rather than downloading or skipping. Build the image before a direct host run:

```bash
docker build -f .ci/local-ci/Dockerfile -t rin-local-ci:latest .
npm run test:system
```

Human-operable installer/TUI sandbox:

```bash
npm run test:manual:install-tui
npm run test:manual:install-tui:scripted
```

The manual command enters the same disposable product path used by automation. It must never install into the developer's real HOME or control the live daemon.

## Coverage ownership and policy

`tests/coverage-policy.json` owns every TypeScript production module. A source file missing from the policy fails the architecture gate; coverage cannot be improved by excluding a module. Every entry records exactly one `ownerSuite`: `unit`, `integration`, or `system`. Regression and characterization tests preserve evidence but can never satisfy a module's strict coverage gate.

Choose the owner by the behavior boundary, not by which existing test happens to execute the file:

- `unit`: one module's public contract is complete with deterministic local collaborators; a disposable filesystem is allowed;
- `integration`: correctness depends on several modules, an adapter protocol, or a controlled process boundary cooperating;
- `system`: confidence requires a built entrypoint or complete process/user lifecycle.

A strict unit-owned module also has exactly one entry in `tests/unit/catalog.json`. That test runs alone with only its module included in c8, so incidental execution by another test cannot satisfy its gate. Integration- and system-owned modules are measured only while their respective suite runs. The architecture verifier rejects transitional or evidence-only suites as owners, duplicate owners, wrong built paths, legacy fields, incomplete source inventories, and unit catalog mismatches.

Each module has one migration status:

- `strict`: its owner suite must meet at least 90% lines, 90% functions, and 85% branches for that file;
- `ratchet`: the pre-restructure combined-suite baseline remains the temporary floor until the test is rewritten under its correct owner. Lines and functions always enforce that floor. Branches allow at most 2.5 percentage points of V8 discovery drift when the covered branch count strictly increases. A pinned-container run may instead report at most 10 fewer total branches with at most the same covered-count reduction and a 0.05-point drop. Unchanged covered count never excuses an increased total.

`npm test` builds once, verifies every strict unit owner in isolation, verifies strict integration and system owners from only their suite, and runs the current architecture, unit, regression, integration, and system layers together to preserve remaining ratchets and non-owner behavior. Immutable characterization evidence is excluded from strict and combined coverage; run it only through the explicit characterization command or a release gate that names a still-current case. The networkless system container writes raw V8 coverage to an explicit writable handoff; the host remaps container paths into the owner report. Reports are written under `coverage/` and are not committed.

Ratchets are transitional debt, not the target. Migrate a module by first choosing its truthful owner, then writing requirement-shaped contracts at that layer. Existing characterization evidence remains immutable and must not be renamed, moved, or used as the permanent owner. Promote the module only after its isolated owner report reaches 90/90/85. Completion requires all production modules to be strict and no ratchets to remain.

## Bugfix workflow

For every bugfix:

1. reproduce the failure at the lowest layer that still demonstrates the real symptom;
2. add or improve the owning module's unit tests;
3. when the original bug required more than that unit boundary, keep a separate regression reproduction;
4. add or update an integration test when a cross-module invariant failed;
5. use a system sandbox when installation, startup, terminal, or user interaction was involved;
6. run focused commands first, then `npm test` before handoff.

Do not move a failing test into another layer merely to make a gate pass. Repair the test's semantic ownership or the production boundary it exposes.
