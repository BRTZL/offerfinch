# Application forms: what the three boards ask for

**Since 2026-11-09 all three submit automatically** (`decisions.md`, `docs/auto-apply-plan.md`), replacing the 2026-10-31 hand-off. This record of their forms is the reference for the applier and its local stand-ins; the forms are checked again on real postings before the first real submission (plan step 4), since they may have changed since 2026-10-30.

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
