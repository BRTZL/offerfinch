# OfferFinch desktop design system (2026-11-02)

One strict system for every screen of `apps/desktop`. Screens compose the primitives in `apps/desktop/src/renderer/components/system/` and the controls in `components/ui/`. They never set their own font sizes, spacing outside the scale, arbitrary values or raw palette colours. `apps/desktop/test/design-system.test.ts` fails the test run when they do.

## The quality reference: T3 Code

The user named T3 Code as the app that looks and feels right. Its values below come from the public repository, <https://github.com/pingdotgg/t3code> (MIT, © 2026 T3 Tools Inc.), at commit `fa31b66b`. Every value was checked against the CSS shipped in `/Applications/T3 Code (Beta).app` 0.1.6. Paths are relative to `apps/web/src`.

- **What we borrow:** proportions, density, the surface and contrast hierarchy, and state treatments.
- **What we do not borrow:** T3 Code's identity, components or code. No source file was copied. The numbers are re-applied in OfferFinch's own tokens.
- **What stays OfferFinch's own:** the name, the Grid mark with its green beak, the cell meters and the product.

> MIT License, Copyright (c) 2026 T3 Tools Inc. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction … The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. (Full text: `LICENSE` in the T3 Code repository.)

| What | T3 Code (source) | OfferFinch adopts | Why |
|---|---|---|---|
| UI font | `-apple-system`, so SF Pro on a Mac (`index.css:171`) | Same | The system font is the strongest "native" signal |
| Body and controls | 14/20 (`text-sm`, `ui/button.tsx:9`, `ui/input.tsx:64`) | 14/20 | It reads at a glance; the stills' 13 px felt cramped beside T3 |
| Secondary and meta | 12/16 (`text-xs`) | 12/16 | |
| Dense counts, times, kbd | 11/16 (`--text-2xs`, `index.css:178`) | 11/16 | |
| Section title | 16/24, weight 600 (`settings/settingsLayout.tsx:241`) | 16/24, weight 600 | |
| Large title (empty state, greeting) | 20, weight 600 (`ui/empty.tsx:92`) | 20/28, weight 600 | |
| Weights | 400, 500, 600 | 400, 500, 600 | No bold, no uppercase, no tracking |
| Icon stroke | 1.75 (`index.css:1730`) | 1.75 | |
| Radius | 8 for controls, 4 for items, 12 for groups, 16 for dialogs (`index.css:103, 289`) | 4, 8, 12, 16 | All four are steps of the Grid mark's 4-unit grid. The design's 6 and 10 are gone |
| Control heights | 32 default, 28 small, 24 extra small (`ui/button.tsx:17`) | 32, 28, 24 for every control: buttons, fields, pop-ups, segmented controls | One control grid |
| Top bar | 52 px (`--workspace-topbar-height`) | 52 px on every screen | Same height and baseline everywhere |
| Gutter | 20 px (`index.css:142`) | 20 px for the header, 24 px for page content | |
| Sidebar | 256 default, 208 minimum; rows 32 high, 8 inset, 10 row inset (`threadSidebarWidth.ts:2`, `ui/sidebar.tsx:724`) | 220 px; rows 32 high, 8 inset, 10 row inset, 4 apart | Leaves 740 px of content at the 960 px minimum window, and room for list, posting, CV and inspector at 1440 |
| Settings nav | 240 px (`SettingsSidebarNav.tsx:259`) | 220 px second column | |
| Details panel | 280 px (`--thread-details-panel-width`) | 280 px inspector | |
| Settings row | `px-4 py-3`, title 14/500, hint 12 muted (`settingsLayout.tsx:495-523`) | Same | |
| Section gap | 32 px between sections, about 10 px from header to group (`settingsLayout.tsx:231,617`) | 32 and 12 | 12 keeps it on the 4-grid |
| Surfaces, light | Canvas zinc-25, sidebar zinc-50, cards white, borders zinc-200 (`index.css:1113-1179`) | Same | Separation comes from hairlines and white raised surfaces, not grey fills |
| Surfaces, dark | Canvas #000, raised neutral-950 plus 3% white, borders white at 8%, hover white at 4% (`index.css:1188-1226`) | Same | "Borders and hover states provide separation without milky gray fills" |
| Muted text | zinc-500 / neutral-400 | Same: 4.8:1 on white, 7.9:1 on black | |
| Primary | oklch(0.488 0.217 264) / oklch(0.571 0.21 264) | Same | White on it is 6.6:1. The system blue #007aff is 4.0:1, under AA for 14 px text |
| Hover | Quiet fill: zinc-100 in light, white at 4% in dark | Same | |
| Selected row | Sidebar: white card with an inset 1 px ring in light, foreground at 7% in dark (`SidebarThreadRow.tsx:952`) | Same in the sidebar. In lists: a foreground fill at 8%, plus a 2 px primary bar when the list has focus | Quiet selection, as in T3. Mail-style focus stays legible |
| Press | `scale-[0.97]` in 150 ms; no brightness change (`ui/button.tsx:9`) | Same | |
| Bevel | Inset white at 16% on primary; `0 1px black/4%` under outline controls | Same | |
| Motion | 150 ms `cubic-bezier(.4,0,.2,1)`; dialogs 200 ms; panels not animated | Same; nothing over 200 ms, and no motion at idle | |
| Focus | 2 px inset ring in primary on buttons and rows; inputs get a primary border and a 3 px inset ring at 24% (`ui/input.tsx:64`) | Same | Rings never spill outside clipped panes |
| Scrollbars | 6 px, transparent track, thumb #d9d9d9 or white at 8% (`index.css:1851`) | Same | |
| Empty state | Centred; 36 px icon box with border and card fill; title, then a 14 px muted line; `max-w-sm` (`ui/empty.tsx`) | Same, title 16/24 | |
| Skeleton | Stepped opacity breath, 2.4 s, `steps(4)` (`index.css:295`) | Skullet bones at content geometry with the same stepped breath, only while loading | |
| Disabled | 64% opacity | Same | |

