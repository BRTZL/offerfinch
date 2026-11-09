# Application forms: what the three boards ask for

**Since 2026-11-09 all three submit automatically** (`decisions.md`, `docs/auto-apply-plan.md`), replacing the 2026-10-31 hand-off. This record of their forms is the reference for the applier and its local stand-ins; they were checked again on the same real postings on 2026-11-09 (plan step 4; "Live dry runs (2026-11-09)" below).

Inspected 2026-10-30 with local Playwright (`pnpm cli forms:inspect <url>`). Read-only: nothing was filled, clicked or uploaded, and every request except GET, HEAD and GraphQL queries was aborted in the browser before it left (`packages/core/src/apply/network-guard.ts`). Full-page screenshots: `screenshots/form-ashby.png`, `form-greenhouse.png`, `form-lever.png`.

| Board | Posting inspected | Form URL shape |
|---|---|---|
| Ashby | ClickHouse, Senior Cloud Software Engineer | `https://jobs.ashbyhq.com/<org>/<job id>/application` |
| Greenhouse | GitLab, AI Transformation Owner | `https://job-boards.greenhouse.io/<token>/jobs/<id>` (form under the posting) |
| Lever | AppNation, Head of Development | `https://jobs.lever.co/<site>/<posting id>/apply` |

## Fields

**Ashby.** One React form; every field sits in `.ashby-application-form-field-entry` with a `label.ashby-application-form-question-title` (`for` = input id; required labels carry a `_required_*` class, inputs carry `required`).
- System fields: `_systemfield_name` (one full-name box), `_systemfield_email`, `phone`.
- Files: `#_systemfield_resume` (required), `cover_letter` (optional), plus an "autofill from resume" uploader. All are hidden `input[type=file]`; Playwright's `setInputFiles` works on them. Setting a file starts an upload (resume parsing) at once.
- Custom questions: `question_<id>` text inputs (LinkedIn, website), and a required Yes/No question rendered as two buttons (`.ashby-application-form-input-yesno-option`, `aria-pressed`) over a hidden checkbox.
- EEO survey (gender, race, veteran status) in a separate optional section, radio groups.
- Submit: `button.ashby-application-form-submit-button` ("Submit Application").

**Greenhouse** (new `job-boards` UI). Fields in `.field-wrapper`, label `for` the input, a `*` span in required labels, `aria-required="true"` on required inputs.
- System fields: `#first_name`, `#last_name`, `#email` (required), `#phone` with an intl-tel country picker, `#country` (react-select).
- Files: `#resume` (required, `.pdf,.doc,.docx,.txt,.rtf`, with an "Enter manually" text alternative), `#cover_letter` (optional).
- Custom questions: `question_<id>`. Selects are react-select comboboxes (`input[role=combobox]`, options appear after typing or opening). This posting: 9 custom questions, 4 required (employment restrictions, visa sponsorship, previously worked at GitLab, country of residence), all single-selects.
- EEO: gender, Hispanic/Latino, veteran status, disability as optional comboboxes.
- Submit: `button[type=submit]` "Submit application" inside `form.application--form`.
- The public API returns the same question list without a key: `GET https://boards-api.greenhouse.io/v1/boards/<token>/jobs/<id>?questions=true` (labels, `required`, field names and types, select values, compliance questions).

**Lever.** A plain `form#application-form` (multipart POST), rows in `li.application-question` with `.application-label` and a `✱` `.required` span.
- System fields: `name` (full name), `email`, `phone` (required here), `location` (required; an autocomplete that must resolve to a suggestion over the network), `org` (current company), `urls[LinkedIn]` (required here), `urls[Twitter]`, `urls[GitHub]`, `urls[Portfolio]`, `urls[Other]`.
- Files: one `input[name=resume]` (optional here; it is parsed on selection). No cover-letter upload. Some postings add an "Additional information" `comments` textarea; this one does not.
- Custom questions: cards `cards[<uuid>][fieldN]`, here three required checkbox groups (lives in Ankara, willing to relocate, how did you hear) and one optional textarea. The card's question definitions (text, type, required, options) are embedded as JSON in a hidden `cards[<uuid>][baseTemplate]` input.
- Consent checkbox `consent[marketing]` (optional).
- Submit: `button#btn-submit` (`type=button`; script-driven).

