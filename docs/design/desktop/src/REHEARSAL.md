# Rehearsal: OfferFinch Native stills

Gold: no single gold tells this story; layout from `linear` (a sidebar app window at full size, realistic fidelity) and `finder`/`spotify` for macOS chrome. Kept the kit `Window` (sidebar kind, `lightsSize="large"`), its lights geometry and shadow tokens; changed the toolbar to 52 pt (`--ss-lights-y: 26px`) because that is the bar the app will ship.

Medium: four stills, 1520 × 980 stage holding a 1440 × 900 window at 1:1, filmed at 2x.

Framing: the window is whole on a quiet desktop ground (`unframed`, own ground). Deliberate: these are design comps of the real app; a marketing crop would cut the sidebar or inspector the user is judging.

Captured: `inbox-dark`, `inbox-light`, `home-dark`, `settings-dark`, each alone on the page (`?only=<id>`), because Skullet measures only a skeleton that is laid out in view; with all four on one page the off-screen ones never drew their bones.

Film lines left standing, and why:
- `mixed icons` on the sidebar: the 16 px Grid mark in the sidebar foot is counted as a filled glyph. It is the brand mark, not an icon.
- `uneven padding` on list rows (9 top, 16 side): Mail-style dense rows; the side inset makes room for the unread dot.
- `clipped` and `empty pane` in `inbox-light`: the CV page runs off the bottom of its well on purpose, and the inspector is a skeleton whose content height is the loaded content's.

Fixed on the way, largest first:
- Skullet drawing nothing in the light Inbox (filmed one still per page).
- A white rim from the film's page pad (`--pad 0`).
- Voids under Home's columns and the Settings form (Applied recently, Watching, Privacy).
- The CV page ending mid-pane.
- Approve live while checks were still loading.
- "Oct 28" wrapping.
- Section labels misaligned with the toolbar title.
- Faint ink under 4.5:1.

Review: no fresh-eye review by another provider was run.

Not checked: motion (none in scope); a real Electron window; macOS 26 lights size against the 52 pt bar.

## Re-filming

These sources follow the stageshow skill's example layout and import the kit as `../../kit`.

1. Copy `offerfinch-native/` into `~/.claude/skills/stageshow/examples/`.
2. Run `npm install` there, then `npm install skullet@0.0.3 --no-save`.
3. Start the preview with `npm run dev`, or run `node_modules/.bin/vite playground --config playground/vite.config.ts --port 5391`.
4. Film each still:

```bash
node scripts/film.mjs "http://localhost:5391/?capture=offerfinch-native&only=inbox-dark" \
  --select "#inbox-dark .ss-fit" --still --width 1600 --pad 0 --delay 1500 --out inbox-dark.png
```

5. Render `directions.png` from `directions.html` with headless Chrome at 2400 px wide, full page.