Left out on purpose:
- **Grain texture:** extra paint for little gain at our density.
- **Glass menus:** `backdrop-filter` costs GPU memory, and the app is already over its memory target.
- **The user font-size setting:** one fixed scale makes the consistency check meaningful.
- **True-black sidebar under vibrancy:** see "Sidebar material" below.

## Tokens

All tokens are CSS variables in `apps/desktop/src/renderer/index.css`, exposed to Tailwind as colours.

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | #fcfcfc | #000000 | Window canvas, panes |
| `sidebar` | #fafafa | #000000 | Sidebar, settings sections column, inspector |
| `card` | #ffffff | #111111 | Groups, list surfaces, popovers, the selected sidebar row in light |
| `foreground` | #18181b | #f5f5f5 | Titles, body text |
| `muted-foreground` | #71717b | #a3a3a3 | Hints, meta, counts |
| `border` | #e4e4e7 | white at 8% | Hairlines |
| `input` | #d4d4d8 | white at 11% | Field and control edges |
| `hover` | #f4f4f5 | white at 4% | Row and ghost-control hover |
| `selected` | foreground at 7% | foreground at 9% | Selected rows |
| `primary` | oklch(0.488 0.217 264) | oklch(0.571 0.21 264) | Buttons, links, focus, sidebar icons |
| `brand` | #15803d | #34c759 | The beak: high fit, traced claim, met requirement. Nothing else |
| `warning` / `warning-surface` | #b45309 / amber at 8% | #fbbf24 / amber at 16% | Needs you: questions, flags, gaps |
| `destructive` | #b91c1c | #f87171 | Reject, delete, errors |
| `well` | #f4f4f5 | #0a0a0a | Behind the CV page |

## Scales

- **Type:** `text-2xs` 11/16, `text-xs` 12/16, `text-sm` 14/20, `text-base` 16/24, `text-xl` 20/28. Weights `font-normal`, `font-medium`, `font-semibold`. `font-mono` with `tabular-nums` for fit, cost, counts and dates.
- **Spacing:** Tailwind steps 0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12 (0 to 48 px).
- **Radius:** `rounded-sm` 4, `rounded-lg` 8, `rounded-xl` 12, `rounded-2xl` 16, `rounded-full`.
- **Controls:** 32 (`default`), 28 (`sm`), 24 (`xs`).

## Layout constants

| | Value |
|---|---|
| Header (`PageHeader`) | 52 px high, 20 px horizontal inset, title 14/20 semibold |
| Page content inset (`Page`) | 24 px on every side |
| Gap between sections | 32 px |
| Section title to content | 12 px |
| One-line row (`Row`) | 40 px, 16 px horizontal inset |
| Two-line row, form row (`FormRow`) | 12 px vertical padding, 16 px horizontal |
| Pane header (`Pane`) | 40 px |
| Sidebar | 220 px; rows 32 px |
| Inspector | 280 px |
| Inbox list | 300 px (260 below a 1040 px window); rows 3 lines, 12 px vertical padding, 82 px |

## Primitives

All live in `components/system/`.