## Bot protection

| Board | Seen on the form | Visible challenge before submit |
|---|---|---|
| Ashby | reCAPTCHA Enterprise, `size=invisible` (anchor + bframe from `recaptcha.net`); Datadog RUM | No |
| Greenhouse | reCAPTCHA Enterprise, `size=invisible`, token field `g-recaptcha-response` | No |
| Lever | hCaptcha (invisible enclave frames, `visibility: hidden`), Cloudflare Bot Management script (`/cdn-cgi/challenge-platform/.../jsd/oneshot`), LinkedIn widget | No |

All three score the browser passively and decide at submit time. What they do with a headless browser that does not hide itself (a low score: silent rejection, a visible challenge, or an error) cannot be seen without a real submission, which this phase does not make.

**Assumption used by the applier (the user's call; see the open question in PLAN.md):** a stop means a challenge that needs a person: a visible challenge frame (reCAPTCHA `bframe`, hCaptcha challenge, Turnstile, a visible checkbox widget), a "Just a moment" interstitial, a block status, or a missing form. The mere presence of an invisible widget, its script or its `g-recaptcha-response` field is not a stop. The applier never touches, solves or hides from any of them. If invisible protection itself should count as "CAPTCHA, stop", automatic submission covers none of the three boards and every application ends in `needs_human` with the answers ready to copy.

Note: phase 1's `detectChallenge` treats `/cdn-cgi/challenge-platform/` as a challenge. That is right for scraping list pages but would stop every Lever form, so the applier uses its own visible-challenge check.

## Official submission APIs

| Board | Submit endpoint | Needs | Usable without employer access |
|---|---|---|---|
| Greenhouse | `POST https://boards-api.greenhouse.io/v1/boards/<token>/jobs/<id>` | Basic Auth with the employer's Job Board API key ("Any form posts should be proxied by your own servers") | No. Only the GET endpoints, including `?questions=true` for the form definition |
| Lever | `POST /v0/postings/<site>/<id>?key=…` | An API key "a Super Admin of your account can generate from your integrations settings page"; 2 POSTs/s limit | No. Published postings are public via GET; Lever recommends its hosted form |
| Ashby | `applicationForm.submit` | API key with the `candidatesWrite` permission, issued by an Ashby admin | No. The public posting API is read-only and links to the hosted `applyUrl` |

None of the submit APIs is open to a candidate. The only route without employer access is the hosted form in a browser, which is what the applier drives.

## Viability per board

| Board | Fill | Upload CV / letter | Custom questions | Submit |
|---|---|---|---|---|
| Ashby | Yes: plain inputs, stable class names | Yes / yes (hidden file inputs) | Text yes; Yes/No buttons yes | Unknown until the first watched submission (invisible reCAPTCHA Enterprise) |
| Greenhouse | Yes | Yes / yes | Text yes; react-select needs open + pick the exact option | Unknown until the first watched submission (invisible reCAPTCHA Enterprise) |
| Lever | Yes, except `location`, which needs the network to resolve | Yes / no slot (letter text goes into `comments` when the form has it, otherwise it is not sent) | Checkbox/radio groups and textareas yes | Unknown until the first watched submission (invisible hCaptcha + Cloudflare bot script) |

Filling looks viable on all three. Whether a submit is accepted depends on how each board scores a plain headless Chromium, and only a real, watched submission answers that. Until then the dashboard's handoff (posting link, every answer ready to copy, approved PDFs, "I submitted this myself") is the guaranteed path.

## Live dry runs (2026-10-30)

`pnpm cli forms:dry-run <url> --board <board>` on the same three postings, with made-up test data ("Dryrun Testperson", `dryrun@example.invalid`) and a dummy PDF; nothing from the profile. Required questions got placeholder answers (the first option) only so every control type was exercised. How nothing could be sent:

1. `dry_run` mode returns after the screenshot; the code path to the submit click is not reached.
2. While the page loads, only GET, HEAD and GraphQL queries pass (`readOnlyDecision`); POSTs, uploads and beacons are aborted.
3. After the form is read and before the first click or keystroke, the network closes completely, GETs included. Service workers are blocked and WebSockets closed for the whole session.
4. The page navigates to `about:blank` while the guard is still on, so unload beacons are aborted too; then the browser closes.

| Board | Result | Requests (non-GET allowed while loading) | Attempted after the close | Allowed after the close |
|---|---|---|---|---|
| Ashby | Filled 9 fields (both files attached in the page), 3 EEO questions left blank | 30 (2 GraphQL queries) | 10 | 0 |
| Greenhouse | Filled 11, including 4 required react-select questions; 7 optional left blank | 32 (none) | 6 | 0 |
| Lever | Stopped at "Current location": its suggestions come from a lookup that needs the network | 48 (none; 12 blocked while loading: hCaptcha, Cloudflare, LinkedIn) | 1 | 0 |

Screenshots: `screenshots/dry-run-live-ashby.png`, `dry-run-live-greenhouse.png`, `dry-run-live-lever.png`. Not confirmed: whether Greenhouse shows the attached file names (its upload rows look empty in the screenshot), and Lever's checkbox questions, which the run did not reach. In a real submission the network is open, so Lever's location lookup runs; a location with no exact or prefix suggestion stops in `needs_human`.

The runs found three gaps, fixed before this table: Ashby puts its EEO survey in a second form container, Greenhouse loads a locale bundle after `load` (its selects stay closed until it arrives), and react-select adds a hidden required input that is not a question.

## Live dry runs (2026-11-09, plan step 4)

`LIVE_FORM_URLS="<url> …" pnpm --filter @offerfinch/core test:live` (`packages/core/test/live/dry-run.test.ts`; a developer tool, skipped unless the variable is set, never in CI). Per posting: `readFormOnPage` in a read-only session held on the posting's host, `planFormFields` for a fabricated applicant (`dryrun.testperson@example.com`, `+1 555 010 0199`, location "Ankara", a CV PDF printed from fabricated HTML; required questions nothing answers get the first option as a placeholder), then a fresh page filled with the network closed before the first keystroke, as `dryRunApplication` does. Submit is never clicked. The test fails when any request but GET or HEAD left the browser (Ashby's form queries excepted, below) or when anything left after the close. Output, including the screenshots, goes to the gitignored `packages/core/tmp/live-forms/<board>-<date>/` (`schema.json`, `plan.json`, `network.json`, `requests.json`, `filled.png`); the screenshots stay out of git.

