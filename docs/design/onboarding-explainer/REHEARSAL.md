# Rehearsal: the Welcome's flow explainer (2026-11-04)

Why: live test feedback said onboarding should explain the whole flow (find roles, score them on the CV, move on to drafting), that filtered jobs disappearing was confusing, and that the user should stay in control of applying. The Welcome's three bullet lines are replaced by a 14 s looping demo of the Inbox.

Source: `apps/desktop/src/renderer/components/desktop/setup/flow-explainer.tsx` (+ `.css`), on the stageshow kit vendored and trimmed in `apps/desktop/src/renderer/vendor/stageshow/` (MIT, `LICENSE` beside it).

## Story

| Beat | Caption | What happens |
|---|---|---|
| Find | 1 Finds roles | "Searching 9 job boards"; four roles land at the top, each with its board (Remotive, LinkedIn, We Work Remotely) and "Scoring…" |
| Score | 2 Scores them on your CV | Nimbus Labs 94 and Orbit Freight 86 get their fit and "Match" |
| Set aside | 3 Sets aside misfits | Halcyon Health says "Set aside: on-site in São Paulo", Kestrel Bank "41 Below your minimum fit"; both fold into "2 set aside" (the Inbox's own words) |
| Draft | 4 Drafts when you ask | The cursor picks Nimbus Labs and presses Prepare; CV and Letter check off, 12 of 12 claims traced, "Ready for review", "You read it and apply yourself. Nothing is sent." |
| Reset | | The cursor leaves, the draft closes, the rows leave, the status returns to "Checks every hour" |

Poster (reduced motion, thumbnails): the finished state, Nimbus Labs ready for review with the draft open and step 4 lit.

## Choices

- Gold: no single gold tells it; layout from `fade-crop` (a window fading out at its foot over filler), motion from `subscriptions` (a system story with rows arriving).
- Drawn with the app's own `ListRow`, `Cells`, `fitTone` and `buttonVariants`, coloured by the app's tokens, so it follows light and dark and stays true to the Inbox.
- The stage is `aria-hidden`; the four steps are an `ol` for screen readers.
- No `button`, `p` or `li` inside the stage: the kit's host guard reverts them (`all: revert`), which would strip Tailwind classes.

## Film lines left standing, and why

- `layout: … leaves -Npx below its last child` and `hard edge` on the older rows: they run under the window's faded foot on purpose (fade crop).
- `vanishes/appears with no entrance` on the unread dot: `ListRow`'s own dot, cleared on selection as in the Inbox.
- `mixed icons`: none after removing the sidebar's brand mark.
- `settle snap` 0.8–3.3 px after rows open: from `Collapse` with the app's row padding; not visible at 1:1.

## Checked

- Stills at 640 px in light and dark (`film.mjs --still --reduced`), the states sheet over two loops, the gate (remaining lines above).
- The real app: Welcome in Electron at 1440 × 900, light and dark, recorded through a full loop.
- `e2e/onboarding.spec.ts` asserts the explainer fills the column at 960 × 600 and 1440 × 900 (it once collapsed to 0 in the centred flex column).

## Not checked

- macOS Reduce Motion in the packaged app (the poster was checked in Chrome with emulated reduced motion).
- A fresh-eye design review by a person.
