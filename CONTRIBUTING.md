# Contributing

Thanks for helping with OfferFinch. Bug reports, ideas and pull requests are welcome.

## Before you start

- **Bugs:** open an issue with the bug template. **Help › Export Diagnostics…** in the app
  makes a redacted bundle you can attach.
- **Features:** open an issue first and describe the problem it solves, so we can agree on the
  approach before you spend time on it.
- **Security problems:** never in public. See [SECURITY.md](SECURITY.md).

## Set up

macOS, Node 24 and pnpm (the version in `package.json`):

```sh
pnpm install
pnpm build
pnpm --filter @offerfinch/desktop start
```

[README](README.md) has more on running from source, and [docs](docs/) has the design notes and
[decisions](docs/decisions.md) behind the product rules.

## Checks

Run these before opening a pull request; CI runs the same ones:

```sh
pnpm test
pnpm -r check-types
pnpm lint:ci
pnpm knip
pnpm --filter @offerfinch/desktop e2e
```

End-to-end tests run windowless with temporary data folders, fake models and local fixture job
boards. Never point tests, screenshots or scripts at real app data
(`~/Library/Application Support/OfferFinch`) or real personal data.

## Pull requests

- Keep each pull request to one change, and explain what it changes for the user and why.
- Add tests for new behaviour, and a line under **Unreleased** in
  [apps/desktop/CHANGELOG.md](apps/desktop/CHANGELOG.md) for anything a user would notice.
- No personal data in code, fixtures, screenshots or commit messages: use made-up names,
  emails and companies. `node scripts/check-public.mjs` finds slips locally.
- The app must never submit anything without the user's approval, bypass CAPTCHAs or bot
  checks, or store site passwords. Changes that do will not be merged.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
