# OfferFinch: plan

> **Direction changed 2026-11-01:** this is now a local macOS desktop app, and the cloud deployment is dropped. "Desktop app" below supersedes the Stack, Orchestration and Accounts parts of this file. Older sections stay as history.

## Desktop app

- **Shell:** Electron, macOS first, downloaded from GitHub Releases. Signed with a Developer ID, notarized, and updated over the air from GitHub Releases (electron-updater).
- **Runs:** menu bar app that starts at login, keeps running with the window closed, scans hourly while the Mac is awake and catches up after sleep. Native notifications for new matches and anything needing the user.
- **UI:** React with Vite (replacing Next.js), keeping today's screens and design language.
- **Data:** a local SQLite file; one local user, no login or invites.
- **Jobs:** resumable job queue in SQLite, replacing Cloudflare Workflows and Cron, same flow bodies.
- **Browser:** headless browser on the user's computer, started only when needed and closed after.
- **AI:** per-role choice of API key (macOS Keychain) or subscription (Claude login; ChatGPT through the local Codex CLI if the safety spike passes).
- **Onboarding:** connect AI, import resume, set job rules, first scan.
- **Performance targets:** measured and reported: cold start, idle memory, and memory during a scan.
- **Removed:** Cloudflare, Alchemy, PlanetScale, Axiom, Better-Auth, invites, ntfy from the product.
- **Unchanged rules:** nothing goes out without approval; hand-off on Ashby, Greenhouse, Lever and LinkedIn; no bot-detection bypass; claims trace to the profile.
- **Public subscription login:** offered to users with a clear terms warning (user's decision, 2026-11-01: free, non-commercial, as T3 Code does).

**Cleanup status (2026-11-03):** the retired web/server/CLI, Postgres/auth/infra and
migration packages are removed. Desktop now owns its UI styles, routers and model factories.
Browser safety coverage lives in core; missing CLI persistence cases were ported to SQLite.
CI, Knip and stricter Biome checks guard the remaining workspaces. Large desktop, repository
and claims files are split without changing their protected behavior. See
[cleanup verification](cleanup-baseline.md) for counts, exceptions, and local build evidence.
No installed app data was migrated or changed by this cleanup.

**Historical build verification (2026-11-01):** built in `apps/desktop` with `packages/db`, `packages/runner` (decisions.md "Desktop app build"). Verified: core, store, runner and desktop tests; Playwright's Electron driver e2e with fake models (onboarding, first scan on fixture boards, notifications, a question, flagged lines, approval, hand-off and "I submitted this", kill -9 of the worker and of the app, the LinkedIn runner on a local stand-in, a Codex hold surviving a worker kill); the packaged arm64 app run from its DMG; one Claude subscription call from the packaged app (the isolation held; its answer hit a too-small output limit in the connection test, since raised). Not yet: signing and auto-update, a live Codex call from the app, the LinkedIn runner on LinkedIn itself, the release workflow on GitHub.

Finds matching jobs, prepares tailored applications, and applies after the user approves each one. Single user first, built so it can become a SaaS.

## Next: the product correction (2026-11-02)

The user tested the native redesign and corrected the product. Each item lands in small commits; status in the last report.

| | What | Done when |
|---|---|---|
| A | **Jobs from the whole internet.** The user never adds companies. Search queries come from the profile (titles, skills, location, work setup) and are editable as plain search preferences. Sources are pluggable providers in Settings › Sources, each with on/off, status and last result: job-board search (Ashby, Greenhouse and Lever postings at any company, found through web search and read from those boards' public data, no login), LinkedIn (the dedicated, signed-in Chrome profile, read-only, human pace, stops at any challenge), Indeed and Glassdoor (local browser, read-only, human pace, stops at a block or a login wall). No stealth or bot-detection bypass; hand-off always. Results are deduplicated by normalized company, title and URL; a company is data on the job. Cheap hard filters first, then batched scoring within the call budgets. **Tailoring is on demand:** scoring lists matches; Prepare on a job starts tailoring. States: found → filtered → scored → listed; Prepare → questions → review → approve → hand-off | Watchlist and company-seeded scans gone; providers tested on fixtures (no contact with LinkedIn, Indeed or Glassdoor; job-board search may use real public calls for a test profile); no automatic preparation |
| B | **No current role.** The setting, its UI, the `current_role` rule and the redraft switch go; tailoring picks the relevant experience | No reference left; claims tests green |
| C | **The profile in the database.** Structured records replace the Markdown files and `answers.md`: Experience, Projects, About you, Skills, Education, Extras, each fact with its source and date; answers become facts. Tailoring, fit scoring, claims evidence and the claim audit cite records. Resume import drafts records. A one-way import of the installed app's profile, with a backup, runs only when the user starts it. The Profile page has a view per section, Add in the header, add and edit in a dialog | Every claims test passes, with new tests for a claim citing a missing or edited record |
| D | **Home in one calm column:** what needs you, then new matches; little else. Scan now shows the next scan on hover | |
| E | **Inbox:** less crowding, an inspector that docks or overlays correctly at every width, sort and filter by score | Checked at 960 × 600 and 1440 × 900 |
| F | **Sidebar collapse** (⌘\), animated, remembered, title and restore button beside the traffic lights | |
| G | **One list layout** for Applied, Rejected and Questions: list and detail where there is a detail, one empty state and voice | |
| H | **Settings rebuilt:** Models as simple as T3 Code's provider settings (API key, Claude or Codex subscription, login state; one quiet line on vendor terms, no confirmation step; extra-usage and credit checks stay automatic); Spending shows cost per model and step, a monthly limit is optional and off; the subscription call budget sits under Advanced; Job search preferences replace Job filter; Notifications alerts when permission is missing; Your data shows what is stored | |
| I | **Native feel:** no text selection on app chrome, lists, labels and headers; selectable only in documents, postings and fields; default cursor; no drag ghosts | An e2e check |
| J | **Public-ready tree:** no real person's data anywhere (code, tests, fixtures, docs, screenshots, film assets), fabricated data only; personal rules become profile data. `scripts/check-public.mjs` (a denylist kept outside the repository, email and phone patterns, the text in images) runs in CI. History is not rewritten: the user will start a public repository from the cleaned tree after approval | `node scripts/check-public.mjs --images` passes |

**Status of A (2026-11-02):** built. Scans run providers (`core/pipeline/providers.ts`) and never the company watchlist; the Watchlist page, the company lookup and the onboarding step are gone (step 5 is Where to look). Job-board search finds Ashby, Greenhouse and Lever postings through DuckDuckGo's results pages, read in the app's own hidden tab (Brave Search and SearXNG until 2026-11-02), with at most 6 queries a scan built from Job search's titles or the profile's role titles; postings the app has are skipped before any board is read, and each company's public board is read once, keeping only the found postings. Settings › Sources: on or off, the last run's counts or problem. Tailoring is on demand: a scored match waits in Inbox › Matches until Prepare (a button only). One job across sources: search and a LinkedIn apply link to the same posting dedupe in either order. Verified: unit tests for URLs, queries, backends, the provider and the scan flow; e2e through a SearXNG stand-in; the board-reading half against real public boards (Greenhouse, Lever, Ashby) with a stubbed search result. Indeed and Glassdoor (2026-11-02): read in a visible Chrome window of their own (no sign-in), one page every 20 to 60 seconds, at most 8 pages a scan, off until the user turns them on in Sources; a sign-in wall, CAPTCHA, check, refusal, other host or missing selector stops the source until the user clears it, and a miss names its selector; jobs are always handed off. Tested on fabricated fixtures and local stand-ins only (core tests, e2e); no request was made to either site, so their selectors are unproven until the first real run. Real sites (2026-11-02): the readers were fixed against the live Indeed, Glassdoor, LinkedIn and DuckDuckGo pages (sanitized `real-*` fixtures). One real end-to-end run in a throwaway instance: LinkedIn read 4 pages and saved 3 new jobs; Indeed and Glassdoor read their search pages, then met Cloudflare's check (HTTP 403) on the job page; DuckDuckGo showed its bot check on the first query. Checks are now handed to the user in Watch live (they were taken for refusals); not yet seen live after that fix. Transient stops (layout, refusal, unexpected page) retry with backoff, checks and sign-ins still hold (docs/decisions.md).

**One search plan, LinkedIn in scans (2026-11-03):** sources have no settings of their own. One search plan, written daily by the drafting model from the profile and Job search (or from titles × places when no model can), with the user's own searches first, feeds every source in its own format; it is edited once in Settings › Job search. LinkedIn joins scans at most every 6 hours, 10 pages a day, reading Top job picks first (decisions.md, 2026-11-03).

**Site readers in the app (2026-11-02, phase 1):** LinkedIn, Indeed and Glassdoor are read in hidden tabs inside OfferFinch, each in its own session; Sign in and Watch live are sheets in the app; a check pauses the run for the user instead of stopping it (decisions.md "Site readers in hidden tabs inside the app"). Phase 2 moves careers pages and PDFs to the same engine and replaces the search settings.

**Status of C (2026-11-02):** built. Records live in `profile_records` (additive migration) and render to the files tailoring, fit scoring and the claims check read, one file per record keyed by its id (`experience/<id>.md`), so a citation names a record and an edit never moves it; About renders to `personal.md` and `summary.md`, skills to `skills.md`, answers stay facts in `answers.md`. A passed review is bound to what it cited: when a cited record is edited so the quote is gone, removed, or the answer confirming a flagged line is removed or edited, approval refuses, Check again is allowed and the review step checks the documents again in full (`core/tailor/stale.ts`; tests in `core/test/stale-citations.test.ts` and `db/test/profile-records.test.ts`). The employer rule is tested on a records-built profile (`core/test/records-employer.test.ts`). Resume import drafts records; the Profile page has a section per kind with add and edit in a sheet (e2e). A profile an earlier version kept as files is read as before until converted: in the app with Convert (database copied to `backups/` first) or by hand with `packages/db/scripts/convert-profile.ts` (refuses while the database is open, backs up, proves no line was lost, rolls back otherwise). Not run on the user's installed data.

## Public-ready

Fixtures use fabricated identities; accepted public-data findings are tracked in
[cleanup verification](cleanup-baseline.md) and must be resolved before publication.
Within the fixtures, every employer, project, school, place and person from the private profile is replaced in code, tests, fixtures and docs by a fabricated one; text in screenshots and design stills that named one is pixelated. Personal rules are profile data (a `**CV wording:**` line, Don't claim lists, "did not graduate" lines), and job rules default to no country.

- **Check:** `node scripts/check-public.mjs` (text) and `--images` (the text macOS Vision reads in every PNG, JPEG and TIFF, and in the films' frames, one every 2 s through ffmpeg; a file it cannot read fails the check). A local run fails without denylist terms; `--ci` runs the patterns alone with a warning, for CI without the secret. It reads a denylist kept outside the repository (`~/.config/offerfinch/public-denylist.txt`, or `PUBLIC_DENYLIST`; in CI a secret) and reports a match by the term's line number only. Email, phone and ntfy-topic patterns run without it.
- **Exceptions it allows:** fabricated addresses and numbers (example domains, the 555 range), URL credentials, placeholders, the lockfile's and vendored agent skills' third-party metadata (patterns only), and a line marked `public-ok` with its reason (a city in the place-name table).
- **Fixing an image:** `node scripts/redact-images.mjs <file …>` pixelates each line of text naming a listed term, in place.
- **History is not rewritten:** this repository stays private; a public one starts from the cleaned tree after the user approves it.

## Decisions (2026-10-30)

- **Scope (updated):** all phases, built to a working product the user runs for real. Only legal advice for the SaaS stays outside the build.
- **Filter:** right to work in Turkey only, sponsorship needed elsewhere. Keep remote-from-Turkey or global remote, plus hybrid or on-site in Turkey. Relocation roles are not kept by default; the setting is editable.
- **Watchlist:** discover companies from job boards, seeded from `applications/shortlist.md`; the user can remove any.
- **Daily application limit:** none; only approvals limit submissions.
- **LinkedIn:** read job searches from a local runner first. Add Easy Apply only after about a week with no account warnings.
- **Repo:** this one. It reads the profile from `my-profile/profile/` at first, and imports it into the database for the SaaS later.

## Rules that do not change

1. Nothing is submitted without the user's approval of that exact application.
2. Every claim in a CV, letter or form answer traces to the profile. Missing facts become questions, never guesses.
3. Hard requirements (location, work permit, languages) run before any tailoring.
4. CAPTCHA, security check or unknown form question: stop and hand over to the user. No bypassing and no hiding from bot detection.
5. No LinkedIn or job-site passwords stored. LinkedIn uses a logged-in Chrome profile on the user's machine.
6. Every record has a `user_id` from day one.

## Historical web stack (retired)

Scaffolded with Better-T-Stack (https://www.better-t-stack.dev/new), user's choice, 2026-10-30:

- **Web:** Next.js, deployed on Cloudflare. No mobile app for now.
- **Backend:** Hono on Cloudflare Workers, plus Cron Triggers, Queues and Workflows.
- **API:** oRPC.
- **Data:** PostgreSQL with Drizzle, hosted on PlanetScale; R2 for PDFs and screenshots.
- **Infrastructure:** Alchemy for everything.
- **Auth:** Better-Auth.
- **Payments:** none for now; internal use only.
- **Tooling:** pnpm, Biome, Lefthook, Skills addon.
- **Logs:** evlog with Axiom.
- **AI:** Claude to tailor, a second provider to check claims.
- **Browser:** Cloudflare's browser service (Browser Run / Browser Rendering, with Playwright) for scraping and form filling; the phase 3 tests confirm it works on each job board. A local Playwright runner is the fallback.
- **Notifications:** ntfy.

## Application states

`found -> rejected_by_filter | scored -> preparing -> needs_answers -> ready_for_review -> approved | rejected | expired -> applying -> applied | needs_human | failed`

After `applied`, the application's stage with the employer is tracked apart from these states (2026-11-03): Applied, Heard back, Interviewing (rounds), Offer, Rejected by the company, Withdrawn, Ghosted (automatic after 21 quiet days), with dated notes, a follow-up reminder after 7 quiet days and interviews saved as .ics files (decisions.md).

## Historical web orchestration (retired)

Two Cloudflare Workflows (user's design, 2026-10-30):

1. **`ScanWorkflow`**, started by the hourly cron: fetch each source as its own retryable step, deduplicate, save new jobs, and start one `ApplicationWorkflow` per new job only.
2. **`ApplicationWorkflow`**, one per new job: hard filter, fit score, prepare, claims check, pause for answers (`step.waitForEvent`), pause for approval, apply, record proof. A failed filter or low score ends the instance with the reason saved. Stops such as `needs_human` pause the same way.

Instance IDs derive from the job ID, so retries can't start a second one. Starts are batched to stay within Cloudflare's limits.

- Postgres stays the source of truth: every step writes the application state, and the dashboard reads Postgres, not the workflow.
- Dashboard actions commit to Postgres first, then send the event. Events must be safe to deliver twice.
- A wait that times out moves the application to an `expired` state, not a submit. Timeouts never approve anything.
- Workflow logic stays thin and calls `packages/core`, so it can be tested without Cloudflare.

## Phase 1: find and filter

- Ashby, Greenhouse and Lever adapters behind one `JobSource` interface, polling a company watchlist hourly.
- `ScrapeSource` adapter for job lists with no API: pull HTML through the browser service, extract jobs with per-site parsers or an LLM fallback, and feed the same pipeline. Respect robots.txt and rate limits; a block or challenge marks the source `needs_human`, never bypassed.
- Deduplicate by source, job ID and normalized URL.
- Hard-requirement filter, then a fit score against profile evidence.
- ntfy alert for strong matches.

**Done when:** a scan on real boards stores jobs without duplicates on the second run, and a Northbeam-style posting (Spanish, Europe residency) is rejected with a stated reason.

## Phase 2: prepare and review

- Port the `tailor-application` skill into a Workflow: notes, CV, letter, form answers, PDF export.
- Independent claims check. A failed claim blocks `ready_for_review`.
- Dashboard: inbox, posting beside documents, fit, gaps, edit, approve or reject, question inbox that writes answers back to the profile.

**Done when:** a real posting reaches `ready_for_review` with exported PDFs, and an invented claim planted in a test CV gets blocked.

**Status (2026-10-30):** built. Verified locally with fake models through the dashboard in Chromium (`pnpm --filter @offerfinch/cli e2e`, screenshots in `docs/screenshots/`). A real posting with real models has not been run yet.

## Phase 3: apply on approval

- Test first: open one real form on each of Ashby, Greenhouse and Lever and record fields, file upload and bot protection, without submitting.
- Fill from approved answers only, take a screenshot before and after submitting, and record proof.
- The first real submissions are watched by the user.
- **Changed (2026-10-31):** Ashby, Greenhouse and Lever are hand-off boards (decisions.md): after approval the dashboard shows the posting's apply link, every answer ready to copy and the approved PDFs, and "I submitted this" records `applied` with the day. Nothing is filled or submitted automatically on them; their mode is fixed in code (`packages/core/src/apply/modes.ts`). The applier stays for boards without invisible scoring and runs only in the fixture tests until one is confirmed.

**Done when:** an approved application is submitted to a real posting the user chose, with proof stored, and a form with an unknown question ends in `needs_human`.

**Status (2026-10-31):** the hand-off is built and verified through the dashboard (`pnpm --filter @offerfinch/cli e2e:apply`: approval goes straight to the hand-off, zero POSTs reach any fixture board with submissions on, "I submitted this" records the day). Codex's phase 3 review is fixed, each with a regression test: allowed hosts held through redirects, navigations and posts; preselected controls cleared or asked; complete claims coverage; prompt fields escaped and board labels kept out of evidence; confirmation only on the board's own page. **Done when** now reads: an approved application on a real posting the user chose is submitted by the user from the hand-off and recorded as applied.

## Cost control (2026-10-31)

Scans tailor every kept job, so every model call records its model, tokens and estimated cost per application (`llm_usage`; prices with their source in `packages/core/src/scoring/pricing.ts`), shown per application in the dashboard. A monthly spending cap, on by default at $20, pauses scoring and preparation before a call that would pass it; calls reserve their worst case under a per-user lock, so parallel workflows cannot overshoot together.

## Phase 4: LinkedIn

Local runner in a dedicated Chrome profile, at human pace with daily caps, only while the Mac is on. Feeds jobs into the same pipeline. Stops on any security check.

**Status (2026-10-31):** built, read only (README "LinkedIn runner"). `pnpm cli linkedin:run` reads saved searches in the runner's own Chrome profile (the user signs in by hand with `linkedin:login`), one visible page at a time with 20-60 s gaps, under a 15-page rolling daily cap; new jobs are deduped against every source and go to the hand-off (fixed in core). Any login wall, security check, CAPTCHA, warning, unexpected page or missing selector stops it, alerts by ntfy and blocks it until `linkedin:clear`. Verified against a local fixture only (`e2e:linkedin`); the selectors are unverified on live LinkedIn until the user's first run. Easy Apply is not built (PLAN: only after about a week with no account warnings).

## Phase 5: SaaS

Sign-up, profile onboarding (billing skipped for now), LinkedIn as a user-run browser extension, GDPR. Legal advice before launch, covering LinkedIn and automated applications.

**Status (2026-10-31):** accounts built, no billing (README "Accounts"): invite-only sign-up (or an allow-list), email verification and password reset through an email interface with no provider yet, onboarding from a pasted or uploaded resume with review before saving, editable dated facts, per-user everything with isolation tests over every API procedure and download, scans for every active user under their own cap, data export and account deletion. Not built: the LinkedIn browser extension (the runner stays a local CLI), an email provider, and legal review.

## Later: lower AI cost

Use the Anthropic and OpenAI batch APIs for background work such as fit scoring and first drafts (user's idea, 2026-10-30). Results can take hours, so keep normal calls for anything the user is waiting on, like resuming after an answer. Check current batch pricing and limits when building this.

## Later: first-pass decisions

Add OpenAI's Decisions API (`POST /v1/decisions`, user's choice, 2026-10-30) as a cheap gate between the hard filter and the fit score: does an unclear posting allow someone in Turkey, and is the role relevant enough to score? Probabilities below a threshold fall through to the full score; they don't reject the job. Written fit evidence, tailoring and the claims check stay on the current models. Posting text remains untrusted input. Check its status, schema and pricing in OpenAI's docs first, because secondary sources disagree on availability.

## Open questions

- Which boards, if any, can be submitted automatically? The three inspected ones score browsers invisibly and are hand-off by the user's decision (2026-10-31). A board without such scoring would need its own inspection and a code change to `apply/modes.ts`.
- Is $20 a month the right default cap? Chosen by the builder as a safe start; the user sets it in Settings.
