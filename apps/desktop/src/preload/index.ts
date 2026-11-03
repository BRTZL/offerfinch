import { contextBridge, ipcRenderer } from "electron";

import {
	APP_COMMANDS,
	type AppCommand,
	type DesktopBridge,
	IPC,
	RPC_PORT_MESSAGE,
	type SecretName,
	type SitePageInfo,
	type UpdateState,
} from "../shared/bridge";

/**
 * The renderer's only doors: `window.desktop` (fixed calls, checked again in main) and one
 * MessagePort to the worker's oRPC handler, handed to the page with window.postMessage (ports
 * cannot cross contextBridge). Node and Electron APIs stay here.
 */
ipcRenderer.on(IPC.rpcPort, (event) => {
	window.postMessage(RPC_PORT_MESSAGE, window.location.origin, [
		...event.ports,
	]);
});

const subscribe = <A extends unknown[]>(
	channel: string,
	callback: (...args: A) => void,
) => {
	const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
		callback(...(args as A));
	ipcRenderer.on(channel, listener);
	return () => {
		ipcRenderer.removeListener(channel, listener);
	};
};

const bridge: DesktopBridge = {
	info: () => ipcRenderer.invoke(IPC.info),
	openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, String(url)),
	openDocument: (id) => ipcRenderer.invoke(IPC.openDocument, String(id)),
	saveDocument: (id) => ipcRenderer.invoke(IPC.saveDocument, String(id)),
	saveDataExport: () => ipcRenderer.invoke(IPC.saveDataExport),
	backup: {
		save: () => ipcRenderer.invoke(IPC.backupSave),
		check: () => ipcRenderer.invoke(IPC.backupCheck),
		discard: (id) => ipcRenderer.invoke(IPC.backupDiscard, String(id)),
		restore: (id) => ipcRenderer.invoke(IPC.backupRestore, String(id)),
	},
	saveInterviewEvent: (id) =>
		ipcRenderer.invoke(IPC.saveInterviewEvent, String(id)),
	openProof: (id, which) =>
		ipcRenderer.invoke(IPC.openProof, String(id), which),
	diagnostics: {
		prepare: () => ipcRenderer.invoke(IPC.diagnosticsPrepare),
		save: (id) => ipcRenderer.invoke(IPC.diagnosticsSave, String(id)),
		discard: (id) => ipcRenderer.invoke(IPC.diagnosticsDiscard, String(id)),
	},
	releaseNotes: () => ipcRenderer.invoke(IPC.releaseNotes),
	secrets: {
		set: (name: SecretName, value: string) =>
			ipcRenderer.invoke(IPC.secretSet, name, String(value)),
		remove: (name: SecretName) => ipcRenderer.invoke(IPC.secretRemove, name),
		status: () => ipcRenderer.invoke(IPC.secretStatus),
		available: () => ipcRenderer.invoke(IPC.secretAvailable),
		unreadable: () => ipcRenderer.invoke(IPC.secretUnreadable),
	},
	openLoginItems: () => ipcRenderer.invoke(IPC.openLoginItems),
	loginItem: {
		get: () => ipcRenderer.invoke(IPC.loginGet),
		set: (open) => ipcRenderer.invoke(IPC.loginSet, Boolean(open)),
	},
	notifications: {
		test: () => ipcRenderer.invoke(IPC.notifyTest),
		state: () => ipcRenderer.invoke(IPC.notifyState),
		openSettings: () => ipcRenderer.invoke(IPC.notifyOpenSettings),
		clearMissed: () => ipcRenderer.invoke(IPC.notifyClearMissed),
		setSound: (sound) => ipcRenderer.invoke(IPC.notifySetSound, sound),
		chirp: () => ipcRenderer.invoke(IPC.notifyChirp),
	},
	updates: {
		state: () => ipcRenderer.invoke(IPC.updateState),
		check: () => ipcRenderer.invoke(IPC.updateCheck),
		install: () => ipcRenderer.invoke(IPC.updateInstall),
		onChange: (callback) =>
			subscribe(IPC.updateChanged, (state: UpdateState) => callback(state)),
	},
	sites: {
		show: (site, mode, bounds) =>
			ipcRenderer.invoke(IPC.siteShow, site, mode, bounds),
		setBounds: (site, bounds) => ipcRenderer.send(IPC.siteBounds, site, bounds),
		hide: (site) => ipcRenderer.invoke(IPC.siteHide, site),
		onPage: (callback) =>
			subscribe(IPC.sitePage, (page: SitePageInfo) => callback(page)),
	},
	onNavigate: (callback) =>
		subscribe(IPC.navigate, (path: unknown) => {
			if (typeof path === "string" && path.startsWith("/")) callback(path);
		}),
	reconnect: () => ipcRenderer.send(IPC.rpcConnect),
	copyText: (text) => ipcRenderer.invoke(IPC.copyText, String(text)),
	clipboardLink: () => ipcRenderer.invoke(IPC.clipboardLink),
	contextMenu: (items) => ipcRenderer.invoke(IPC.contextMenu, items),
	onCommand: (callback) =>
		subscribe(IPC.command, (command: unknown) => {
			if (APP_COMMANDS.includes(command as AppCommand))
				callback(command as AppCommand);
		}),
	onWorkerRestart: (callback) => subscribe(IPC.workerRestart, () => callback()),
	onWindowActive: (callback) =>
		subscribe(IPC.windowActive, (active: unknown) => callback(Boolean(active))),
};

contextBridge.exposeInMainWorld("desktop", bridge);
// Light or dark comes from main (nativeTheme), the same source as the vibrancy material, before
// first paint and on every change. The page never reads prefers-color-scheme for it.
const applyTheme = (dark: boolean) =>
	document.documentElement?.classList.toggle("dark", dark);
const initialDark = Boolean(ipcRenderer.sendSync(IPC.themeGet));
if (document.documentElement) applyTheme(initialDark);
window.addEventListener("DOMContentLoaded", () => applyTheme(initialDark), {
	once: true,
});
ipcRenderer.on(IPC.themeChanged, (_event, dark: unknown) =>
	applyTheme(Boolean(dark)),
);
// The window draws macOS vibrancy behind the sidebar: the page leaves the sidebar see-through.
if (process.argv.includes("--offerfinch-vibrant"))
	window.addEventListener("DOMContentLoaded", () =>
		document.documentElement.classList.add("vibrant"),
	);
// Ask for the API port once the page can receive it.
window.addEventListener("DOMContentLoaded", () =>
	ipcRenderer.send(IPC.rpcConnect),
);