Postings, found through each board's public API (same postings as 2026-10-30, so every difference is drift):

| Board | Posting | Read | Filled | Blank | Left the browser | Refused |
|---|---|---|---|---|---|---|
| Ashby | `https://jobs.ashbyhq.com/clickhouse/db498a8c-c8d8-405b-b86a-0943a5122e7d/application` | 12 | 12 | 0 | GET 59, POST 4 (GraphQL queries while loading) | POST 15 |
| Greenhouse | `https://job-boards.greenhouse.io/gitlab/jobs/8638232002` | 18 | 15 | 3 optional | GET 52 | GET 5, POST 2 |
| Lever | `https://jobs.lever.co/appnation/5caf2a1d-95c3-47cb-870e-ec623f56922f/apply` | 16 | 11 (location not chosen: its suggestions need the network) | 5 optional | GET 70 | POST 25 |

Nothing left after the network closed on any board. Ashby renders no form without its two GraphQL `query` POSTs to `jobs.ashbyhq.com/api/non-user-graphql` (`ApiJobPosting`, `ApiOrganizationFromHostedJobsPageName`; a GET-only page shows nothing): the one exception, counted apart, and only on the form's host while loading.

**Ashby.** Changed: the EEO radio groups are now `fieldset.ashby-application-form-input-radio-group` with a `label.ashby-application-form-question-title`, outside any field entry (their labels read empty), and their control names start with a UUID that changes on every load (`<uuid>__systemfield_eeoc_gender`), so the schema read before review never matched at submit time and the reviewed "Decline" was never chosen. Fixed: the radio group is a container, and the schema key drops the per-load prefix. New: Ashby saves each value as it is typed (`ApiSetFormValue` mutations, 10 in this run) and asks for upload handles (`ApiCreateFileUploadHandle`) on file choice, all to `jobs.ashbyhq.com`; in a real submission the employer receives the values before the click. Hosts: `jobs.ashbyhq.com` (form), `cdn.ashbyprd.com`, `app.ashbyhq.com`, `fonts.googleapis.com`, `fonts.gstatic.com`, `www.gstatic.com`, `www.recaptcha.net`; `browser-intake-datadoghq.com` (Datadog RUM, POST, refused). Protection: invisible reCAPTCHA Enterprise from `www.recaptcha.net`, unchanged.

