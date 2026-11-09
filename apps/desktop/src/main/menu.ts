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

/**
 * Edit: what Electron's `editMenu` role gives on each platform, then Find (⌘F, ⌘G, ⇧⌘G), which
 * the page answers in an open application (components/system/find-bar.tsx).
 */
function editMenu(platform: NodeJS.Platform): MenuItemConstructorOptions {
	const mac = platform === "darwin";
	const find = (id: "find" | "find-next" | "find-previous", label: string) => ({
		id,
		label,
		accelerator: accelerator(id, mac),
		click: () => sendCommand(id),
	});
	return {
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			...(mac
				? ([
						{ role: "pasteAndMatchStyle" },
						{ role: "delete" },
						{ role: "selectAll" },
					] satisfies MenuItemConstructorOptions[])
				: ([
						{ role: "delete" },
						{ type: "separator" },
						{ role: "selectAll" },
					] satisfies MenuItemConstructorOptions[])),
			{ type: "separator" },
			{
				label: "Find",
				submenu: [
					find("find", "Find…"),
					find("find-next", "Find Next"),
					find("find-previous", "Find Previous"),
				],
			},
			...(mac
				? ([
						{ type: "separator" },
						{
							label: "Speech",
							submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
						},
					] satisfies MenuItemConstructorOptions[])
				: []),
		],
	};
}

/** The menu bar's items, apart from building them (tests read the accelerators). */
export function menuTemplate(
	platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
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
					accelerator: accelerator("settings", platform === "darwin"),
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
					accelerator: accelerator("quit", platform === "darwin"),
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
					accelerator: accelerator("add-job", platform === "darwin"),
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
		editMenu(platform),
		{
			label: "View",
			submenu: [
				{
					id: "command-menu",
					label: "Search…",
					accelerator: accelerator("command-menu", platform === "darwin"),
					click: () => sendCommand("command-menu"),
				},
				{
					id: "toggle-sidebar",
					label: "Show or Hide Sidebar",
					accelerator: accelerator("toggle-sidebar", platform === "darwin"),
					click: () => sendCommand("toggle-sidebar"),
				},
				{
					id: "toggle-inspector",
					label: "Show or Hide Inspector",
					accelerator: accelerator("toggle-inspector", platform === "darwin"),
					click: () => sendCommand("toggle-inspector"),
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
				...(dev
					? ([
							{ type: "separator" },
							{ role: "reload" },
							{ role: "toggleDevTools", accelerator: "CommandOrControl+Alt+J" },
						] satisfies MenuItemConstructorOptions[])
					: []),
			],
		},
		{
			label: "Go",
			submenu: GO_PAGES.map((g) => ({
				id: g.id,
				label: g.label,
				accelerator: accelerator(g.id, platform === "darwin"),
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
					accelerator: accelerator("shortcuts", platform === "darwin"),
					click: () => sendCommand("shortcuts"),
				},
				{ type: "separator" },
				{
					id: "export-diagnostics",
					label: "Export Diagnostics…",
					click: () => showWindowWith("export-diagnostics"),
				},
				{
					label:
						platform === "win32"
							? "Show Logs in Explorer"
							: "Show Logs in Finder",
					click: () => void shell.openPath(app.getPath("logs")),
				},
			],
		},
	];
	if (platform !== "darwin") {
		const appMenu = template.shift();
		const file = template.find((item) => item.label === "File");
		if (
			file &&
			Array.isArray(file.submenu) &&
			Array.isArray(appMenu?.submenu)
		) {
			file.submenu.push(
				{ type: "separator" },
				...appMenu.submenu.filter(
					(item) => item.type !== "separator" && !item.role,
				),
			);
		}
	}
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
