# Windows support

OfferFinch was built as a macOS app. This note lists what ties it to macOS, what changes for
Windows, and what is left for later. Approach borrowed from T3 Code where it already solved the
same problem (`packages/shared/src/shell.ts`, `apps/server/src/provider/Drivers/ClaudeExecutable.ts`).

## What ties the app to macOS

| Area | macOS today | Windows plan |
| --- | --- | --- |
| Packaging | `electron-builder --mac` (DMG + zip), Developer ID, notarized | NSIS installer, x64 and arm64; unsigned for now (SmartScreen warns) |
| better-sqlite3 | N-API prebuilds; Windows ones are excluded from the package | Package only the target platform's prebuilds (win32-x64 and win32-arm64 ship in the npm package) |
| Chrome | `/Applications/*.app/Contents/MacOS/*` | `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%`: Chrome, Edge, Brave, Chromium |
| CLI PATH | login shell `$SHELL -ilc` | No login shell. Windows GUI apps already get the user's PATH; merge it with the user and machine PATH from the registry and the usual install folders (`%USERPROFILE%\.local\bin`, `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm`, Volta, bun, scoop) |
| Finding `claude` | `X_OK` on `<dir>/claude` | PATHEXT lookup; a `.cmd` npm or pnpm shim resolves to the package's `bin/claude.exe` (Node cannot spawn `.cmd` without a shell) |
| CLI environment | allowlist: HOME, USER, SHELL, TMPDIR, ... | Add what Windows programs need: USERPROFILE, APPDATA, LOCALAPPDATA, SystemRoot, WINDIR, ComSpec, PATHEXT, TEMP, TMP, USERNAME, HOMEDRIVE, HOMEPATH, ProgramData, CLAUDE_CODE_GIT_BASH_PATH |
| Codex subscription | runs inside `/usr/bin/sandbox-exec` (Seatbelt) | No equivalent sandbox: stays off (fails closed as a `boundary` pause), and the UI says it is macOS only |
| Backup and diagnostics zips | `/usr/bin/ditto`, `/usr/bin/zipinfo` | `%SystemRoot%\System32\tar.exe` (bsdtar, in Windows 10 1803+): `--format zip --options zip:hdrcharset=UTF-8 -c` writes a zip, `-t` lists, `-x` extracts. No new dependency |
| Notification sound | plays `chirp.aiff` with `/usr/bin/afplay` | Windows' own notification sound; AppUserModelID set so toasts show |
| Tray | black template PNGs | Colour tray icon |
| Menu | macOS app menu (Services, Hide, ...) | Same menus without the macOS-only roles |
| Updates | electron-updater, Squirrel.Mac zips | electron-updater, NSIS installers from GitHub Releases (per-architecture installers, combined fallback) |
| Secrets | `safeStorage` (Keychain) | `safeStorage` uses DPAPI: works as is; wording says "this computer" |

## Phase 1 (this change)

1. CLI discovery and environment on Windows; Codex marked macOS only.
2. Platform zip helper for backups and diagnostics.
3. Main process: Chrome lookup, tray, notifications, menu, updates.
4. Packaging (`pnpm --filter @offerfinch/desktop dist:win`) and a Windows CI job that runs the
   core/db/runner, desktop and local-llm tests (macOS tool and Seatbelt cases skip), builds the installer, launches the packaged app and uploads the installer.

5. Release workflow publishes Windows installers, blockmaps and stable/preview update metadata.
   Release-stamped builds check at launch and every 30 minutes, download in the background and
   install on Restart to Update or next quit. Local and dry-run builds do not update.

## Later

- Code signing (an Authenticode certificate or Azure Trusted Signing): a cost and account decision.
  Once signing is enabled, keep the signing identity/certificate consistent: changing it can
  break updates from installed signed builds. Plan certificate rotation before replacing it.
- The desktop e2e suite on Windows (several specs call macOS tools: `ditto`, `osascript`,
  `screencapture`).
- A Codex sandbox for Windows, if one becomes available.
