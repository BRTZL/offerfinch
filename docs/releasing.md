# Releasing OfferFinch

One workflow releases the macOS app: `.github/workflows/desktop-release.yml` ("Release" in the
Actions tab). It runs only for a release, never on an ordinary push: CI and the public check run
on pull requests (and on demand from the Actions tab).

A release publishes a GitHub Release in this repository with:

- `OfferFinch-<version>-arm64.dmg`, `OfferFinch-<version>-x64.dmg`: first install.
- `OfferFinch-<version>-arm64-mac.zip`, `OfferFinch-<version>-mac.zip` (x64), their `.blockmap`
  files and `latest-mac.yml`: what installed apps download to update themselves.

**The repository must be public** for installed apps to update: they read the releases without
credentials, and a private repository's releases return 404 to them.

## Stable and preview

| | Stable | Preview |
|---|---|---|
| Version | `X.Y.Z` | `X.Y.Z-preview.N`: the next patch after the current stable version, N the next free number |
| Tag | `vX.Y.Z` | `vX.Y.Z-preview.N` |
| GitHub Release | the latest release | a **prerelease**, never marked latest |
| Who updates to it | every installed app | only apps already running a preview |
| Changes `main` | yes: `package.json` and the dated changelog in a "Release X.Y.Z" commit | no: the tag marks the commit that was built |
| Notes | that version's section of `apps/desktop/CHANGELOG.md` (the release refuses an empty one) | "Unreleased" plus the commits since the last tag |

Installed stable apps ask GitHub for the *latest* release, which a prerelease never is, so they
never see previews. An app running a preview (installed from a preview DMG) follows newer previews
only: electron-updater keeps a `-preview` version on the `preview` channel and skips stable
releases. To go back to stable, install the stable DMG over it (stable is newer than the previews
before it, so nothing is lost). What's new in a preview shows the "Unreleased" notes it was built
with.

## Cut a release

