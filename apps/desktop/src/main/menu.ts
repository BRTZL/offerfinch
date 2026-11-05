import { app, Menu, type MenuItemConstructorOptions, shell } from "electron";
import {
	CONTEXT_ITEMS,
	type ContextItem,
	type ContextItemId,
} from "../shared/bridge";
import { accelerator, GO_PAGES } from "../shared/shortcuts";
import { mainState } from "./state";
import { sendCommand, showWindow, showWindowWith } from "./window";

/* ------------------------------------------------------------------- menu */

/**
 * The app's own menu bar. Release builds have no Reload or Developer Tools (a reload would drop
 * the worker's port), and Help has no links to Electron. No item approves anything. Every
 * accelerator comes from shared/shortcuts.ts, which Help › Keyboard Shortcuts lists.
 */
export function buildMenu() {
	Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
}

/** The menu bar's items, apart from building them (tests read the accelerators). */
export function menuTemplate(): MenuItemConstructorOptions[] {
	const dev = !app.isPackaged && process.env.NODE_ENV !== "production";
	const template: MenuItemConstructorOptions[] = [
		{
			label: "OfferFinch",
			submenu: [
				{ label: "About OfferFinch", click: () => app.showAboutPanel() },
				updateMenuItem(),
				{ type: "separator" },
				{
					id: "settings",
					label: "Settings…",
					accelerator: accelerator("settings"),
					click: () => showWindow("/settings"),
				},
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide", label: "Hide OfferFinch" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{
					label: "Quit OfferFinch",
					accelerator: accelerator("quit"),
					click: () => {
						mainState.quitting = true;
						app.quit();
					},
				},
			],
		},
		{
			label: "File",
			submenu: [
				{
					id: "add-job",
					label: "Add Job from Link…",
					accelerator: accelerator("add-job"),
					click: () => sendCommand("add-job"),
				},
				{
					id: "scan-now",
					label: "Scan Now",
					click: () => void mainState.worker.request("scanNow").catch(() => {}),
				},
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
				{
					id: "command-menu",
					label: "Search…",
					accelerator: accelerator("command-menu"),
					click: () => sendCommand("command-menu"),
				},
				{
					id: "toggle-sidebar",
					label: "Show or Hide Sidebar",
					accelerator: accelerator("toggle-sidebar"),
					click: () => sendCommand("toggle-sidebar"),
				},
				{
					id: "toggle-inspector",
					label: "Show or Hide Inspector",
					accelerator: accelerator("toggle-inspector"),
					click: () => sendCommand("toggle-inspector"),
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
				...(dev
					? ([
							{ type: "separator" },
							{ role: "reload" },
							{ role: "toggleDevTools", accelerator: "Command+Alt+J" },
						] satisfies MenuItemConstructorOptions[])
					: []),
			],
		},
		{
			label: "Go",
			submenu: GO_PAGES.map((g) => ({
				id: g.id,
				label: g.label,
				accelerator: accelerator(g.id),
				click: () => showWindow(g.path),
			})),
		},
		{ role: "windowMenu" },
		{
			role: "help",
			submenu: [
				{
					id: "shortcuts",
					label: "Keyboard Shortcuts",
					accelerator: accelerator("shortcuts"),
					click: () => sendCommand("shortcuts"),
				},
				{ type: "separator" },
				{
					id: "export-diagnostics",
					label: "Export Diagnostics…",
					click: () => showWindowWith("export-diagnostics"),
				},
				{
					label: "Show Logs in Finder",
					click: () => void shell.openPath(app.getPath("logs")),
				},
			],
		},
	];
	return template;
}

/**
 * A right-click menu drawn by macOS (NSMenu), for list rows and the CV page. Items come from a
 * fixed set (shared/bridge.ts CONTEXT_ITEMS): the page can choose which show, never add one.
 */
export function contextMenu(items: unknown): Promise<ContextItemId | null> {
	if (!Array.isArray(items) || items.length > 20 || !mainState.mainWindow)
		return Promise.resolve(null);
	const win = mainState.mainWindow;
	return new Promise((resolve) => {
		let chosen: ContextItemId | null = null;
		const template: MenuItemConstructorOptions[] = [];
		for (const raw of items as ContextItem[]) {
			if (raw?.id === "separator") {
				template.push({ type: "separator" });
				continue;
			}
			if (!CONTEXT_ITEMS.includes(raw?.id as ContextItemId)) continue;
			const id = raw.id as ContextItemId;
			template.push({
				label: String(raw.label ?? id).slice(0, 80),
				enabled: raw.enabled !== false,
				click: () => {
					chosen = id;
				},
			});
		}
		if (template.length === 0) return resolve(null);
		Menu.buildFromTemplate(template).popup({
			window: win,
			// The click handler runs before the menu reports it closed.
			callback: () => setImmediate(() => resolve(chosen)),
		});
	});
}

/**
 * The app menu's update item: "Check for Updates…", or "Restart to Update" once downloaded.
 * Try-it mode (updates suspended) shows neither working: the check is greyed out.
 */
function updateMenuItem(): MenuItemConstructorOptions {
	const state = mainState.updates?.get();
	if (state?.status === "ready" && mainState.updates.canInstall())
		return {
			label: `Restart to Update to ${state.version}`,
			click: () => mainState.updates.install(),
		};
	return {
		label: "Check for Updates…",
		enabled:
			Boolean(state) &&
			state.status !== "disabled" &&
			state.status !== "ready" &&
			!mainState.updates.isSuspended(),
		click: () => {
			showWindow("/settings/general");
			void mainState.updates.check();
		},
	};
}
