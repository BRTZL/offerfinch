# Auto-apply: plan (2026-11-09)

**User's decision (2026-11-09), replacing the hand-off decision of 2026-10-31:** every approved
application is submitted automatically with Playwright, on every board and on employers' own
web forms, with AI reading the form and filling it. Proof (screenshots, the confirmation, the
final URL) is attached to the application. The newer boards (SmartRecruiters, Workable,
Recruitee, Teamtailor, Personio) are in this work, not later. The first real submission is a
posting the user picks from the inbox and watches.

## What stays

- **Rule 1, sharpened:** the user approves the exact answers that will be sent. The form is read
  *before* review, so the review shows every field and value; approval covers that list. At
  submit time a field that was not in the approved list stops the run (`needs_human`), it is
  never answered on the fly.
- **Rule 2:** every value traces to the profile or the approved documents. A question the
  profile cannot answer becomes a question in the Questions page, as today.
- **Rule 4:** Playwright defaults, the user's own Chrome, no stealth, no fingerprint changes. A
  visible challenge (CAPTCHA frame, interstitial, block), a login or account wall, or an email
  code stops the run and hands it to the user. Invisible scoring widgets are not a stop.
- **Rule 5:** no passwords stored. A form that needs an account (Workday, Taleo, iCIMS logins) is
  a hand-off with every answer ready to copy.
- **One click, never retried:** after the submit click, anything but a confirmation is an
  unknown outcome; the run never clicks again (`submit.ts` claim, unchanged).
- **Network guard:** posts go only to the form's own hosts and the hosts the board is known to
  use (uploads, its scoring script), held through redirects (`network-guard.ts`, extended per
  board).

## Known risk

These boards score the browser invisibly at submit. A low score can mean a "thanks" page while
the application is quietly dropped. The confirmation page is recorded as proof, but it is not
proof of receipt. The app shows "Submitted (board confirmed)" and, later, "Received" only when
the employer's email arrives (needs a mail connection; out of scope here, noted below).

## Architecture

```
prepare ──► read form ──► draft field answers ──► claims check ──► review (every field shown)
                │                                                         │ approve
                └─ form schema saved per application                     ▼
                                       submit: open ► compare schema ► fill ► verify ► screenshot
                                               ► click once ► read outcome ► proof ► applied
                                               any stop ─────────────────────────► needs_human
```

