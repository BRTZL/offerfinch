# Verification and retained exceptions

## Reproduce the checks

Use the Node and pnpm versions in [README](../README.md). Local-LLM boundary tests need the
native Codex CLI version configured in [CI](../.github/workflows/ci.yml); they use synthetic
homes and capture servers, without a subscription login or real model calls.

```sh
pnpm test
pnpm -r check-types
pnpm biome ci .
pnpm lint:ci
pnpm knip
pnpm --filter @offerfinch/core test:browser
E2E_FOREGROUND=0 OFFERFINCH_TEST_BACKGROUND=1 pnpm --filter @offerfinch/desktop e2e
pnpm --filter @offerfinch/desktop dist
node scripts/check-public.mjs --images
```

Browser safety tests use headless Chrome. Desktop e2e uses hidden windows, temporary data,
no Dock icon, and no menu-bar tray; the foreground-only theme case is intentionally skipped.
Never point tests or measurement scripts at installed application data. Distribution builds
use ad-hoc signing and do not install or publish the app. GitHub Actions itself must be
verified separately from local checks.

## Retained exceptions

- Complex ordered checks and stateful UI functions retain function-level explanations.
  Their original control flow stays visible; helpers must not hide dependencies on later
  bindings. Protected submission, network, approval, and billing paths retain narrow
  complexity warnings instead of control-flow changes.
- Function-length warnings apply to production code, not tests, e2e, or scripts. Intentional
  claims and SQLite entry points/facades are exempt from barrel and wildcard-export rules.
  Other existing warnings are recorded per file, rule, and message in
  [the warning baseline](../scripts/biome-warnings.json). CI rejects unbudgeted diagnostics.
  After reviewing an intentional exception, update that baseline with
  `node scripts/check-biome-warnings.mjs --update` and review its diff.
- Knip preserves unused export/type contracts in the explicitly protected modules. The
  submission-host export has its own `@public` annotation instead of a whole-file ignore.
  Runner keeps `tsx` because its crash-test child process imports it. Production-only Knip
  analysis is deferred; full-workspace analysis includes the tests that use those contracts.
- SQLite repository facades retain the public API and forward to unchanged area methods
  with the same receiver and arguments, preserving transaction context. Schema/migrations,
  design-system rules, signing/publishing behavior, and the public checker remain protected.

The deleted Postgres suite required `TEST_DATABASE_URL` and was never part of the baseline
unit gate. SQLite single-writer and dashboard tests cover its corresponding persistence
cases; CLI browser safety and missing persistence cases were moved before their old homes
were removed. The unreachable ntfy transport's two tests were deleted with that transport;
LinkedIn stop-handling coverage remains.

## Accepted public-data baseline

The public-data gate permits no new finding, at most eight accepted baseline findings,
and no finding in a file touched or created by the change. Seven accepted findings remain:

- `apps/desktop/electron-builder.yml:88`: denylist term #11 in publish metadata.
- `docs/releasing.md:24,38,39,42,43`: denylist term #11.
- `packages/core/test/site-debug-dom.test.ts:55`: phone-number test input.

The checker exits nonzero for these known findings. Compare finding identities and touched
paths; do not weaken the checker or reveal the private denylist. Resolving these accepted
findings belongs to public-repository preparation.
