# Releasing OfferFinch

One workflow releases the macOS and Windows apps: `.github/workflows/desktop-release.yml` ("Release" in the
Actions tab). It runs only for a release, never on an ordinary push: CI runs
on pull requests (and on demand from the Actions tab).

A release publishes a GitHub Release in this repository with:

- `OfferFinch-<version>-arm64.dmg`, `OfferFinch-<version>-x64.dmg`: first install.
- `OfferFinch-<version>-arm64-mac.zip`, `OfferFinch-<version>-mac.zip` (x64), their `.blockmap`
  files and `latest-mac.yml`: what installed apps download to update themselves.

- Windows: `OfferFinch-<version>-setup.exe` (combined x64/arm64),
  `OfferFinch-<version>-x64-setup.exe`, `OfferFinch-<version>-arm64-setup.exe`,
  their `.blockmap` files, and `latest.yml` (`preview.yml` for previews; macOS uses
  `preview-mac.yml`). The combined installer is first in `files` and in `path`, so either
  architecture has a compatible fallback. electron-updater 6.8.11 prefers an architecture-named
  entry when available; separate installers allow smaller native downloads; all manifest references are uploaded and size-checked before publishing.

Windows builds are unsigned for now. SmartScreen may warn on first manual installation;
background updates run silently. Windows policy or antivirus can still block an unsigned
installer, so a warning-free update needs proof on a real PC. No `publisherName` is configured:
electron-updater skips Authenticode verification when it is absent (download hashes still apply).

