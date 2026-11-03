# Releasing OfferFinch

A release is a `v<version>` tag on `main`. `.github/workflows/desktop-release.yml` tests, builds
arm64 and x64, signs with the Developer ID, notarizes, and publishes a GitHub Release with:

- `OfferFinch-<version>-arm64.dmg`, `OfferFinch-<version>-x64.dmg`: first install.
- `OfferFinch-<version>-arm64-mac.zip`, `OfferFinch-<version>-mac.zip` (x64), their `.blockmap`
  files and `latest-mac.yml`: what installed apps download to update themselves.

## Cut a release

Write what changed for users under `## Unreleased` in `apps/desktop/CHANGELOG.md` first. The
release script renames that section to the new version and date; installed apps show it once
after they update (What's new), from the copy bundled in the app, so it works offline.

```sh
pnpm --filter @offerfinch/desktop release patch --dry-run   # preview: 0.1.0 -> 0.1.1
pnpm --filter @offerfinch/desktop release patch             # bump, commit, tag v0.1.1, push
gh run watch                                                # follow the build (about 20 min)
```

Installed apps find the release within 6 hours (or at once with Settings › General › Updates ›
Check Now), download it in the background and offer **Restart to Update**.

## One-time setup: signing and notarization

Needs a paid Apple Developer Program membership. Five repository secrets
(`gh secret set <NAME> -R <owner>/offerfinch`):

| Secret | What it is |
|---|---|
| `MAC_CERT_P12_BASE64` | The **Developer ID Application** certificate and its private key, exported as .p12, base64 encoded |
| `MAC_CERT_PASSWORD` | The .p12's export password |
| `APPLE_API_KEY_P8` | An App Store Connect API key's `.p8` file contents (notarization) |
| `APPLE_API_KEY_ID` | That key's Key ID |
| `APPLE_API_ISSUER` | The Issuer ID shown above the keys list |

1. **Certificate.** developer.apple.com › Certificates › + › **Developer ID Application** (G2 Sub-CA).
   Create the signing request with Keychain Access › Certificate Assistant › Request a Certificate
   From a Certificate Authority (saved to disk). Download the certificate and double-click it.
2. **Export it.** Keychain Access › My Certificates › "Developer ID Application: …" › Export as
   `.p12` with a password. Then `base64 -i cert.p12 | gh secret set MAC_CERT_P12_BASE64 -R <owner>/offerfinch`
   and `gh secret set MAC_CERT_PASSWORD -R <owner>/offerfinch`.
3. **Notarization key.** appstoreconnect.apple.com › Users and Access › Integrations › App Store
   Connect API › Team Keys › + (access: Developer). Download the `.p8` (only once), note the Key ID
   and the Issuer ID. Then `gh secret set APPLE_API_KEY_P8 -R <owner>/offerfinch < AuthKey_XXXX.p8`,
   `gh secret set APPLE_API_KEY_ID -R <owner>/offerfinch`, `gh secret set APPLE_API_ISSUER -R <owner>/offerfinch`.
4. Delete the local `.p12` and `.p8` copies once the secrets are set.

## What can go wrong

- **"Tag does not match version":** tag with the release script, which bumps `package.json` first.
- **Notarization fails:** the log names the file; usually a native binary that is not signed.
  `codesign -dvv` on it shows the signature.
- **An installed app does not update:** Settings › General › Updates shows the error. Ad-hoc
  builds (from `pnpm dist`) never update; a release must be newer than the installed version.
- **Rolling back:** publish a newer version with the old code; apps never move to a lower version.
