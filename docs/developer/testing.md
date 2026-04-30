# Test suite rules

Use these rules when adding or changing repository tests.

## Bucket rules

- Put narrow deterministic coverage in `tests/unit`.
- Put cross-process or multi-component flows in `tests/e2e`.
- Put manual-terminal or pseudo-terminal smoke coverage in `tests/interactive`.
- Do not place new tests back in the repository root. Pick the right bucket instead.
- Retire obsolete root-level JavaScript tests instead of maintaining build-output-dependent shims.

## Design rules

- Write repository tests in TypeScript (`*.test.ts`).
- Keep `unit` tests fast, focused, and local to one behavior.
- Keep `e2e` tests isolated from the developer's real home, runtime, agent dir, sockets, and daemon state.
- Keep `interactive` tests opt-in by default and guarded by an explicit environment switch.
- Prefer disposable temp directories and explicit environment overrides over reusing real user state.
- Test the intended contract or failure boundary directly; do not depend on unrelated subsystems when a narrower harness is enough.

## Verification rules

- `npm run test:unit` is the default fast verification path.
- `npm run test:e2e` covers isolated end-to-end flows.
- `npm run test:interactive` is for explicit smoke runs only and should stay safe to skip in normal automation.

## Definition of done for new tests

A new test layout or helper is only acceptable when it keeps the suite structured, isolated, and easy to extend without polluting a contributor environment.
