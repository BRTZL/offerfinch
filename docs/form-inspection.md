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

- `formHosts`: the board's own hosts besides the form's that receive the application (Greenhouse's upload bucket, its email check, and `boards.greenhouse.io`, which hands out the upload's presigned fields). Any method, like the allowed form hosts.
- `hosts` (asset hosts) are decided by structure, not by looking for the applicant's data (Codex review, 2026-11-09, second round; `boardHostDecision` in `apply/network-guard.ts`, the per-board data in `apply/host-rules.ts`): only scripts, styles, fonts, images and media, by GET or HEAD, never xhr, fetch, a beacon, a ping or a frame, and with no query string unless every parameter is one the board was seen to use, with a value of the seen shape (a site key must be the board's own, `host` the form's own host, reCAPTCHA's `co` the form's own origin, a callback one of the names seen). An image whose query is not listed (Greenhouse's logo `?1651072661`, Teamtailor's resized images) does not load; that is cosmetic. `my.greenhouse.io/users/self` (an xhr) is refused quietly.
- Scoring widgets: exact frames and endpoints (`host/path`). reCAPTCHA Enterprise (Ashby, Greenhouse): frames `www.recaptcha.net/recaptcha/enterprise/anchor` and `…/bframe`, endpoints `…/reload` and `…/clr`. hCaptcha (Lever): frames `newassets.hcaptcha.com/captcha/v1/…`, endpoints `checksiteconfig`, `getcaptcha`, `checkcaptcha` on `hcaptcha.com`, `api.hcaptcha.com`, `api2.hcaptcha.com`. Turnstile (Workable, Personio): `challenges.cloudflare.com/cdn-cgi/challenge-platform/…`. An endpoint takes xhr or fetch (GET, POST) only from that widget's own frame: a frame whose own URL is under the widget's frame paths and carries the board's site key (Ashby `6LezdY0t…`, Greenhouse `6Lfmcbcp…`, Lever `e33f87f8-…`, from the one posting inspected each). A frame the page made (about:blank, srcdoc, blob:, data:), a frame loaded from another path, or one with another key never qualifies. Turnstile's keys for Workable and Personio and Recruitee's own hCaptcha were not recorded, so their widgets get no posts: their first real run will likely stop or end as an unknown outcome until the keys are added.
- What this does not guarantee: a widget endpoint receives whatever the board's own widget script sends it (the board's design; unavoidable short of blocking the widget), and a few listed parameter values stay free-form within their shape (reCAPTCHA's `v`, `cb` and `bft`, hCaptcha's `se`, Google Fonts' `family`), as does every asset path (CDN file names change with each release). Those reach only the widget's vendor under the board's key, or the board's own CDN. No other host and no other path receives anything.
- Every other request is refused quietly and the run goes on (analytics, error reports, LinkedIn's widget, any structural refusal).
- On every host outside the destinations, these stop the run (a second layer, checked first): the page's own navigation, an upload (a PUT, a multipart, PDF, Word or raw-bytes body, or a body holding a PDF), or a request whose URL or body carries a filled value, plain, URL-encoded (up to three times), JSON-escaped or base64-encoded. Values checked: an email, a phone number (as typed and its digits), a link's path (`/in/ada-example`, never the bare host), and any value of two words or more; single words ("LinkedIn", a city, a first name) are left out, since they are the boards' own option text and would match their URLs. A value split across requests or hashed passes this layer; the structural rules refuse those.
- Exact names only, except `*.w.hcaptcha.com` (one label, under a name hCaptcha owns); never a shared suffix like `amazonaws.com`.
- The list never turns a host on: the form's host still needs `SUBMIT_ALLOWED_HOSTS`, which the desktop leaves empty. Tests: `test/browser/board-hosts.test.ts`.

Submit endpoints: Lever posts the form to `jobs.lever.co`; Ashby's mutations go to `jobs.ashbyhq.com`; Greenhouse's form has a relative `action` (`/gitlab/jobs/8638232002`, on `job-boards.greenhouse.io`). Not seen yet, so unknown until the first watched submission (plan step 8): reCAPTCHA's execute and reload POSTs (they happen at the click), where Ashby's upload handles point (the URL comes from the `ApiCreateFileUploadHandle` answer; its bundle names no storage host), and whether the boards accept a token scored this way. An upload to a host not listed stops the run, so the first Ashby submission will stop there until its host is added.

## The newer boards (2026-11-09)

Inspected 2026-11-09 for plan step 5, read-only the same way: local headless Chrome, `read_only` network guard (only GET, HEAD and GraphQL queries left; every POST, beacon and upload was aborted), nothing typed, clicked or uploaded while the network was open. Postings were found through each source's public feed (`packages/core/src/sources`). Then one live dry run per filled board, the 2026-10-30 procedure: made-up data ("Dryrun Testperson", `dryrun@example.invalid`, a dummy PDF), the network closed completely before the first keystroke, `about:blank` before the browser closed. No POST was allowed in any run.

| Board | Posting inspected | Form URL shape | Mode |
|---|---|---|---|
| Workable | Hugging Face, Open-Source Machine Learning Engineer, `https://apply.workable.com/huggingface/j/81B46579FE/apply/` | `https://apply.workable.com/<account>/j/<shortcode>/apply/` | auto |
| Recruitee | Channable, Technical Writer (`channable.recruitee.com/o/technical-writer-customer-education/c/new`); dry run on Vandebron, Marketing Project Manager | `https://<company>.recruitee.com/o/<slug>/c/new`, which redirects to the employer's careers domain (`jobs.channable.com`, `werkenbij.vandebron.nl`) | auto |
| Teamtailor | Polestar, Marketing & Events Intern, `https://polestar.teamtailor.com/jobs/8681158-marketing-events-intern/applications/new` | `https://<company>.teamtailor.com/jobs/<id>-<slug>/applications/new` | auto |
| Personio | tado, Team Lead Accounting, `https://tado.jobs.personio.de/job/2502124/apply` | `https://<company>.jobs.personio.de/job/<id>/apply` | auto |
| SmartRecruiters | SmartRecruiters, Senior / Lead Engineering Operations Manager, `jobs.smartrecruiters.com/oneclick-ui/company/smartrecruiters/publication/<uuid>` | `https://jobs.smartrecruiters.com/oneclick-ui/company/<company>/publication/<uuid>` | hand-off |

None of the five asked for an account, a login or an email code before the form. Each is one page; none is multi-step.

### Fields

**Workable.** One React form, `form[data-ui=application-form]`, with hashed class names. Text fields sit inside the `<label>` that wraps them; the question text is a `span[id$=_label]`, required ones start with a `*` and carry `required`. Optional ones add " (Optional)".
- System fields: `firstname`, `lastname`, `email` (required), `phone` (optional, a country picker that takes the "+90" of a typed number and keeps the national number in the box).
- Files: one required `input[type=file][data-ui=resume]` with no `name` and an id that changes on every load. Choosing a file uploads it at once (in the dry run, with the network closed, it showed "Something went wrong"), and the label turns into "Replace file". The cover letter is a `textarea[name=cover_letter]`, not an upload.
- Custom questions: `CA_<n>` (account-wide) and `QA_<n>` (this job): textareas, a select-like combobox, and Yes/No radios. The radios and the privacy checkbox `gdpr` are `aria-hidden` inputs inside drawn `[role=radio]` / `[role=checkbox]` controls, which take the click; the checkbox's asterisk is drawn in CSS.
- A cookie banner with a backdrop covers the whole form until it is answered (`[data-ui=cookie-consent-decline]`).
- Submit: `button[data-ui=apply-button]` "Submit application".

**Recruitee.** One React form, `form#offer-application-form`; labels `for` the input, a `*` span when required, inputs carry `required`. Ids end in radix ids (`:r7:`) that change per load; names are stable.
- System fields: `candidate.name`, `candidate.email`, `candidate.phone` (with a country picker). Labels follow the employer's language ("Volledige naam").
- Files: `candidate.cv` (required), `candidate.coverLetterFile` (optional, with "Write it here instead"). Some employers add a video question (Ziggeo recorder, several unnamed file inputs).
- Custom questions: `candidate.openQuestionAnswers.<id>.content` (text, radios) and `.flag` (Yes/No radios) under a `fieldset` legend; the radios are visually hidden behind their labels.
- Consent: `candidate.agreements.0.consent`, a required, visually hidden checkbox named by `aria-labelledby`.
- "All done!" and "You've already applied for this job" are in the page, hidden, before submit.
- Its own cookie dialog sits over the submit button until answered (`button[data-testid=agree-to-selected-cookies]`, necessary cookies only). Channable's careers site adds Cookiebot as a modal over the whole form.
- Submit: `button[type=submit]` "Send" (`data-testid=submit-application-form-button`).

**Teamtailor.** A Rails form, `form#job-application-form`, `POST /applications`. Questions in `div[id^=id_]` or a `fieldset`; labels read "First name*Required" (the word in a hidden span), inputs have no `required`.
- System fields: `candidate[first_name]`, `candidate[last_name]`, `candidate[email]`, `candidate[phone]` (intl-tel-input).
- Files: a Dropzone file input `#candidate_resume_remote_url` with no `name`; it uploads on selection (in the dry run: "TypeError: Failed to fetch") and posts the file's URL. Cover letter: a textarea.
- Custom questions: `candidate[answers_attributes][<n>][boolean|choice|text]`.
- Consent: `candidate[consent_given]` (required, label starts "Required."), plus optional future-jobs and SMS boxes; each has a hidden `0` twin with the same name.
- A "Log in" form (Teamtailor Connect) sits on the posting page; applying does not need it.
- Its cookie dialog covers the submit button until answered (`button[data-action*="common--cookies--alert#disableAll"]`, "Decline all non-necessary cookies").
- Submit: `input[type=submit][name=commit]`.

**Personio.** A React form, `form[class*=DynamicForm_formContainer]`; labels "Email* (required)", inputs have no `required`.
- System fields: `first_name`, `last_name` (under a "Name*" group), `email`, `phone`, `location` (plain text, no lookup).
- Files: `documents.cv` (required), `documents.other`, hidden behind "Add file". A chosen file moves into a list (`[role=listitem]`) and the input is emptied.
- Custom questions: `available_from`, `salary_expectations`, `custom_attribute_<n>`, all text.
- Submit: `button[type=submit]` "Submit Application" (dimmed until Turnstile has a token).

**SmartRecruiters.** The posting page loads, but its "I'm interested" form (`oneclick-ui`) answered headless Chrome with HTTP 403 and a full-page DataDome CAPTCHA frame (`geo.captcha-delivery.com`). The form itself was never seen.

### Bot protection

| Board | Seen | Visible challenge before submit |
|---|---|---|
| Workable | Cloudflare Turnstile script (`challenges.cloudflare.com`), no visible widget | No |
| Recruitee | Its own hCaptcha (enclave frame from `captcha-assets.recruiteecdn.com`, `visibility: hidden`) | No |
| Teamtailor | None; hidden `verify_token` and `ctoken` fields | No |
| Personio | Cloudflare Turnstile: a `cf-turnstile-response` field in a 0 px high box, its frame in a shadow root | No |
| SmartRecruiters | DataDome | **Yes**: 403 and a CAPTCHA instead of the form |

The visible-challenge check now also counts a Turnstile box that shows (wider than 100 px, taller than 30 px), since its frame is not in the document.

### Hosts each form needs

Besides the form's own host (which must be in `SUBMIT_ALLOWED_HOSTS`), a real submission's session may reach only these, from the read-only network logs; employer trackers (Google Tag Manager, Facebook, Reddit, LinkedIn, Sentry, Ziggeo) are never added:

| Board | Hosts |
|---|---|
| Workable | `challenges.cloudflare.com`, `dcvxs6ggqztsa.cloudfront.net`, `d2y4rc9q318ytb.cloudfront.net`, `workablehr.s3.amazonaws.com` |
| Recruitee | `careers.recruiteecdn.com`, `captcha-base.recruiteecdn.com`, `captcha-assets.recruiteecdn.com` |
| Teamtailor | `assets-aws.teamtailor-cdn.com`, `images.teamtailor-cdn.com`, `fonts.googleapis.com`, `fonts.gstatic.com` |
| Personio | `assets.cdn.personio.de`, `challenges.cloudflare.com` |

Teamtailor's list includes Google Fonts, which its careersite loads on every page; they are font GETs, not the board's own hosts. Any other request stops the run before the click. Expected stops, not fixed:
- **Recruitee, every real run today.** Both Recruitee pages also posted to Recruitee's own analytics (`careers-analytics.recruitee.com`) and to a Sentry ingest host while loading, besides the employers' trackers (Google Tag Manager, Facebook, Ziggeo). These are not form, upload or scoring hosts, so they are not listed, and an allowlist run stops when the page opens, before anything is filled. Whether to allow Recruitee's analytics host is the user's call. Its forms also redirect to the employer's domain, which must be in `SUBMIT_ALLOWED_HOSTS`.
- The hosts Workable and Teamtailor upload the CV to were not seen (uploads were blocked), so the first real run may stop there.

### Live dry runs (2026-11-09)

| Board | Result | Requests | POSTs allowed |
|---|---|---|---|
| Workable | Filled 14 fields (3 Yes/No radios and the privacy box through their drawn controls, the CV chosen); stopped on the CV upload's own error, which needs the network | 77 | 0 |
| Recruitee (Vandebron) | Filled 6, including the consent box through its label; dry run complete | 47 | 0 |
| Teamtailor | Filled 11, including 3 radio questions and the consent box; dry run complete | 46 | 0 |
| Personio | Filled 8 and attached the CV; dry run complete | 23 | 0 |

Screenshots: `screenshots/dry-run-live-workable.png`, `dry-run-live-teamtailor.png`, `dry-run-live-personio.png`, made-up data only. The Recruitee page shows employees in its header photo and is not saved; no screenshot of the inspection pages either.

What the runs found and fixed before this table: Workable's radios ignore a click on the input (the drawn control takes it), its cookie backdrop and Teamtailor's and Recruitee's cookie dialogs cover the form or the submit button (each board's own "decline" button is now clicked once before filling, and a covered submit button stops the run before the claim), Personio empties its file input, Workable relabels the CV input, and Recruitee and Personio label fields in the employer's language (contact fields are now matched by control name).

Not confirmed until a real, watched submission: each board's confirmation page (the success texts in `forms.ts` are strict guesses; anything else is an unknown outcome, never "applied"), and whether the uploads go to the listed hosts.

**Confirmation evidence (after the Codex review, 2026-11-09).** Workable's careers bundle renders its success as `div[data-ui=successful-submit]` ("Your application has been submitted successfully."); Recruitee's page carries `…-content-offer-application-success` and `…-content-offer-application-rate-limited` ("You've already applied") tab panels before submit. Only these count as a board's confirmation. Teamtailor's and Personio's were not found, so their submissions are recorded as unknown outcomes until a watched submission shows them. A rerun of the live dry runs after these fixes: Recruitee, Teamtailor and Personio complete; Workable fills everything (radios and consent through its drawn controls, phone read as "+90 …" from its picker) and stops only on its CV upload, as before. No POST was allowed.
