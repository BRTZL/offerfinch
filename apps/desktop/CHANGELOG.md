# What's new in OfferFinch

<!--
Bundled with the app (electron-builder extraResources) and shown by What's new once after an
update, and from Settings › General › What's new. Write for the person using the app: what
changed for them, in plain words. Add to "Unreleased"; the release script renames it to the
version it tags (docs/releasing.md). Right after a release there is no "Unreleased": start one
at the top, above the newest version. Only what is merged into main belongs here.
-->

## Unreleased

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
