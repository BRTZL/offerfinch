import { IS_MAC, primaryModifier } from "./platform";
/**
 * Every keyboard shortcut OfferFinch has, in one place (issue #48): the menu bar's accelerators
 * (main/menu.ts), the page's own keys (Inbox, lists, the command menu), the hints beside buttons,
 * and Help › Keyboard Shortcuts all read this list, so none can drift from the others.
 *
 * No shortcut approves an application (docs/decisions.md, 2026-11-03 Inbox rows): approval is
 * always a click on Approve with the documents in view. Prepare's P acts on one match only.
 *
 * Standard macOS keys that the system's own menu roles bring (Edit › Copy, ⌘W, ⌘H, ⌘M, full
 * screen) work as in every Mac app and are not listed (decisions.md, 2026-11-03).
 */

/** A key as `KeyboardEvent.key` names it ("j", "ArrowDown", "Enter", "/"), with modifiers. */
export interface KeyCombo {
	key: string;
	cmd?: boolean;
	alt?: boolean;
	shift?: boolean;
	/** A mouse click with these modifiers (shown only; the list reads the click itself). */
	click?: boolean;
}

/** The screens the sheet groups shortcuts by, in its order. */
export const SHORTCUT_GROUPS = [
	"General",
	"Inbox",
	"Go to",
	"Questions, Applied and Rejected",
	"Application",
	"Questions",
	"Find",
	"Search",
] as const;
type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export interface Shortcut {
	id: string;
	group: ShortcutGroup;
	label: string;
	/** Alternatives: any of them does it. The first is the one hints show. */
	keys: KeyCombo[];
	/** A menu bar item uses the first key as its accelerator. */
	menu?: boolean;
}

const cmd = (key: string, more: Omit<KeyCombo, "key" | "cmd"> = {}) => ({
	key,
	cmd: true,
	...more,
});

/** The pages ⌘1…⌘7 open, in the sidebar's order (main/menu.ts builds Go from these). */
export const GO_PAGES = [
	{ id: "go-1", label: "Home", path: "/" },
	{ id: "go-2", label: "Inbox", path: "/inbox" },
	{ id: "go-3", label: "Questions", path: "/questions" },
	{ id: "go-4", label: "Applied", path: "/applied" },
	{ id: "go-5", label: "Rejected", path: "/rejected" },
	{ id: "go-6", label: "Profile", path: "/profile" },
	{ id: "go-7", label: "Settings", path: "/settings" },
] as const;

export const SHORTCUTS = [
	// General: the menu bar's own items.
	{
		id: "command-menu",
		group: "General",
		label: "Search and commands",
		keys: [cmd("k")],
		menu: true,
	},
	{
		id: "add-job",
		group: "General",
		label: "Add job from link",
		keys: [cmd("n")],
		menu: true,
	},
	{
		id: "settings",
		group: "General",
		label: "Settings",
		keys: [cmd(",")],
		menu: true,
	},
	{
		id: "toggle-sidebar",
		group: "General",
		label: "Show or hide the sidebar",
		keys: [cmd("\\")],
		menu: true,
	},
	{
		id: "shortcuts",
		group: "General",
		label: "Keyboard shortcuts",
		keys: [cmd("/")],
		menu: true,
	},
	{
		id: "quit",
		group: "General",
		label: "Quit OfferFinch (scans stop)",
		keys: [cmd("q")],
		menu: true,
	},
	...GO_PAGES.map(
		(page, i): Shortcut => ({
			id: page.id,
			group: "Go to",
			label: page.label,
			keys: [cmd(String(i + 1))],
			menu: true,
		}),
	),
	// The Inbox list (pages/inbox.tsx), while it has focus.
	{
		id: "inbox-next",
		group: "Inbox",
		label: "Next",
		keys: [{ key: "j" }, { key: "ArrowDown" }],
	},
	{
		id: "inbox-previous",
		group: "Inbox",
		label: "Previous",
		keys: [{ key: "k" }, { key: "ArrowUp" }],
	},
	{
		id: "inbox-first",
		group: "Inbox",
		label: "First",
		keys: [{ key: "Home" }],
	},
	{ id: "inbox-last", group: "Inbox", label: "Last", keys: [{ key: "End" }] },
	{
		id: "inbox-expand",
		group: "Inbox",
		label: "Open a company's roles",
		keys: [{ key: "ArrowRight" }],
	},
	{
		id: "inbox-collapse",
		group: "Inbox",
		label: "Close a company, or back to it",
		keys: [{ key: "ArrowLeft" }],
	},
	{
		id: "inbox-enter",
		group: "Inbox",
		label: "Into the application (or open a company)",
		keys: [{ key: "Enter" }],
	},
	{
		id: "inbox-prepare",
		group: "Inbox",
		label: "Prepare the selected match (one at a time)",
		keys: [{ key: "p" }],
	},
	{
		id: "inbox-dismiss",
		group: "Inbox",
		label: "Not interested",
		keys: [{ key: "x" }, { key: "Backspace" }, { key: "Delete" }],
	},
	{
		id: "inbox-select-several",
		group: "Inbox",
		label: "Select several",
		keys: [
			cmd("Click", { click: true }),
			{ key: "Click", shift: true, click: true },
		],
	},
	// The other lists (components/system/list.tsx).
	{
		id: "list-next",
		group: "Questions, Applied and Rejected",
		label: "Next",
		keys: [{ key: "ArrowDown" }],
	},
	{
		id: "list-previous",
		group: "Questions, Applied and Rejected",
		label: "Previous",
		keys: [{ key: "ArrowUp" }],
	},
	{
		id: "list-first",
		group: "Questions, Applied and Rejected",
		label: "First",
		keys: [{ key: "Home" }],
	},
	{
		id: "list-last",
		group: "Questions, Applied and Rejected",
		label: "Last",
		keys: [{ key: "End" }],
	},
	{
		id: "list-enter",
		group: "Questions, Applied and Rejected",
		label: "Into the selected item",
		keys: [{ key: "Enter" }],
	},
	// An open application.
	{
		id: "toggle-inspector",
		group: "Application",
		label: "Show or hide details",
		keys: [cmd("i", { alt: true })],
		menu: true,
	},
	{
		id: "close-panels",
		group: "Application",
		label: "Close a panel drawn over the document",
		keys: [{ key: "Escape" }],
	},
	{
		id: "question-save",
		group: "Questions",
		label: "Save the answer and open the next question",
		keys: [cmd("Enter")],
	},
	{
		id: "question-pick",
		group: "Questions",
		label: "Pick a suggested answer (4 writes your own)",
		keys: [{ key: "1" }, { key: "2" }, { key: "3" }, { key: "4" }],
	},
	{
		id: "question-edit",
		group: "Questions",
		label: "Edit the picked answer",
		keys: [{ key: "e" }],
	},
	// Find in an open application (components/system/find-bar.tsx).
	{
		id: "find",
		group: "Find",
		label: "Find in the posting, CV, letter or answers",
		keys: [cmd("f")],
		menu: true,
	},
	{
		id: "find-next",
		group: "Find",
		label: "Next match (or ↩ in the field)",
		keys: [cmd("g")],
		menu: true,
	},
	{
		id: "find-previous",
		group: "Find",
		label: "Previous match (or ⇧↩ in the field)",
		keys: [cmd("g", { shift: true })],
		menu: true,
	},
	// The command menu (components/shell/command-menu.tsx).
	{
		id: "search-next",
		group: "Search",
		label: "Next result",
		keys: [{ key: "ArrowDown" }],
	},
	{
		id: "search-previous",
		group: "Search",
		label: "Previous result",
		keys: [{ key: "ArrowUp" }],
	},
	{
		id: "search-run",
		group: "Search",
		label: "Open or run it",
		keys: [{ key: "Enter" }],
	},
	{
		id: "search-close",
		group: "Search",
		label: "Close",
		keys: [{ key: "Escape" }],
	},
] as const satisfies readonly Shortcut[];

