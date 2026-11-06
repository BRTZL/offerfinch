import fs from "node:fs";
import path from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
	accelerator,
	comboLabel,
	GO_PAGES,
	matches,
	SHORTCUT_GROUPS,
	SHORTCUTS,
	type Shortcut,
	shortcut,
} from "../src/shared/shortcuts";

// The menu as a release build has it: no Reload or Developer Tools.
vi.mock("electron", () => ({
	app: { isPackaged: true, showAboutPanel: () => {}, getPath: () => "" },
	Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
	shell: { openPath: () => {} },
}));
vi.mock("../src/main/state", () => ({ mainState: { updates: undefined } }));
vi.mock("../src/main/window", () => ({
	sendCommand: () => {},
	showWindow: () => {},
}));

const all = SHORTCUTS as readonly Shortcut[];

/** Every item of the menu bar with an accelerator, at any depth. */
function menuAccelerators(
	items: MenuItemConstructorOptions[],
): { label: string; accelerator: string }[] {
	return items.flatMap((item) => [
		...(item.accelerator
			? [
					{
						label: String(item.label ?? item.role),
						accelerator: String(item.accelerator),
					},
				]
			: []),
		...(Array.isArray(item.submenu) ? menuAccelerators(item.submenu) : []),
	]);
}

/**
 * Issue #48: one list of shortcuts. The menu bar's accelerators come from it, and the sheet
 * renders it, so every shortcut the app answers to is on the sheet.
 */
