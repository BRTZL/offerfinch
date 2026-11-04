# Privacy

OfferFinch runs on your Mac. It has no account, no server of its own and no telemetry. This
page says what it keeps on the Mac, what leaves it, and to whom. It is also in the app:
Settings › Your data › Privacy.

## What is stored on this Mac

Everything lives in `~/Library/Application Support/OfferFinch/`:

- **The database** (`offerfinch.sqlite`): your profile, answers and facts, job preferences, the
  jobs found and their scores, applications, drafted documents, review checks, chat messages,
  scan history, settings and the cost of each model call.
- **Files** (`files/`): profile files, documents and their PDFs and Word files, and submission
  screenshots.
- **Backups** (`backups/`): a copy of the database before each update changes its structure, and
  a full backup before each restore.
- **API keys** (`secrets.json`): encrypted with a key that macOS keeps in your Keychain. The
  plain key is never written to disk, a log or the app's window.
- **Site sign-ins**: LinkedIn, Indeed and Glassdoor sessions (cookies), each in its own browser
  session inside the app, like a browser profile. OfferFinch never stores your passwords: you
  sign in on the site's own page.
- **Notification settings, a few page snapshots** kept to diagnose a site that stopped reading
  (at most five, with emails and phone numbers blanked), and the app's caches.

Logs are in `~/Library/Logs/OfferFinch/`. Documents you open in another app are written to a
temporary folder first.

**Export backup** (Settings › Your data) saves the database and files as one .zip, to keep or to
restore on another Mac. API keys and site sign-ins are never in it. **Download everything** saves
the same data as one JSON file to read.

## What leaves this Mac, and to whom

### The model vendors you chose

Settings › Models sets who does each job, with an API key or through the Claude Code or Codex
app you have installed:

- **Finding matches and drafting** go to **Anthropic** (an Anthropic API key, or your Claude
  subscription through Claude Code).
  - Fit scoring: your profile and the job posting.
  - Drafting: your profile, the posting, the fit assessment and your answers, to write the CV,
    letter and answers.
  - Chat, importing a resume, the daily search plan and reading a posting page that has no job
    data: the profile, resume or page text that task needs.
- **Checking drafts** goes to **OpenAI** (an OpenAI API key, or your ChatGPT subscription through
  Codex): your profile and the drafted documents, to check every claim against your profile. It
  is always another company than the one that drafted.

Before anything is sent, your email address and phone number (and anything shaped like one) are
replaced with placeholders. Your name and the rest of your profile are sent as written. What the
vendor does with it is set by your agreement with them (their API terms, or your subscription's
terms); OfferFinch sends nothing to them that you did not set up.

**Subscriptions.** Using a Claude or ChatGPT subscription through Claude Code or Codex is opt-in
and never the default. Anthropic and OpenAI recommend API keys for programs like this one, and
their terms do not clearly allow it: personal use on your own Mac is not clearly allowed, and use
in a product for other people is not allowed. You decide whether your use is within their terms.
OfferFinch checks before each call that it cannot be billed as extra usage or credits, and pauses
if it could. Calls run with the apps' telemetry, tools and history turned off. Settings › Models
› Plan usage shows what each plan has used of its windows, as the vendor reports it, and
OfferFinch's share of that; the reads are the same sign-in checks the calls make, with no prompt,
and the result is stored on this Mac only.

### The job sites it reads

To find jobs, OfferFinch reads public pages, the way a browser does:

- **Job boards' public job lists** (Greenhouse, Lever, Ashby) for the companies it finds. Only the
  company's board name is sent.
- **DuckDuckGo** search pages, with search words built from your job titles and where you want
  to work (for example `senior frontend engineer remote "Germany"`).
- **LinkedIn, Indeed and Glassdoor**, if you turn them on and sign in: their job search pages,
  with the same titles and places, under your own sign-in. These pages also load the sites' own
  scripts and images, as they would in a browser.
- **Pages a web search found**, each read once after checking its site's `robots.txt`, and a job
  link you add.

OfferFinch only reads. It never submits an application, sends a message or fills a form on a
site; you apply yourself.

### App updates

Official builds check GitHub Releases for a new version at launch and every six hours, and
download it. GitHub sees your IP address and a random install ID the updater keeps
(`.updaterId`), which it uses to stage releases. Builds made from source never check.

### Nothing else

There is no analytics, crash reporting or telemetry, and no OfferFinch server. Links you open
(a job posting, a vendor's usage page) open in your own browser.

## Removing your data

Settings › Your data › **Erase everything** removes your profile, jobs, applications, documents,
files and settings from the app. To remove the app and every file, key and sign-in it keeps, see
the [uninstall guide](uninstall.md) (in the app: Settings › Your data › Uninstall OfferFinch).