To test Windows OTA, install an older **release-stamped preview** on a Windows PC, then publish a
newer preview through the normal release flow. Use Settings › General › Updates › Check Now;
verify background download, Restart to Update (silent install and relaunch), preserved data and
new version. Repeat with normal Quit after downloading, and with an active scan/Chrome/Claude
process to verify shutdown releases files. Check both x64 and arm64, and confirm a stable install
ignores previews. A local build or dry-run artifact cannot prove OTA: both lack the release stamp.

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
never see previews. An app running a preview (installed from a preview DMG or Windows installer) follows newer previews
only: electron-updater keeps a `-preview` version on the `preview` channel and skips stable
releases. To go back to stable, install the stable DMG or Windows installer over it (stable is newer than the previews
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

   The run works out the version, tests it and builds in the `release` environment (below). Only
   once the build is signed and notarized does it commit "Release
   X.Y.Z" to `main` (stable), push the tag with the release deploy key and publish. If anything
   fails before that, nothing is committed or tagged and the same version can be run again. If
   `main` moved while it ran, the push is refused and nothing is published: run it again.

   The tag push starts a second run, as any pushed tag does. It waits until the first run ends,
   finds the release already there and stops, green, with "vX.Y.Z is already released".

2. **The local script** (stable), from a clean `main`:

   ```sh
   pnpm --filter @offerfinch/desktop release patch --dry-run   # shows 0.1.0 -> 0.1.1, changes nothing
   pnpm --filter @offerfinch/desktop release patch             # bump, date the changelog, commit, tag v0.1.1, push
   gh run watch
   ```

   The pushed tag starts the workflow. A tag push is always a real release.

3. **A tag by hand.** `git tag -a v0.1.1-preview.1 -m "OfferFinch 0.1.1-preview.1" && git push
   origin v0.1.1-preview.1` releases a preview of the tagged commit. A stable tag must match
   `apps/desktop/package.json` (the script does that for you).

A run takes about ten minutes once its macOS runners start (the checks and the build run side
by side; the longest is the build at about six minutes, each e2e shard about four), plus however
long GitHub takes to hand out macOS runners, which has been anything from seconds to twenty
minutes. Only one release runs at a time and a running release is never cancelled. A second run waits; GitHub keeps only one waiting run, so a third replaces the
waiting one. Installed apps find a new
release within six hours, or soon after the computer wakes or the window comes forward (or at once with
Settings › General › Updates › Check Now). They download it in the background, and the sidebar's
update indicator turns into a restart button with the release's notes and **Restart now**.

## What a run does

1. **released** and **resolve**: a pushed tag whose release already exists (draft or published)
   ends the run here, green. Otherwise the channel, version, tag and notes
   (`scripts/release-plan.mjs`, tested by `scripts/release-plan.test.mjs`), and whether this is a
   dry run.
2. In parallel: **quality** (lint, types, knip, release plan tests) and **test**
   (the core, store and runner unit tests) on Linux; **test-mac** (the Codex boundary tests,
   which need `sandbox-exec`, and the desktop app's tests), **e2e** (the desktop suite in three
   shards, in the background, each failing test retried once) and **build** on macOS, plus **build-windows** on Windows. The e2e
   suite is reported, never required: it does not hold a release. Slow, uneven macOS runners
   failed it on timing rather than on the app, and each rerun cost a full release. A failure
   keeps its traces as the run's `e2e-results-N` artifacts and the notification says so.
3. **build**, in the `release` environment (the signing secrets); it fails at once if a
   signing secret is missing. arm64 and x64 on one macOS runner, signed with the Developer ID,
   notarized and verified (`codesign`, `spctl`, `stapler`), then a launch check: the packaged
   arm64 app opens in background test mode against a temporary data folder and must reach its
   setup screen. The files are kept as the run's `offerfinch-mac` artifact for 14 days. It does
   not wait for the checks: a failed check leaves the signed build as that artifact and nothing
   more.
   **build-windows** builds unsigned x64 and arm64 NSIS installers, verifies embedded GitHub
   updater configuration and every manifest reference, then launches the packaged x64 app in demo
   mode (`windows-smoke.spec.ts`). Its `offerfinch-windows` artifact is kept for 14 days.
4. **finalize** (the button only), once quality, test, test-mac and both builds have passed, in the
   `release-push` environment: commit and tag, pushed over SSH with the release deploy key.
5. **publish**: the GitHub Release, titled "OfferFinch X.Y.Z", with the resolved notes.
6. **notify**: one phone notification (ntfy) for success, failure or a finished dry run, with a
   warning line when e2e failed.

## Dry run

A run is a dry run only when the button's `dry_run` is ticked; a pushed tag never is one. A real
run with a signing secret missing fails with the missing names; it never turns into a dry run.

A dry run runs every check and builds both macOS arches **ad-hoc signed** (as `pnpm dist` does: not
notarized, without the release stamp, so it never updates itself), runs the launch check and keeps
the files as a run artifact. Windows builds both arches unsigned, also without the release stamp. It uses no environment, so it reads no signing secret and makes no
deployment. It commits, tags and publishes nothing; the run summary says
"Dry run: nothing published". The button runs a dry run from any branch:

```sh
gh workflow run desktop-release.yml --ref <branch> -f channel=preview -f dry_run=true
```

## One-time setup

Two environments (Settings › Environments) hold the release secrets, so only the jobs that need
them, on the refs allowed, can read them:

- **`release`**: the five signing secrets. Deployment branches and tags: `main` and `v*.*.*`.
  No required reviewer: the owner starts every release, so a second click would only repeat
  that decision. Add one (Settings › Environments › release) if others get write access. Only a
  real build runs in it; dry runs do not.
- **`release-push`**: `RELEASE_DEPLOY_KEY`. Deployment branches: `main` only. No reviewer. Only
  finalize runs in it.

Set an environment secret with `gh secret set <NAME> --env <environment> -R <owner>/offerfinch`
(it asks for the value, or reads it from standard input), or in Settings › Environments ›
the environment › Add environment secret. The two optional secrets stay at repository level
(`gh secret set <NAME> -R <owner>/offerfinch`).

| Secret | Where | What it is | Needed for |
|---|---|---|---|
| `MAC_CERT_P12_BASE64` | `release` | The Developer ID Application certificate with its private key, as a .p12, base64 encoded | signing |
| `MAC_CERT_PASSWORD` | `release` | The password the .p12 was exported with | signing |
| `APPLE_API_KEY_P8` | `release` | The contents of an App Store Connect API key's `.p8` file | notarization |
| `APPLE_API_KEY_ID` | `release` | That key's Key ID (10 characters) | notarization |
| `APPLE_API_ISSUER` | `release` | The Issuer ID (a UUID) of the team's API keys | notarization |
| `RELEASE_DEPLOY_KEY` | `release-push` | The private half of the release deploy key | the button's push |
| `NTFY_TOPIC` | repository | The ntfy topic name (the part after `ntfy.sh/`) for release notifications | optional: no notification without it |
| `PUBLIC_DENYLIST` | repository | The public check's denylist, one term per line | optional: the patterns still run without it |

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
   base64 -i cert.p12 | gh secret set MAC_CERT_P12_BASE64 --env release -R <owner>/offerfinch
   gh secret set MAC_CERT_PASSWORD --env release -R <owner>/offerfinch      # paste the export password
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
   gh secret set APPLE_API_KEY_P8 --env release -R <owner>/offerfinch < AuthKey_XXXXXXXXXX.p8
   gh secret set APPLE_API_KEY_ID --env release -R <owner>/offerfinch       # paste the Key ID
   gh secret set APPLE_API_ISSUER --env release -R <owner>/offerfinch       # paste the Issuer ID
   rm AuthKey_XXXXXXXXXX.p8
   ```

### 3. Release deploy key

The Release button pushes "Release X.Y.Z" and the tag with this key, not the workflow's token.
On a personal account GitHub Actions can't bypass a ruleset, but a deploy key can, so `main` can
require pull requests while the button still pushes to it.

1. Make a key pair with no passphrase, outside the repository:

   ```sh
   ssh-keygen -t ed25519 -N "" -C "offerfinch release" -f release_deploy_key
   ```

2. Settings › Deploy keys › **Add deploy key**: the contents of `release_deploy_key.pub`, **Allow
   write access** ticked.
3. Store the private half in `release-push`, then delete both files:

   ```sh
   gh secret set RELEASE_DEPLOY_KEY --env release-push -R <owner>/offerfinch < release_deploy_key
   rm release_deploy_key release_deploy_key.pub
   ```

4. Rulesets (Settings › Rules): add **Deploy keys** to the bypass list of the `main` ruleset and
   the `v*` tag ruleset.

A deploy-key push starts workflows (a token push does not), so the button's tag starts a second
run. That run ends green at once: the release already exists.

### 4. Notifications (optional)

```sh
gh secret set NTFY_TOPIC -R <owner>/offerfinch                # the topic name only, e.g. my-topic
```

### 5. Repository settings

- **Workflow permissions** (Settings › Actions › General): the default token is read-only. The
  workflow asks for `contents: write` only in `released` (seeing a draft release takes it) and
  `publish` (creating the release). No job's token commits or tags: finalize uses the deploy key.
- **Actions**: every action is pinned to a full commit SHA with its version in a comment
  (`uses: actions/checkout@<sha> # v7.0.1`); Dependabot updates the SHA and the comment together.
  Settings › Actions › General allows only GitHub-owned actions and `pnpm/action-setup`, and
  requires SHA pinning, so an unpinned or unknown action fails before it runs.
- **Rulesets** (Settings › Rules): `main` can't be force-pushed or deleted, and `v*` tags can't be
  moved or deleted once a release made them. With the release deploy key on each bypass list,
  `main` can also require pull requests and the `check` status, and creating `v*` tags can be
  restricted: the button's push still goes through.
- **Public repository**: installed apps can only read public releases (see above).

Every run without `dry_run` is a real release, and fails if a signing secret is missing. Run a dry
run first (above) to see the build pass.

### 6. Go-public checklist

Right after the repository is made public:

1. Settings › Actions › General › **Approval for running fork pull request workflows from
   contributors**: "Require approval for all external contributors".
2. Settings › Code security › **Private vulnerability reporting**: on (SECURITY.md points to it).
3. The **`release` environment** (One-time setup): deployment branches and tags `main` and
   `v*.*.*`, and the five signing secrets in it. Then delete the
   repository-level signing secrets: the build no longer reads them.
4. The **`release-push` environment** (deployment branch `main`) and the **release deploy key**
   (One-time setup, 3): write access, private key as `RELEASE_DEPLOY_KEY` in `release-push`,
   Deploy keys on the rulesets' bypass lists. Then require pull requests and the `check` status
   on `main`, and restrict creating `v*` tags.
5. Prove it with a release from the button: the run should push the tag and publish, and the tag's own run should end with "already released".
6. **`PUBLIC_DENYLIST`**: decide whether CI's public check gets the denylist as a secret (without
   it, CI runs only the generic patterns; the local check uses the full list).

