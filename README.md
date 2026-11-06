# OfferFinch

OfferFinch is a local macOS app that finds matching jobs, scores fit, and prepares a CV,
cover letter, and answers when you choose **Prepare**. Review the documents and their
claims before approving. Jobs come from job-board search (Greenhouse, Lever, Ashby,
SmartRecruiters, Workable, Recruitee, Teamtailor, and Personio postings found through
DuckDuckGo and read from each board's public data), LinkedIn, Indeed, Glassdoor, remote-job
feeds, and web search. Every job is handed off for you to submit; nothing is sent without
approval.

The app runs in the menu bar, scans while the Mac is awake, and resumes durable work after
a crash. Closing its window keeps scans running; **Quit** stops the app. There are no
accounts or hosted services to deploy. The retired web product and its database migration
tool have been removed.

## Try it

On the first screen, **Try it with sample data** opens the app with a made-up profile and
eight sample jobs, scored and drafted by built-in test models: no AI connection, no keys,
no network. A strip at the bottom of every screen (and "Demo" in the menu bar) says the data
is not real. **Leave demo** deletes the sample data and returns to the first screen; your
real data, if any, is never opened while the demo runs.

## Run from source

Use macOS, Node 24, and the pnpm version in `package.json` (`pnpm@11.9.0`). Google Chrome
or a supported Chromium browser is needed for headless page reading and PDF export.

```sh
pnpm install
pnpm build
pnpm --filter @offerfinch/desktop start
```

For development, run `pnpm dev` to watch the build, then start the app in another terminal.
If dependencies are already cached, `pnpm install --offline` also works. CI installs with
`--frozen-lockfile --ignore-scripts` and then runs `pnpm rebuild better-sqlite3` so SQLite
loads in the unit tests.

Setup guides you through connecting models, importing a resume, reviewing profile records,
and choosing job preferences. Models run on AI plans you already have, never on API keys:
Claude Code, Codex (macOS only), OpenCode, and Gemini through Google's Antigravity (OfferFinch
downloads Google's pinned server and signs in to Google itself). Each step (finding matches,
drafting, checking drafts) can use any available model. OpenCode and Gemini are off on
Windows until they are proven there. Using a plan from a third-party app may not be allowed by
its provider's terms; you decide whether your use is ([decisions](docs/decisions.md),
"Model providers"). OpenCode runs on your own OpenCode login, and OfferFinch removes its call
records from OpenCode's database afterwards. Pay-per-use OpenCode models count toward the
spending limit. Plan pauses, spending limits, and site checks remain visible in the app;
resolve them through their existing prompts before work resumes.

Data lives locally under `~/Library/Application Support/OfferFinch/`: the SQLite database,
files, and migration backups. Logs are under `~/Library/Logs/OfferFinch/`.
Site sign-in uses the app's own browser sessions. Settings › Your data exports a backup (one
.zip, without site sign-ins) and restores one, on this Mac or another.
[Privacy](docs/privacy.md) says what is stored and what leaves the Mac, and to whom;
[uninstall](docs/uninstall.md) removes the app and all of its data. See
[the desktop system](docs/design/desktop/system.md) and [decisions](docs/decisions.md) for the
boundaries and product rules.

## Test and check

```sh
pnpm test
pnpm -r check-types
pnpm biome ci .
pnpm knip
pnpm --filter @offerfinch/core test:browser
E2E_FOREGROUND=0 pnpm --filter @offerfinch/desktop e2e
```

`pnpm test` runs core, SQLite, runner, local-LLM, and desktop unit suites. Browser safety
fixtures run separately from core unit tests, using headless system Chrome; set
`OFFERFINCH_CHROME` to another Chromium executable if needed. Local-LLM boundary tests use
synthetic homes and capture servers. The Codex boundary tests require the native Codex CLI 0.166.0 on `PATH` (the npm launcher
cannot run inside the sandbox). CI installs it in a temporary directory and resolves its
native path with `scripts/codex-test-path.mjs`; see the exact setup in
[CI](.github/workflows/ci.yml). No real model calls or subscription login are required.

