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
		expect(accelerator("command-menu")).toBe("Command+K");
		expect(accelerator("toggle-inspector")).toBe("Command+Alt+I");
		expect(accelerator("toggle-sidebar")).toBe("Command+\\");
		expect(accelerator("settings")).toBe("Command+,");
		expect(GO_PAGES.map((g) => accelerator(g.id))).toEqual(
			GO_PAGES.map((_, i) => `Command+${i + 1}`),
		);
		expect(accelerator("shortcuts")).toBe("Command+/");
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
				.flatMap((s) => s.keys.map(comboLabel));
			expect(new Set(keys).size).toBe(keys.length);
		}
	});

	it("has no shortcut that approves", () => {
		for (const s of all) expect(`${s.id} ${s.label}`).not.toMatch(/approv/i);
	});

	it("tells keys apart by their modifiers", () => {
		const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
			key: k,
			metaKey: false,
			altKey: false,
			ctrlKey: false,
			shiftKey: false,
			...mods,
		});
		expect(matches(key("k", { metaKey: true }), "command-menu")).toBe(true);
		expect(
			matches(key("k", { metaKey: true, shiftKey: true }), "command-menu"),
		).toBe(false);
		expect(matches(key("k"), "command-menu")).toBe(false);
		expect(matches(key("k"), "inbox-previous")).toBe(true);
		expect(matches(key("k", { metaKey: true }), "inbox-previous")).toBe(false);
		expect(matches(key("P", { shiftKey: true }), "inbox-prepare")).toBe(true);
		expect(matches(key("p", { ctrlKey: true }), "inbox-prepare")).toBe(false);
		expect(matches(key("Backspace"), "inbox-dismiss")).toBe(true);
		expect(matches(key("/", { metaKey: true }), "shortcuts")).toBe(true);
		expect(
			comboLabel(shortcut("toggle-inspector").keys[0] ?? { key: "" }),
		).toBe("⌥⌘I");
	});

	it("leaves no key handler or key hint written by hand in the page", () => {
		// Keys in fields (↩ sends a chat message, Esc cancels a reject) and the resize handle's
		// arrows belong to their control, not to a screen; the rest read shared/shortcuts.ts.
		const FIELD_KEYS = new Set([
			"components/pipeline/add-job.tsx",
			"components/pipeline/not-interested.tsx",
			"components/pipeline/chat/chat-panel.tsx",
			"components/pipeline/application/detail.tsx",
			"components/system/resize-handle.tsx",
			"pages/questions.tsx",
		]);
		const root = path.resolve(import.meta.dirname, "../src/renderer");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(file);
				else if (/\.tsx?$/.test(entry.name)) {
					const rel = path.relative(root, file);
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