export type ShortcutId =
	| (typeof SHORTCUTS)[number]["id"]
	| (typeof GO_PAGES)[number]["id"];

export function shortcut(id: ShortcutId): Shortcut {
	const found = (SHORTCUTS as readonly Shortcut[]).find((s) => s.id === id);
	if (!found) throw new Error(`No shortcut ${id}`);
	return found;
}

/** Electron's accelerator for a menu item ("Command+Alt+I"). */
export function accelerator(id: ShortcutId, isMac = IS_MAC): string {
	const combo = shortcut(id).keys[0];
	if (!combo) throw new Error(`Shortcut ${id} has no key`);
	return [
		combo.cmd ? (isMac ? "Command" : "CommandOrControl") : "",
		combo.alt ? "Alt" : "",
		combo.shift ? "Shift" : "",
		combo.key.length === 1 ? combo.key.toUpperCase() : combo.key,
	]
		.filter(Boolean)
		.join("+");
}

const KEY_GLYPH: Record<string, string> = {
	ArrowDown: "↓",
	ArrowUp: "↑",
	ArrowLeft: "←",
	ArrowRight: "→",
	Enter: "↩",
	Escape: "Esc",
	Backspace: "⌫",
	Delete: "⌦",
	Home: "Home",
	End: "End",
	Click: "Click",
};

/** A key as macOS menus write it: ⌥⌘I, ⌘↩, J, ↓. */
export function comboLabel(combo: KeyCombo, isMac = IS_MAC): string {
	const key =
		KEY_GLYPH[combo.key] ??
		(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
	if (!isMac)
		return [
			combo.cmd ? "Ctrl" : "",
			combo.alt ? "Alt" : "",
			combo.shift ? "Shift" : "",
			key,
		]
			.filter(Boolean)
			.join("+");
	return `${combo.alt ? "⌥" : ""}${combo.shift ? "⇧" : ""}${combo.cmd ? "⌘" : ""}${combo.click ? "-" : ""}${key}`.replace(
		/^-/,
		"",
	);
}

/** The hint beside a button: the shortcut's first key ("⌘K"). */
export function keyHint(id: ShortcutId): string {
	const combo = shortcut(id).keys[0];
	return combo ? comboLabel(combo) : "";
}

/**
 * Whether a key press is this shortcut. A key with a modifier must match its modifiers exactly
 * (⇧⌘K is not ⌘K); a bare key takes Shift too (P and ⇧P both prepare) but never ⌘, ⌥ or ⌃,
 * which belong to the menu bar.
 */
export function matches(
	event: Pick<
		KeyboardEvent,
		"key" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey"
	>,
	id: ShortcutId,
	isMac = IS_MAC,
): boolean {
	return shortcut(id).keys.some((combo) => {
		if (combo.click) return false;
		if (isMac ? event.ctrlKey : event.metaKey) return false;
		if (Boolean(combo.cmd) !== primaryModifier(event, isMac)) return false;
		if (Boolean(combo.alt) !== event.altKey) return false;
		const modified = combo.cmd || combo.alt;
		if (modified && Boolean(combo.shift) !== event.shiftKey) return false;
		return combo.key.length === 1
			? event.key.toLowerCase() === combo.key
			: event.key === combo.key;
	});
}