Write what changed for users under `## Unreleased` in `apps/desktop/CHANGELOG.md` and merge it to
`main` first. A stable release turns that section into the version's (`## 0.1.1 (2026-11-03)`);
installed apps show it once after they update (What's new), from the copy bundled in the app.

Three ways, all ending in the same jobs:

1. **The Release button.** Actions › Release › Run workflow, on `main`. Pick `channel` (stable or
   preview), `bump` (patch, minor or major; ignored for previews) and `dry_run`. From a terminal:

   ```sh
   gh workflow run desktop-release.yml --ref main -f channel=stable -f bump=patch
   gh workflow run desktop-release.yml --ref main -f channel=preview
   gh run watch
   ```

   The run works out the version, tests and builds it, and only once the build is signed and
   notarized commits "Release X.Y.Z" to `main` (stable), pushes the tag and publishes. If
   anything fails before that, nothing is committed or tagged and the same version can be run
   again. If `main` moved while it ran, the push is refused and nothing is published: run it again.

2. **The local script** (stable), from a clean `main`:

   ```sh
   pnpm --filter @offerfinch/desktop release patch --dry-run   # shows 0.1.0 -> 0.1.1, changes nothing
   pnpm --filter @offerfinch/desktop release patch             # bump, date the changelog, commit, tag v0.1.1, push
   gh run watch
   ```

   The pushed tag starts the workflow.

3. **A tag by hand.** `git tag -a v0.1.1-preview.1 -m "OfferFinch 0.1.1-preview.1" && git push
   origin v0.1.1-preview.1` releases a preview of the tagged commit. A stable tag must match
   `apps/desktop/package.json` (the script does that for you).

How long a run takes is unknown until the first one (the end-to-end suite is the longest job;
it is capped at 75 minutes). Only one release runs at a time and a running release is never
cancelled. A second run waits; GitHub keeps only one waiting run, so a third replaces the
waiting one. Installed apps find a new
release within 6 hours (or at once with Settings › General › Updates › Check Now), download it in
the background and offer **Restart to Update**.

## What a run does

1. **resolve**: the channel, version, tag and notes (`scripts/release-plan.mjs`, tested by
   `scripts/release-plan.test.mjs`), and whether this is a dry run.
2. **quality** (lint, types, knip, release plan tests, public check), **test** (unit tests) and
   **e2e** (the whole desktop suite in the background, each failing test retried once), in
   parallel.
3. **build**: arm64 and x64 on one macOS runner, signed with the Developer ID, notarized and
   verified (`codesign`, `spctl`, `stapler`), then a launch check: the packaged arm64 app opens in
   background test mode against a temporary data folder and must reach its setup screen. The
   files are kept as the run's `offerfinch-mac` artifact for 14 days.
4. **finalize** (the button only): commit and tag, pushed with the workflow's token.
5. **publish**: the GitHub Release, titled "OfferFinch X.Y.Z", with the resolved notes.
6. **notify**: one phone notification (ntfy) for success, failure or a finished dry run.

## Dry run

A run is a dry run when `dry_run` is ticked, or when any of the five signing secrets below is
missing. It runs every check and builds both arches **ad-hoc signed** (as `pnpm dist` does: not
notarized, without the release stamp, so it never updates itself), runs the launch check and keeps
the files as a run artifact. It commits, tags and publishes nothing; the run summary says
"Dry run: nothing published". The button runs a dry run from any branch:

```sh
gh workflow run desktop-release.yml --ref <branch> -f channel=preview -f dry_run=true
```

## One-time setup

Repository secrets, set with `gh secret set <NAME> -R <owner>/offerfinch` (it asks for the value,
or reads it from standard input), or in Settings › Secrets and variables › Actions › New
repository secret.

| Secret | What it is | Needed for |
|---|---|---|
| `MAC_CERT_P12_BASE64` | The Developer ID Application certificate with its private key, as a .p12, base64 encoded | signing |
| `MAC_CERT_PASSWORD` | The password the .p12 was exported with | signing |
| `APPLE_API_KEY_P8` | The contents of an App Store Connect API key's `.p8` file | notarization |
| `APPLE_API_KEY_ID` | That key's Key ID (10 characters) | notarization |
| `APPLE_API_ISSUER` | The Issuer ID (a UUID) of the team's API keys | notarization |
| `NTFY_TOPIC` | The ntfy topic name (the part after `ntfy.sh/`) for release notifications | optional: no notification without it |
| `PUBLIC_DENYLIST` | The public check's denylist, one term per line | optional: the patterns still run without it |

The topic is a secret, not a line in the workflow, because anyone who reads a public repository
could otherwise post to it. Never put credentials or private data in a notification.

### 1. Developer ID Application certificate

Needs the Apple Developer Program membership's **Account Holder** role (only it can create
Developer ID certificates).

**With Xcode (simplest):**

1. Xcode › Settings › Accounts › add your Apple ID if it is not there, select the team ›
   **Manage Certificates…** › **+** › **Developer ID Application**. Xcode creates the private key
   in your login keychain and the certificate on developer.apple.com.

**Without Xcode:**

1. Keychain Access › Certificate Assistant › **Request a Certificate From a Certificate
   Authority…**: your email, a name, *Saved to disk*. This creates the private key in your login
   keychain and a `CertificateSigningRequest.certSigningRequest` file.
2. developer.apple.com › Account › Certificates, IDs & Profiles › Certificates › **+** ›
   **Developer ID Application** › Profile Type **G2 Sub-CA** › upload the request › Download.
3. Double-click the downloaded `developerID_application.cer` to add it to the login keychain.

**Then export it (both ways):**

1. Keychain Access › login › **My Certificates** › "Developer ID Application: <name> (<team id>)".
   Expand it: the private key must be under it, or the export is useless (make the certificate on
   the Mac that has the key).
2. Right-click the certificate › **Export…** › format **Personal Information Exchange (.p12)** ›
   save as `cert.p12` › set a strong password.
3. Set both secrets, then delete the file:

   ```sh
   base64 -i cert.p12 | gh secret set MAC_CERT_P12_BASE64 -R <owner>/offerfinch
   gh secret set MAC_CERT_PASSWORD -R <owner>/offerfinch      # paste the export password
   rm cert.p12
   ```

Check it signs: `security find-identity -v -p codesigning` lists "Developer ID Application: …".

