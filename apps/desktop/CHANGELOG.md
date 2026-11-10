# What's new in OfferFinch

<!--
Bundled with the app (electron-builder extraResources) and shown by What's new once after an
update, and from Settings › General › What's new. Write for the person using the app: what
changed for them, in plain words. Add to "Unreleased"; the release script renames it to the
version it tags (docs/releasing.md). Right after a release there is no "Unreleased": start one
at the top, above the newest version. Only what is merged into main belongs here.
-->

## 0.5.0 (2026-11-10)

- OfferFinch can send applications for you. Before you review a job it reads the application
  form, without sending anything, and the review shows "What will be sent": every field and the
  exact value. Once you approve, it fills only those values, clicks submit once and keeps a
  screenshot of every step as proof. It works on Ashby, Greenhouse, Lever, Workable, Recruitee,
  Teamtailor and Personio, and on employers' own forms, which end as "Sent — check your email"
  until you press Got the email. It is off until you turn it on in Settings › Applying, and each
  job site stays closed until you open it there. A CAPTCHA, a login, an emailed code or anything
  unclear stops the run and hands it to you in "What to do", with every answer ready to copy.
  A board can show its thank-you page and still drop an application it judged automated, so the
  employer's email is the real proof.
- A job in your Inbox counts as read as soon as you open it, so its blue dot goes away right
  away instead of after five seconds.
- Settings › Documents picks how exported CVs and cover letters look: a template (Classic, as
  before; Modern; or Compact, which fits more on a page), a font, an accent color for headings
  and rules, and A4 or US Letter paper, with a live preview. Every look keeps the one-column,
  real-text layout ATS parsers read. Word documents get the font, page size and accent too, and
  their headings are no longer Word's default blue. Documents already exported keep their look;
  the new one applies from the next export.
- Settings › Writing sets how your drafts read: a plain, formal or warm tone, a shorter or
  fuller cover letter (always 220 to 400 words), words never to use, and your own "always /
  never" guidance. It applies to new drafts, redrafts, the chat and the answer helper; facts
  still come only from your profile, and every draft is checked as before.