- **Form reader** (`core/apply/read-form.ts`): opens the apply URL headless with posts blocked,
  walks every page of the form it can reach without submitting, and returns a schema: fields
  (label, type, required, options, page), file inputs, the submit control. Known boards use
  their deterministic config (`forms.ts`, plus Greenhouse's `?questions=true` API); any other
  site uses a generic DOM and accessibility-tree scan, with the model labelling ambiguous fields.
- **Answer drafter:** the drafting model maps each field to a profile fact, a contact detail,
  a file, or a question for the user. Each value carries its source record id, so the existing
  claims check covers it. EEO questions default to "decline to answer" when offered.
- **Fill engine:** deterministic actions from the approved plan (`FillAction`, extended with
  date, multi-step "next" and checkbox consent). For generic sites a control takes a reviewed
  field's value only by its key (name, stable id or label); the model labels unnamed controls
  and tells buttons apart, and never pairs or types anything. On a multi-step form the claim
  comes before the first "Next" (2026-11-09 review fixes). Each page is verified
  (`verifyFilled`) and screenshotted.
- **Outcome reader:** board-specific success checks for known boards; on generic sites the
  model reads the page after the click and answers confirmed / error shown / unclear. Unclear
  is `needs_human`, never a retry. Since the user's decision of 2026-11-09, an employer's own
  form is never marked applied from its page: after the one click it is "Sent — check your
  email" (`web_sent`), what the reader saw is kept in the proof as information, and the user's
  "Got the email" moves it to Applied. The boards keep their confirmations.
- **Proof:** before and after screenshots per page, filled values, final URL, confirmation text,
  time. Shown on the application's page (`application/submission.tsx`) and in Applied.
- **Pace:** one submission at a time, at least 60 s apart, and at most 3 per employer domain a
  day. Runs straight after approval, headless.

## Steps

| # | Step | Done when | Estimate |
|---|---|---|---|
| 1 | Record the decision (decisions.md, PLAN phase 3, open questions); `modes.ts` gains an `auto` path for every board and the generic web, behind one in-code table; hand-off stays for account-wall sites and Indeed/Glassdoor's own apply | modes tests and `e2e:apply` rewritten: auto on the boards, zero posts on hand-off sources | ~half a day |
| 2 | Form reader with schema storage (additive migration) for the three known boards; review shows "What will be sent" | Fixture boards: schema matches; review lists every field | Done 2026-11-09 |
| 3 | Answer drafter and claims coverage per field; unknown fields become Questions | A planted unanswerable field becomes a question, not a guess | Done 2026-11-09 |
| 4 | Dry runs on one real posting per known board (fill, screenshot, no click); fix selector drift since 2026-10-30 | Three screenshots of filled real forms | Done 2026-11-09 (`test:live`; drift and host list in form-inspection.md) |
| 5 | Inspect and add SmartRecruiters, Workable, Recruitee, Teamtailor, Personio (one fixture + config each) | Each fills its fixture and one real dry run | Done 2026-11-09: Workable, Recruitee, Teamtailor and Personio are auto; SmartRecruiters stays hand-off (DataDome CAPTCHA before the form) |
| 6 | Generic web form path: AI field matching over the plan, multi-page, outcome reader | Three fixture sites (single page, multi-step, with an unknown field) pass; one real employer form dry-runs | Done 2026-11-09 on fixtures (single page, two-step, unknown field, login wall, code, ambiguous and stay-on-page confirmations, upload and frame on another site); the board is also read from a job's apply link (`form-target.ts`). No real employer form dry-run yet (`test:live` reads board URLs only). Decisions in decisions.md. The outcome reader is evidence only since 2026-11-09: an employer's form ends "Sent — check your email" after its click |
| 7 | Proof on the application page and in Applied; stop sheet with "finish it yourself" (opens the form in a visible window, answers ready to copy) | e2e: proof visible after a fixture submission; a fixture challenge ends in the sheet | Done 2026-11-09 on fixtures (`apps/desktop/e2e/apply-proof.spec.ts`): proof with every step's screenshots, the stop sheet with Finish it yourself, Read the form again, Approve held on an empty required field. Screenshots in docs/screenshots/desktop (apply-proof, stop-sheet). Decisions in decisions.md. Employer forms end "Sent — check your email" with Got the email (2026-11-09, `apps/desktop/e2e/web-sent.spec.ts`, docs/screenshots/desktop/web-sent.png) |
| 8 | First real submission: the user picks and watches one posting (a Greenhouse job, the user's choice); then one per board. Submissions start paused: the user turns them on in Settings › Applying (switch with a confirmation, 2026-11-09). Real job sites open one by one in the same page ("Real job sites", each closed by default, with its hosts and a confirmation naming its risks; 2026-11-09, decisions.md): a run opens only its own board's exact form host, and a closed board stops before any browser opens. Open Greenhouse before preparing the chosen job, so its form is read before review | Board confirmation stored, user confirms the email arrived | Prepared 2026-11-09 (per-board opening, on fixtures and stubs); the watched run depends on the user's pick |

Total: about 8 to 10 working days, unknown beyond that if real forms differ a lot from the
2026-10-30 inspection.

## Later, not in this work

- **LinkedIn Easy Apply:** the 2026-10-30 decision gates it on a week of runner use with no
  account warnings; LinkedIn restricts accounts that automate. LinkedIn jobs that link to an
  employer's form use the paths above.
- **Indeed and Glassdoor's own apply:** both sit behind Cloudflare challenges and logins; they
  stay hand-off. Their jobs that link to an employer form use the paths above.
- **Receipt check:** reading the employer's confirmation email needs a mail connection.