describe("keyboard shortcuts", () => {
	it("every menu bar accelerator is a listed shortcut, and every listed menu shortcut is in the menu", async () => {
		const { menuTemplate } = await import("../src/main/menu");
		const inMenu = menuAccelerators(menuTemplate());
		const listed = all.filter((s) => s.menu).map((s) => accelerator(s.id));
		expect(inMenu.length).toBeGreaterThan(0);
		for (const item of inMenu) expect(listed).toContain(item.accelerator);
		expect(inMenu.map((i) => i.accelerator).sort()).toEqual([...listed].sort());
	});

	it("keeps the accelerators the menu had before the list existed", () => {
		expect(accelerator("command-menu", true)).toBe("Command+K");
		expect(accelerator("toggle-inspector", true)).toBe("Command+Alt+I");
		expect(accelerator("toggle-sidebar", true)).toBe("Command+\\");
		expect(accelerator("settings", true)).toBe("Command+,");
		expect(GO_PAGES.map((g) => accelerator(g.id, true))).toEqual(
			GO_PAGES.map((_, i) => `Command+${i + 1}`),
		);
		expect(accelerator("shortcuts", true)).toBe("Command+/");
	});

	it("puts every shortcut in a group the sheet shows, with a unique id", () => {
		const ids = all.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const s of all) {
			expect(SHORTCUT_GROUPS).toContain(s.group);
			expect(s.keys.length).toBeGreaterThan(0);
			expect(s.label.trim()).toBeTruthy();
		}
		// No two shortcuts on one screen share a key.
		for (const group of SHORTCUT_GROUPS) {
			const keys = all
				.filter((s) => s.group === group)
				.flatMap((s) => s.keys.map((combo) => comboLabel(combo)));
			expect(new Set(keys).size).toBe(keys.length);
		}
	});

	it("has no shortcut that approves", () => {
		for (const s of all) expect(`${s.id} ${s.label}`).not.toMatch(/approv/i);
	});

	it("tells keys apart by their modifiers", () => {
		const macMatches = (
			event: Parameters<typeof matches>[0],
			id: Parameters<typeof matches>[1],
		) => matches(event, id, true);
		const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
			key: k,
			metaKey: false,
			altKey: false,
			ctrlKey: false,
			shiftKey: false,
			...mods,
		});
		expect(macMatches(key("k", { metaKey: true }), "command-menu")).toBe(true);
		expect(
			macMatches(key("k", { metaKey: true, shiftKey: true }), "command-menu"),
		).toBe(false);
		expect(macMatches(key("k"), "command-menu")).toBe(false);
		expect(macMatches(key("k"), "inbox-previous")).toBe(true);
		expect(macMatches(key("k", { metaKey: true }), "inbox-previous")).toBe(
			false,
		);
		expect(macMatches(key("P", { shiftKey: true }), "inbox-prepare")).toBe(
			true,
		);
		expect(macMatches(key("p", { ctrlKey: true }), "inbox-prepare")).toBe(
			false,
		);
		expect(macMatches(key("Backspace"), "inbox-dismiss")).toBe(true);
		expect(macMatches(key("/", { metaKey: true }), "shortcuts")).toBe(true);
		expect(
			comboLabel(shortcut("toggle-inspector").keys[0] ?? { key: "" }, true),
		).toBe("⌥⌘I");
	});

	it("leaves no key handler or key hint written by hand in the page", () => {
		// Keys in fields (↩ sends a chat message, Esc cancels a reject, ↩ adds a typed word, the
		// model picker's ↑ ↓ ↩ in its search field), the resize handle's and the
		// action bar's arrows belong to their control, not to a screen; the rest read
		// shared/shortcuts.ts.
		const FIELD_KEYS = new Set([
			"components/pipeline/add-job.tsx",
			"components/pipeline/not-interested.tsx",
			"components/pipeline/chat/chat-panel.tsx",
			"components/pipeline/application/detail.tsx",
			"components/system/resize-handle.tsx",
			"components/system/action-bar.tsx",
			"components/ui/tag-input.tsx",
			"components/ui/model-picker.tsx",
			"pages/questions.tsx",
		]);
		const root = path.resolve(import.meta.dirname, "../src/renderer");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			// Vendored code (the stageshow kit draws keycaps for its demos) is not the app's.
			const entries = fs
				.readdirSync(dir, { withFileTypes: true })
				.filter(
					(e) => path.relative(root, path.join(dir, e.name)) !== "vendor",
				);
			for (const entry of entries) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(file);
				else if (/\.tsx?$/.test(entry.name)) {
					const rel = path.relative(root, file).split(path.sep).join("/");
					// Code only: comments may name a key.
					const code = fs
						.readFileSync(file, "utf8")
						.split("\n")
						.filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
						.join("\n");
					if (
						!FIELD_KEYS.has(rel) &&
						/(?<![\w.])(?:(?:event|e)\.key|key)\s*[!=]==\s*"/.test(code)
					)
						offenders.push(`${rel}: compares a key by hand`);
					if (/["'`>][^"'`<]*[⌘⌥]/.test(code))
						offenders.push(`${rel}: writes a shortcut hint by hand`);
				}
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});

it("Windows puts Settings and Quit in File and excludes macOS app roles", async () => {
	const { menuTemplate } = await import("../src/main/menu");
	const template = menuTemplate("win32");
	expect(template.some((item) => item.label === "OfferFinch")).toBe(false);
	const file = template.find((item) => item.label === "File");
	expect(Array.isArray(file?.submenu)).toBe(true);
	const fileItems = file?.submenu as MenuItemConstructorOptions[];
	expect(fileItems.some((item) => item.id === "settings")).toBe(true);
	expect(fileItems.some((item) => item.label === "Quit OfferFinch")).toBe(true);
	const walk = (
		items: MenuItemConstructorOptions[],
	): MenuItemConstructorOptions[] =>
		items.flatMap((item) => [
			item,
			...(Array.isArray(item.submenu) ? walk(item.submenu) : []),
		]);
	expect(
		walk(template).some((item) =>
			["services", "hide", "hideOthers", "unhide", "appMenu"].includes(
				item.role ?? "",
			),
		),
	).toBe(false);
	expect(
		menuAccelerators(template).every(
			(item) => !item.accelerator.includes("Command+"),
		),
	).toBe(true);
});