## What can go wrong

- **"Tag vX.Y.Z does not match apps/desktop/package.json":** tag stable releases with the release
  script or the button, which bump `package.json` first.
- **"CHANGELOG.md has no notes":** write the release's notes under `## Unreleased` and merge them.
- **"Tag vX.Y.Z already exists":** that version was released; bump again.
- **"Not set in the release environment: …":** a real run found signing secrets missing. Set them
  in the `release` environment (One-time setup), or tick `dry_run` for a test build.
- **"RELEASE_DEPLOY_KEY is not set":** add the deploy key (One-time setup, 3). Nothing was pushed.
- **The push in finalize is refused:** `main` moved during the run, or a ruleset does not list
  Deploy keys as a bypass. Nothing was published; run it again (or see Repository settings).
- **"vX.Y.Z is already released":** not an error. The button pushed that tag and published it, so
  the tag's own run has nothing to do. If the button run failed after it pushed the tag, re-run
  its failed jobs; if no release (not even a draft) was made, the tag's run releases it instead.
- **A run waits with "Waiting for review":** someone added a required reviewer to the `release`
  environment; approve it on the run page › Review deployments, or remove the reviewer.
- **Notarization fails:** the log names the file; usually a native binary that is not signed.
  `codesign -dvv` on it shows the signature.
- **An installed app does not update:** Settings › General › Updates shows the error. Ad-hoc
  builds (from `pnpm dist` or a dry run) never update; a release must be newer than the installed
  version; the repository must be public.
- **Rolling back:** publish a newer version with the old code; apps never move to a lower version.
  A bad preview can be deleted from Releases; stable apps never saw it.