**Greenhouse.** Changed: a "Country" picker (react-select, `#country`, options like "United States +1") sits beside the phone, and the page sets it from the number's calling code as it is typed, which failed every fill check. Fixed: it is listed in review as the calling code ("+1") and checked after filling, not filled; a phone without a set-apart code ("+905…") leaves it blank. File rows show a pending upload in the screenshot (the upload to S3 was aborted), while the inputs hold the files. Hosts: `job-boards.greenhouse.io` (form), `email-address-validator.us.greenhouse.io` (gets the typed email in its URL), `grnhse-prod-jben-us-east-1.s3.amazonaws.com` (POST of each chosen file), `boards.greenhouse.io`, `my.greenhouse.io` (`/users/self`), `job-boards.cdn.greenhouse.io`, `s2-recruiting.cdn.greenhouse.io`, `www.gstatic.com`, `fonts.gstatic.com`, `www.recaptcha.net`. Protection: invisible reCAPTCHA Enterprise, unchanged.

**Lever.** Changed: none in the markup since 2026-10-30, but two old gaps showed. The location suggestions (`jobs.lever.co/js/retrieveLocations.js`) are plain `.dropdown-location` divs (no `role=option`), fetched with `GET /searchLocations?text=…` 500 ms after the last key and picked on mousedown; leaving the box without picking one empties it. The applier never found a suggestion, and when it did it took the first one that started with the text, which was not the value review listed. Fixed: only a suggestion that is exactly the reviewed text is picked; otherwise the run stops with the suggestions as the question's options, and an answer to that question wins over the profile's location from then on. The consent checkbox shares its name with a hidden input (it read as two options); groups are read by name and type. Hosts: `jobs.lever.co` (form; resume parsing `POST /parseResume`, the location lookup, Cloudflare's bot script under `/cdn-cgi/`), `cdn.lever.co`, `lever-client-logos.s3.us-west-2.amazonaws.com`, hCaptcha (`hcaptcha.com`, `js.`, `newassets.`, `api.`, `api2.hcaptcha.com`, and a random `<12 hex>.w.hcaptcha.com` per session), `www.googletagmanager.com`, `platform.linkedin.com`, `www.linkedin.com` (LinkedIn's widget POSTs a document at load). Protection: invisible hCaptcha (its `checksiteconfig` POSTs come from its own `newassets.hcaptcha.com` frame) and Cloudflare's bot script, unchanged.

### Hosts in a real submission

A real submission runs in an "allowlist" session. Until now every request to a host other than the form's was refused and stopped the run, scripts included, so none of the three boards' widgets or CDN files would load. The plan allows "the hosts the board is known to use (uploads, its scoring script)"; each board's config in `apply/forms.ts` now lists them:

- `formHosts`: the board's own hosts besides the form's that receive the application (Greenhouse's upload bucket and email check). Any method, like the allowed form hosts.
- `hosts`: asset and scoring hosts. GET and HEAD only, never the page's own navigation. A frame loaded from one of them (the scoring widget's) may also post to them with xhr or fetch, never as a document, so a form the page aims at the widget's frame does not pass. Redirects are checked against the same rule before they are followed.
- Every other host is refused quietly and the run goes on (analytics, error reports, LinkedIn's widget).
- On every host outside the destinations, these stop the run: the page's own navigation, an upload, or a request whose URL or body carries a filled value (as typed, URL-encoded, or a phone number's digits). This catches plain copies only; an encoded or hashed value would pass, so the widget rule stays narrow.
- Exact names only, except `*.w.hcaptcha.com` (one label, under a name hCaptcha owns); never a shared suffix like `amazonaws.com`.
- The list never turns a host on: the form's host still needs `SUBMIT_ALLOWED_HOSTS`, which the desktop leaves empty. Tests: `test/browser/board-hosts.test.ts`.

Not seen yet, so unknown until the first watched submission (plan step 8): reCAPTCHA's execute and reload POSTs (they happen at the click), where Ashby's upload handles point, and whether the boards accept a token scored this way.
