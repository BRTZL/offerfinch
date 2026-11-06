# Uninstall OfferFinch

Dragging the app to the Trash leaves your data behind: the database, files, site sign-ins,
logs, and a Keychain item if an earlier version stored API keys. These steps remove all of it. They cannot be
undone, so export a backup first (Settings › Your data › Export backup) if you may want your
data again.

## 1. Quit and stop it starting at login

1. If OfferFinch opens at login, turn it off in Settings › General, or in System Settings ›
   General › Login Items.
2. Quit OfferFinch: its menu-bar icon › Quit OfferFinch, or OfferFinch › Quit OfferFinch
   (⌘Q). Closing the window is not enough; the app keeps running in the menu bar.

## 2. Delete the app

Drag `OfferFinch.app` from Applications to the Trash.

## 3. Remove its data

In Terminal, or with Finder's Go › Go to Folder (⇧⌘G) for each path:

```sh
# Database, files, backups, encrypted keys, site sign-ins and caches
rm -rf ~/Library/Application\ Support/OfferFinch
# Logs
rm -rf ~/Library/Logs/OfferFinch
# Update downloads and macOS's own caches and saved state for the app
rm -rf ~/Library/Caches/app.offerfinch.desktop* ~/Library/Caches/*offerfinch*-updater
rm -rf ~/Library/HTTPStorages/app.offerfinch.desktop*
rm -rf ~/Library/Saved\ Application\ State/app.offerfinch.desktop.savedState
rm -f ~/Library/Preferences/app.offerfinch.desktop.plist
# Documents opened in another app (temporary copies)
rm -rf "$TMPDIR"offerfinch-*
```

Some of these will not exist; that is fine.

`~/Library/Application Support/OfferFinch` holds the site sign-ins (LinkedIn, Indeed, Glassdoor,
in its `Partitions` folder), so removing it signs OfferFinch out of every site. It does not sign
you out of those sites in your own browser.

## 4. Remove the Keychain item

Earlier versions encrypted API keys with a key macOS keeps in your Keychain. It exists only if
you stored an API key in one of them.

1. Open Keychain Access (Applications › Utilities).
2. Search for `OfferFinch Safe Storage`.
3. Select it and press Delete.

Or in Terminal: `security delete-generic-password -s "OfferFinch Safe Storage"`.

## 5. Earlier versions

Early test builds were called Job Pipeline. If you used one, also remove
`~/Library/Application Support/Job Pipeline`, `~/Library/Logs/Job Pipeline` and the
`Job Pipeline Safe Storage` Keychain item.

## Check

Both commands should print nothing:

```sh
ls -d ~/Library/*/*[Oo]ffer[Ff]inch* ~/Library/*/app.offerfinch.desktop* 2>/dev/null
security find-generic-password -s "OfferFinch Safe Storage" 2>/dev/null
```

## What is left

Nothing from OfferFinch. Backups and exports you saved yourself (for example
`offerfinch-backup-….zip` or `offerfinch-export-….json` in Downloads) stay until you delete
them. Anything a model vendor or job site received is covered by their own terms; see
[Privacy](privacy.md) (in the app: Settings › Your data › Privacy).