- Settings › General › Running has a scan interval (every 1, 3, 6, 12 or 24 hours) and quiet
  hours (off by default; 22:00–07:00 when turned on, in your Mac's time). In quiet hours no
  scheduled scan starts and notifications wait, then arrive together when quiet hours end. Scan
  now still works at any time. "Pause hourly scans" is now "Pause scans".

## 0.4.0 (2026-11-08)

- Each question on the Questions page opens with a suggested answer already written, made in
  the background as soon as the question appears. It is a finished answer you can save as it
  is: no [ brackets ] and no questions back. Where your profile doesn't say, it makes its best
  guess, and flags every guessed tool or number so you can check it.
- The Questions page is now a queue. Each question shows its suggested answers as numbered
  cards with the likeliest picked: press 1–4 to pick, E to edit the picked answer in place, and
  ⌘↩ to save it and open the next. 4 (or the last card) writes your own. Guessed words are
  underlined, the list groups questions by job and shows which have answers ready, and a bar on
  top counts how many are left.
- Help me remember is gone: the answer cards replace it.

## 0.3.2 (2026-11-07)

- Settings › Spending is gone: plans and free models cost nothing extra, so its dollar figures
  were almost always $0. This month's calls by model and by step are now at the bottom of
  Settings › Models. Dollars and the monthly limit show there only when a step uses a paid
  model (OpenCode pay-per-use) or a call this month was paid.

## 0.3.1 (2026-11-07)

- Claude no longer stops with "Subscription paused (extra_usage …): the Claude plan's usage
  could not be read". OfferFinch no longer checks whether a plan could pay for a call with
  extra usage or credits: that is your own setting with each provider (Claude, ChatGPT,
  OpenCode). A plan still waits when its usage limit is reached.
- Codex no longer waits once a usage window passes 90%, and no plan stops after a paid call,
  so there is no Resume in Settings › Models any more.
- Not interested opens inside the bar at the bottom of a match: the bar grows into the form, and
  the rest of the app dims and blurs while you choose. Press Not interested again to confirm, or
  X, Esc or a click outside to cancel.
- Not Interested from a job's right-click menu in the Inbox sets it aside right away, with Undo
  in the message. It works the same on a company's line and on several selected jobs.
- In a narrow window, Fit details and Chat dim and blur the app behind them. A click outside
  closes them.

## 0.3.0 (2026-11-07)

- Job-board search finds jobs on five more boards: SmartRecruiters, Workable, Recruitee,
  Teamtailor and Personio, next to Greenhouse, Lever and Ashby. Links from these boards also
  work with Add job from link. As on every board, you apply yourself; nothing is sent for you.
- Each scan makes up to 10 searches instead of 6, so the eight boards are all covered.
- Settings › Sources shows how many postings each board found in the last run, and how many
  were new.
- The Inbox shows only jobs still in play: ones you rejected or marked Not interested move to
  the Rejected page, with your reasons (Not interested, the reasons you ticked, or Company
  hidden).
- A job being drafted shows a soft light passing across its row in the Inbox. It stays still
  when macOS's Reduce motion is on.
- Scan now moved from the foot of the sidebar to the top of the Scans page. It is still in the
  command menu, the app menu and the menu bar icon.

## 0.2.0 (2026-11-06)

- Choose any model for each step: finding matches, drafting and checking drafts. A new picker
  in Settings › Models lists every model from the AI plans you're signed in to, grouped by
  provider, with its effort levels. One model can do all three steps.
- OpenCode and Gemini join Claude and Codex. OpenCode uses your own OpenCode login; Gemini runs
  through Google's Antigravity, which OfferFinch installs and signs in to with your Google
  account. Both are macOS only for now.
- API keys are gone: OfferFinch runs only on your plans. Keys you stored are deleted from this
  computer on the first start (they stay valid at Anthropic and OpenAI until you revoke them).
  Steps that ran on a key get a model from what you're signed in to.
- Setup's Connect AI step shows what it found on this computer and needs at least one model to
  continue.

- Windows releases now download updates in the background and install when you restart or quit;
  not yet tried on a real Windows PC.

- No rule sets a job aside any more: every job a search finds gets a fit score. A job you
  can't take (it needs another citizenship, a security clearance, a work permit you don't
  have, or a language you don't work in) is scored below your minimum fit, and the reason says
  what blocks it.
- Settings › Job search has new preferences the fit score weighs: the level you want, kinds of
  role you want or don't, a minimum salary, company size or stage, and industries you prefer
  or avoid. Saving Job search applies to new jobs; jobs already in your Inbox keep their score.
- Claude and Codex plans now allow 500 model calls a day by default (was 40). Jobs found past
  the limit wait and are scored when there is room.
- First Windows builds (x64 and arm64 installers, not yet signed, an early
  preview). Backups, diagnostics, Chrome, Claude Code and notifications have Windows support,
  still to be tried on a real Windows PC; the ChatGPT plan through Codex stays macOS only,
  because it needs macOS's sandbox.
- Wording about stored data and API keys says "this computer" instead of naming the Mac.
- Settings › Spending lists each model once, by its name (Claude Sonnet 5.5, GPT-6.1 Sol), with
  how its calls were paid: your Claude plan, your ChatGPT plan or an API key. Calls on a plan
  say "Plan" instead of "$0".
- The Scan now button in the sidebar no longer spins while a scan runs; the scan's progress
  beside it shows how far it is.

## 0.1.6 (2026-11-05)

- OfferFinch checks for a new version every 30 minutes, and again when your Mac wakes or you
  come back to the window, instead of every 6 hours.
- A new version shows at the bottom of the sidebar: a ring while it downloads in the background,
  then a restart button with a green check. Click it to see what's new and restart.
- Setup's first search is live: every job it finds appears as it is read, the ones that break
  one of your rules show which rule and leave, and the rest get their fit score in place. When
  it is done, a line sums up how many were read, set aside and matched.
- Try OfferFinch before connecting anything: Try it with sample data, on the first screen,
  opens the app with a made-up profile and eight sample jobs. Matches, drafts and Applied all
  work, with no AI connection and nothing sent anywhere. Leave demo deletes the sample data and
  takes you back; your own data is never touched.
- The Inbox is one list of everything. Each job says where it stands (Match, Drafting, To
  review, Approved and so on), and a status menu beside the sort shows one kind at a time,
  with counts. Picking a status opens its first job, so the right side is never empty.
- Every job you haven't opened has a blue dot. It fades once the job has been open for about
  five seconds. Jobs already in your Inbox before this update count as read.
- Your choices now sit in a bar at the bottom of the job. On a match: Chat, Not interested and
  Interested (Interested drafts your CV and letter, as Prepare did). On a draft to review:
  Resolve, Chat, More, Reject and Approve. When Approve is off, the line under the bar says why.
- Under the job's title, a fit card shows the score, how many requirements you meet, what
  matches and what's missing. Click it for the details.
- The top of every page is the same: the page name, its count and the search. Scan now moved
  to the sidebar, next to when the last scan ran.
- Applied groups your applications by stage. Click a job's stage to move it to another one.
- Rejected filters by reason with a row of chips at the top of the list.
- Lists move smoothly when jobs come and go, unless Reduce motion is on in System Settings.

## 0.1.5 (2026-11-04)

- The job filter now keeps or rejects, nothing in between, and what it rejects is hidden
  everywhere. A remote job that names no place ("Remote") is kept and ranked lower; a city or
  region that may not hire from your country (such as EMEA or Europe for Turkey) is rejected.
  A time zone (CET, PST, "US time zones") is never a reason to reject a job.
- After this update, open matches, drafts waiting for answers and drafts in review are checked
  once more against the filter; the ones it rejects leave the Inbox.
- Jobs are filtered and scored as soon as a source finds them, while the scan goes on, so the
  first matches show up well before the scan ends.
- Plan calls are no longer held when their billing is unclear. Before each call OfferFinch
  still checks that extra usage is off (Claude) or that the plan has room (Codex). A call that
  ends unclearly now counts as a plan call, like in T3 Code. The "calls with unknown billing"
  section, with "Save what it cost" and "Not charged", is gone.
- If Claude or Codex really bills a call as extra usage or credits, that plan stops. Settings ›
  Models then says "Claude used paid extra usage on <date>. Calls are stopped." with Resume.
- Calls stuck as held by earlier versions are settled as plan calls when you update.
- Codex can now find matches and write drafts. A draft is still never checked by the company
  that wrote it: Claude drafts are checked by OpenAI, and Codex drafts by Claude. Settings ›
  Models greys out a choice that would break this and says why.

## 0.1.4 (2026-11-04)

- Settings › Models shows your plan's usage, as T3 Code does: for Claude Code and Codex, how
  much of each window (session, weekly) is used and left, when it resets, and how much of that
  OfferFinch itself used, with its calls and tokens in the window. Refresh reads both plans
  again without sending a prompt.

## 0.1.3 (2026-11-04)

- The welcome screen shows what OfferFinch does in a short demo of the Inbox: roles arrive from
  the job boards, each is scored against your CV, the ones that don't fit are set aside with
  the reason, and the one you pick is drafted and checked. You apply yourself; nothing is sent.
- While a scan runs, the sidebar and Home show how many sources are done and which one is
  being read.
- A "scan stopped" notification opens the scan history, where the fix is, instead of Models.
- "Skip titles with" takes C++, C# and .NET as words: before, C++ stopped new jobs from being
  checked at all.
- A scan that runs past the hour is no longer joined by the next hour's scan.
- Strong-match notifications follow the order of Matches: a job ranked lower (an unclear
  place, a company you passed on) no longer alerts on its raw score.

## 0.1.2 (2026-11-03)

- Setup is five short steps, finds Claude Code and Codex on your Mac and connects them for you,
  and tells you exactly what to run when one is missing.
- Worked at the same company twice? The CV check now ties each role to its own entry, so lines
  under your earlier role are no longer flagged against the later one's title and dates.

### Help with answers on Questions

- Help me remember on Questions turns a hard question into a few multiple-choice asks (which
  tools, yes or no, a rough size), with None of these, Not sure and a box for anything else. The
  options are reminders, never facts about you: only what you tick goes into your answer, and
  Improve then turns it into sentences. An option your profile already names is marked "in
  profile".
- Suggest and Improve always show their answer. A name or number that is in neither what you
  typed nor your profile (a tool the question asks about, say) is marked above it, so you can
  check it before you save, instead of the answer being hidden.
- Buttons keep their width while they work: a spinner shows in place instead of the label
  changing to "Saving…", and Suggest and Improve share one width.

### Easier to use

- A notification about one new match has Open and Not interested buttons (hover it and choose
  Options); one about several matches has Open. Nothing is prepared or sent from a notification.
- Finish later on the first setup screen now opens Home, instead of sending you straight back to
  setup.
- Home and an application's details no longer show costs; an application lists its model calls
  instead. Spending limits for API keys stay in Settings › Spending.

## 0.1.1 (2026-11-03)

### Help with answers on Questions

- Questions has Suggest (empty box: a draft from your profile, with [ blanks ] where it has
  nothing) and Improve (rewrites what you typed into a clear, complete answer). Each shows the
  change and what the answer still doesn't cover; Use this puts it in the box to edit. It only
  uses what you typed and what your profile already holds, and drops a suggestion that names a
  tool or number from anywhere else. Check it before you save; Save waits until every [ blank ] is
  filled in.

### Redraft

- Redraft… on a prepared application writes a new version of the CV, the letter, the answers or
  everything, with an optional instruction such as "shorter, mention my Go work". What you don't
  choose stays exactly as it is; the new version is checked before you can approve it, and an
  approved application goes back to review. Earlier versions stay readable from the version
  picker.

### One search plan for every source

- Sources no longer have settings of their own. One search plan, written each day from your
  profile and Job search, feeds every source. Edit it once, in Settings › Job search.
- LinkedIn joins your scans, at most every 3 hours and 30 pages a day, reading Top job picks
  first.
- Settings › Sources is calmer: each source shows whether it is on, its last result or what
  stopped it, and offers Sign in even while it is off.
- Each source picks up its next run where the last one ended in its searches.

### Prepare

- Select several matches in the Inbox and prepare them together from the selection summary.

### After you apply

- Track what happens after Applied: Heard back, Interviewing (with rounds), Offer, Rejected,
  Withdrawn. Each application shows its stages with dates and notes, and Applied can be
  filtered by stage.
- An application with no news for 21 days is marked Ghosted (you can undo it), and after 7 quiet
  days you get one reminder to follow up. Turn reminders off in Settings › Notifications.
- Keep private notes on any job. They are only for you and are never sent to an AI model.
- Add an interview to your calendar from its stage with "Add to Calendar".

### Closed postings

- Before Prepare, and when you open the hand-off, OfferFinch checks that the posting is still
  open. A closed one moves to the Inbox's Closed view and says why; "It's still open" brings it
  back.
- Each scan also re-checks a few older job-board matches nobody has acted on.
- LinkedIn, Indeed and Glassdoor postings older than 14 days carry a note to check the posting
  before applying.

### Your data

- Back up everything to one zip from Settings › Your data, and restore it on this Mac or
  another. API keys and site sign-ins are not in a backup: add them again after restoring on
  another Mac.
- Your data also explains what is stored on this Mac and what is sent, and how to uninstall
  OfferFinch.

### Easier to use

- Claims-check rules have plain names instead of codes.
- Help › Keyboard Shortcuts (⌘/) lists every shortcut in one sheet.
- Scrollbars float over the content, so nothing shifts or loses width when a list starts to
  scroll.
- Notifications chirp: OfferFinch has its own sound. Choose it, macOS's default or none in
  Settings › Notifications.
- CVs, letters, answers and postings read in dark mode when your Mac is dark.

### Help

- Help › Export Diagnostics… makes one zip of recent logs, versions and a settings summary,
  with names, emails, phone numbers, keys and tokens removed. You review every file before you
  save it, and nothing is sent anywhere: you share it yourself if you want to.
- What's new: this sheet, once after each update. Open it any time from Settings › General.

### Fixes and safety

- Release builds no longer include developer tools, and the web search tab cannot open
  connections a page asks for while it only reads.
- Web search checks every redirect before following it and never reaches addresses on your
  own network.
- OfferFinch no longer fails to start on databases that still had the old LinkedIn switch.
- Profile citations are no longer mistaken for phone numbers, which made the claims check fail
  to find its own quotes.