### 2. App Store Connect API key (notarization)

1. appstoreconnect.apple.com › **Users and Access** › **Integrations** › **App Store Connect
   API** › **Team Keys**. The first time, request access (Account Holder) and accept.
2. **+** (Generate API Key): a name such as "OfferFinch notarization", access **Developer** ›
   Generate.
3. Note the **Issuer ID** shown above the keys list and the new key's **Key ID**.
4. **Download** the key: `AuthKey_<KEY ID>.p8`. Apple lets you download it only once.
5. Set the three secrets, then delete the file:

   ```sh
   gh secret set APPLE_API_KEY_P8 -R <owner>/offerfinch < AuthKey_XXXXXXXXXX.p8
   gh secret set APPLE_API_KEY_ID -R <owner>/offerfinch       # paste the Key ID
   gh secret set APPLE_API_ISSUER -R <owner>/offerfinch       # paste the Issuer ID
   rm AuthKey_XXXXXXXXXX.p8
   ```

### 3. Notifications (optional)

```sh
gh secret set NTFY_TOPIC -R <owner>/offerfinch                # the topic name only, e.g. my-topic
```

### 4. Repository settings

- **Workflow permissions** (Settings › Actions › General): the default token is read-only; the
  workflow asks for `contents: write` only in the jobs that commit, tag and publish.
- **Actions**: every action is pinned to a full commit SHA with its version in a comment
  (`uses: actions/checkout@<sha> # v7.0.1`); Dependabot updates the SHA and the comment together.
  Settings › Actions › General allows only GitHub-owned actions and `pnpm/action-setup`, and
  requires SHA pinning, so an unpinned or unknown action fails before it runs.
- **Rulesets** (Settings › Rules): `main` can't be force-pushed or deleted, and `v*` tags can't be
  moved or deleted once a release made them. Pull requests are not yet required on `main`: on a
  personal account GitHub Actions can't bypass a ruleset, so that rule would refuse the Release
  button's "Release X.Y.Z" commit. It comes with the release deploy key (go-public checklist).
- **Public repository**: installed apps can only read public releases (see above).

Once the five signing secrets are set, the next run is a real release. Run a dry run first
(above) to see the build pass.

### 5. Go-public checklist

Right after the repository is made public:

1. Settings › Actions › General › **Approval for running fork pull request workflows from
   contributors**: "Require approval for all external contributors".
2. Settings › Code security › **Private vulnerability reporting**: on (SECURITY.md points to it).
3. Signing secrets into a **`release` environment** (Settings › Environments): deployment
   branches and tags `main` and `v*` only, and the owner as required reviewer, so every release
   waits for an approval and no other branch's workflow can read them. The build job runs in that
   environment; then delete the repository-level signing secrets. Prove it with a preview release.
4. A **release deploy key** (write access, private key as a `release` environment secret) that the
   Release button pushes with, allowed to bypass the rulesets; then require pull requests and the
   `check` status on `main`, and restrict creating `v*` tags.
5. **`PUBLIC_DENYLIST`**: decide whether CI's public check gets the denylist as a secret (without
   it, CI runs only the generic patterns; the local check uses the full list).

## What can go wrong

- **"Tag vX.Y.Z does not match apps/desktop/package.json":** tag stable releases with the release
  script or the button, which bump `package.json` first.
- **"CHANGELOG.md has no notes":** write the release's notes under `## Unreleased` and merge them.
- **"Tag vX.Y.Z already exists":** that version was released; bump again.
- **The push in finalize is refused:** `main` moved during the run, or a branch rule blocks the
  workflow's token. Nothing was published; run it again (or see Repository settings).
- **Notarization fails:** the log names the file; usually a native binary that is not signed.
  `codesign -dvv` on it shows the signature.
- **An installed app does not update:** Settings › General › Updates shows the error. Ad-hoc
  builds (from `pnpm dist` or a dry run) never update; a release must be newer than the installed
  version; the repository must be public.
- **Rolling back:** publish a newer version with the old code; apps never move to a lower version.
  A bad preview can be deleted from Releases; stable apps never saw it.
