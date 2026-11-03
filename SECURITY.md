# Security policy

OfferFinch runs on your Mac and holds sensitive data: your resume and profile, job
applications, API keys (in the macOS Keychain) and signed-in browser sessions for job sites.
Please report security problems privately so they can be fixed before anyone can use them.

## Reporting a vulnerability

Use GitHub's private reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Only the maintainers can see the report.

Please do not open a public issue, discussion or pull request for a security problem.

Include, where you can:

- the OfferFinch version (OfferFinch › About OfferFinch) and macOS version;
- what an attacker could do, and what they need first (a malicious job posting, a page the
  app reads, local access, and so on);
- steps or a proof of concept. Use made-up personal data, never someone's real data.

This is a small project maintained in spare time. Reports are acknowledged as soon as
possible, usually within a week, and you will hear what happens next. Credit is given in the
release notes unless you would rather stay anonymous.

## Supported versions

Only the latest stable release gets security fixes. Official builds update themselves; if you
build from source, update to the latest `main`.

## In scope

- Personal data leaving the Mac other than as [privacy](docs/privacy.md) describes, or being
  written where it should not be (logs, diagnostics bundles, model CLI history).
- Text from a job posting or a web page that makes the app act on it: prompt injection that
  changes what is sent, submitted or saved, or that adds unapproved claims to documents.
- Anything that submits an application or sends data without your approval.
- Escapes from the app's site browser or renderer sandbox, and IPC that a page can reach.
- Access to API keys or site sign-ins by anything other than the app.
- Tampering with updates.

## Out of scope

- Problems that need an attacker who already controls your user account or your Mac.
- A job site's own security, or how a site responds to automated reading.
- Model output quality that is not a security problem; please open a normal issue.