| Primitive | What it is |
|---|---|
| `AppShell` | The window: sidebar and main column |
| `PageHeader` | The 52 px toolbar: title, optional subtitle, actions on the right. It is a drag region, and every control in it opts out |
| `Toolbar` | The action group inside `PageHeader`, with `ToolbarSeparator` |
| `Page` | The scrolling content area with the content inset. `width="form"` caps it at 720 px, left aligned |
| `Pane` | A column with a 40 px header (title, end slot) and a scrolling body |
| `Section` | Title, optional end slot, content 12 px below. Sections stack 32 px apart |
| `Group` | A rounded-xl card with hairline dividers between rows |
| `Row` | A row inside a `Group`: leading slot, title, subtitle, trailing slot |
| `FormRow` | Label and hint on the left, the control on the right |
| `List`, `ListRow` | Keyboard list: arrow keys, Home, End, Mail-style selection, right-click |
| `EmptyState` | Icon box, title, one line, actions |
| `Inspector`, `InspectorSection` | The 280 px right column |
| `Cells` | The mark's cells as a meter |
| `Mark` | The Grid mark |
| `Badge`, `Kbd`, `Fit` | Small labels |

## Motion and feel

- **Navigation is instant.** Pages are split into chunks but preloaded after the first paint. There are no route transitions and no spinners. A page that waits for data shows its own skeleton at the content's geometry, inside a header that is already final, so nothing shifts when the data lands.
- **Hover and press:** colour and background transitions take 150 ms. Buttons scale to 0.97 when pressed. Selection changes instantly.
- **Nothing animates at idle.** The scan indicator is a static cell meter. Skeletons breathe in four steps, and only while loading.
- `prefers-reduced-motion` turns transitions and skeleton breathing off.

## Changed from the stills

This feedback wins over the stills where they differ. What changed:

| | Stills (`inbox-dark.png` and the others) | Now | Why |
|---|---|---|---|
| Body type | 13 px | 14/20 | T3 Code's density reads better; 13 px felt cramped beside it |
| Toolbar title | 15 px bold | 14/20 semibold, on every screen | One header for every screen |
| Page and detail title | 19 px bold | 20/28 semibold (`text-xl`) | On the type scale |
| Radii | 2, 4, 6, 8, 10, 12 | 4, 8, 12, 16 | Steps of the mark's 4-grid only |
| Controls | 26 px push buttons | 32, 28 in toolbars, 24 | One control grid |
| Accent | The system accent, read with `getAccentColor()` (#007aff) | A fixed blue, oklch(0.488 0.217 264) light, oklch(0.571 0.21 264) dark | White on #007aff is 4.0:1, under AA for 14 px text; the fixed blue is 6.6:1 |
| Dark surfaces | #1c1c1e content, #26272d sidebar | #000 canvas, #111 raised, white 8% hairlines | T3 Code's true-black hierarchy |
| Sidebar | 212 px, accent icons | 220 px; icons quiet, the current page's icon in the accent; the current row a white card with a hairline (light) | T3 Code's selected-row treatment |
| Inbox selection | A solid accent fill | A quiet fill (foreground at 7–9%), plus a 2 px accent bar while the list has focus | T3 Code's quiet selection; Mail's focus cue kept |
| Inbox tabs | To review, Answers, All | The pipeline in order (2026-11-03): Matches, Drafting, To review as segments with counts, then Approved, Closed and All in a quieter segment row; a company with several matches is one line that opens to its roles | The user asked what to do in the Inbox; every state stays one click away |
| Section labels | 12 px semibold | 14/20 semibold | On the type scale |
| Loading | Skullet everywhere | Skullet for grouped rows, the scan's new matches and an application loading; hand-built rows in the virtualized Inbox list | See "Skullet" below |

## Skullet

`skullet` 0.0.3 (MIT, <https://skullet.lochie.me>) draws the loading shapes from real components with sample text (`components/system/loading.tsx`): `RowsSkeleton` (every grouped list and settings section), Home's new matches during a scan, and the application detail while it loads. The README's risk was panes below the fold drawing no bones. In the virtualized Inbox list, rows mount and unmount as they scroll, so a measured skeleton has nothing stable to measure. That list uses hand-built rows (`ListRowsSkeleton`) at the rows' exact 82 px geometry instead.

## Sidebar material

Measured with an A/B: see the section "Vibrancy A/B" in `docs/design/desktop/README.md`.

## Enforcement

`apps/desktop/test/design-system.test.ts` reads every screen file: `pages/**` and `components/{pipeline,desktop,shell}/**`. It fails on:
- an arbitrary value (`p-[13px]`, `text-[11px]`, `bg-[#…]`, `w-[…]`);
- a spacing step outside the scale;
- a font size outside the scale;
- a raw palette colour (`text-amber-700`, `bg-red-500`, `text-white`);
- `rounded-none`, or a radius outside the scale.

The primitives and controls in `components/system` and `components/ui` are where the exact values live, so they are exempt.