Desktop e2e defaults to background mode: windows stay hidden, never take focus, and create
no Dock or menu-bar icon. It uses temporary data folders, fake models, and local fixture
boards. One foreground-only theme
case is skipped in this mode. Never point tests, measurements, or screenshots at real app
data. CI runs lint, types, Knip, the core, SQLite and runner unit tests and the browser safety
tests on Linux (the runner image's Google Chrome), and the local-LLM and desktop unit tests on
`macos-15`, the only ones that need it (`sandbox-exec`, diagnostics zips). Desktop e2e runs
locally and in the release workflow, in three shards.

`node scripts/check-public.mjs --images` scans tracked text and image text for personal data.
It is an optional local check, no longer run in CI; its accepted findings are recorded in
[cleanup verification](docs/cleanup-baseline.md).

## Build and release

```sh
pnpm --filter @offerfinch/desktop dist
pnpm --filter @offerfinch/desktop release patch --dry-run
```

`dist` builds arm64 and x64 macOS artifacts with local ad-hoc signing and no publishing.
These local builds do not update themselves. Official releases use the unchanged signing
and notarization workflow, then publish DMGs, update ZIPs, and the update manifest to
GitHub Releases. The release command without `--dry-run` bumps the version, commits, tags,
and pushes; configure signing and a remote first. See [releasing](docs/releasing.md).

Official builds check for updates at launch and periodically. **Restart to Update** appears
once a download is ready; the update also installs on a later quit.

For repeatable screenshots and measurements, first create a fabricated prepared fixture:

```sh
E2E_USER_DATA=/tmp/offerfinch-prepared E2E_FOREGROUND=0 \
  pnpm --filter @offerfinch/desktop e2e desktop.spec.ts
OFFERFINCH_SCREENSHOTS=/tmp/offerfinch-shots node apps/desktop/scripts/screenshots.mjs \
  apps/desktop/dist/mac-arm64/OfferFinch.app /tmp/offerfinch-prepared
node apps/desktop/scripts/measure.mjs \
  apps/desktop/dist/mac-arm64/OfferFinch.app /tmp/offerfinch-prepared
```

The screenshot script captures hidden renderers in light and dark modes. The measurement
script and its Electron comparison app in `apps/desktop/scripts/baseline` remain available;
performance history is in [desktop design notes](docs/design/desktop/README.md).

## Code layout

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/main` | Windows, menus, tray, IPC, Keychain, browser sessions, notifications, updates |
| `apps/desktop/src/preload` | Narrow Electron bridge exposed to the renderer |
| `apps/desktop/src/worker` | Utility-process app, SQLite wiring, model factories, oRPC routers, scheduling |
| `apps/desktop/src/renderer` | React/Vite interface, local design primitives and styles |
| `packages/core` | Job sources, filters, scoring, application flows, claims checks, approval and submission rules, PDF/Word export |
| `packages/db` | Drizzle SQLite repositories, schema, migrations, and conversion scripts |
| `packages/runner` | Durable queue, retries, steps, events, and crash recovery |
| `packages/local-llm` | Claude/Codex CLI adapters, isolation, status, and billing holds |
| `packages/config` | Shared TypeScript configuration |

[PLAN](docs/PLAN.md) tracks product scope and history. [Workflows](docs/workflows.md) describes
the local processes and application lifecycle. Browser inspection evidence remains in
[form inspection](docs/form-inspection.md); provider research remains in
[T3 provider research](docs/t3-provider-research.md).

## Contributing and license

Bug reports, ideas and pull requests are welcome: see [contributing](CONTRIBUTING.md). Report
security problems privately as [the security policy](SECURITY.md) describes. OfferFinch is
released under the [MIT License](LICENSE).
