import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	type IpcMainInvokeEvent,
	ipcMain,
	shell,
} from "electron";
import {
	type AppInfo,
	IPC,
	isSecretName,
	isSiteTabId,
	type LoginItemState,
	NOTIFICATION_SOUNDS,
	type NotificationSound,
} from "../shared/bridge";
import {
	checkBackup,
	discardBackup,
	restoreBackup,
	saveBackup,
} from "./backup-actions";
import {
	discardDiagnostics,
	prepareDiagnostics,
	releaseNotes,
	saveDiagnostics,
} from "./diagnostics-export";
import { saveInterviewEvent } from "./interview-event";
import { contextMenu } from "./menu";
import { NOTIFICATION_SETTINGS_URL } from "./notifications";
import { APP_ORIGIN } from "./protocol";
import { secretUpdater } from "./secret-updates";
import { mainState, TEST_MODE } from "./state";
import { testHooks } from "./test-hooks";
import { connectRenderer } from "./window";

/* ---------------------------------------------------------------- windows */

function isAppSender(event: IpcMainInvokeEvent): boolean {
	const url = event.senderFrame?.url ?? "";
	return url.startsWith(`${APP_ORIGIN}/`);
}

function handle<A extends unknown[], R>(
	channel: string,
	fn: (...args: A) => R | Promise<R>,
) {
	ipcMain.handle(channel, async (event, ...args) => {
		if (!isAppSender(event)) throw new Error("Refused: not the app's window");
		return fn(...(args as A));
	});
}

/* ------------------------------------------------------------- login item */

function loginItemState(): LoginItemState {
	const settings = app.getLoginItemSettings();
	const status = (settings as { status?: string }).status;
	return {
		openAtLogin: settings.openAtLogin,
		status:
			status === "enabled" ||
			status === "requires-approval" ||
			status === "not-registered" ||
			status === "not-found"
				? status
				: settings.openAtLogin
					? "enabled"
					: "unknown",
	};
}

/* --------------------------------------------------------------- the IPC */

/** Export Diagnostics' bundle (built and saved in main) and What's new's release notes. */
function registerDiagnosticsIpc() {
	handle(IPC.diagnosticsPrepare, () => prepareDiagnostics());
	handle(IPC.diagnosticsSave, (id: unknown) => {
		if (typeof id !== "string") throw new Error("Bad request");
		return saveDiagnostics(id);
	});
	handle(IPC.diagnosticsDiscard, (id: unknown) => {
		if (typeof id !== "string") throw new Error("Bad request");
		discardDiagnostics(id);
	});
	handle(IPC.releaseNotes, () => releaseNotes());
}

export function registerIpc() {
	handle(
		IPC.info,
		(): AppInfo => ({
			name: app.getName(),
			version: app.getVersion(),
			electron: process.versions.electron,
			chrome: process.versions.chrome,
			node: process.versions.node,
			arch: process.arch,
			userData: app.getPath("userData"),
		}),
	);
	handle(IPC.updateState, () => mainState.updates.get());
	handle(IPC.updateCheck, () => mainState.updates.check());
	handle(IPC.updateInstall, () => mainState.updates.install());
	handle(IPC.openExternal, async (url: unknown) => {
		if (typeof url !== "string" || !/^https?:\/\//.test(url))
			throw new Error("Only web links open outside the app");
		await shell.openExternal(url);
	});
	const tempFile = async (name: string, bytes: Uint8Array) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-"));
		const file = path.join(dir, name.replace(/[^\w.-]+/g, "_"));
		await fs.promises.writeFile(file, bytes);
		return file;
	};
	handle(IPC.openDocument, async (documentId: unknown) => {
		if (typeof documentId !== "string") throw new Error("Bad id");
		const file = await mainState.worker.request<{
			name: string;
			bytes: Uint8Array;
		}>("fileBytes", documentId);
		const opened = await shell.openPath(await tempFile(file.name, file.bytes));
		if (opened) throw new Error(opened);
	});
	handle(IPC.saveDocument, async (documentId: unknown) => {
		if (typeof documentId !== "string") throw new Error("Bad id");
		const file = await mainState.worker.request<{
			name: string;
			bytes: Uint8Array;
		}>("fileBytes", documentId);
		const target = await dialog.showSaveDialog({
			defaultPath: path.join(app.getPath("downloads"), file.name),
		});
		if (target.canceled || !target.filePath) return false;
		await fs.promises.writeFile(target.filePath, file.bytes);
		return true;
	});
	handle(IPC.openProof, async (attemptId: unknown, which: unknown) => {
		if (
			typeof attemptId !== "string" ||
			(which !== "before" && which !== "after")
		)
			throw new Error("Bad request");
		const file = await mainState.worker.request<{
			name: string;
			bytes: Uint8Array;
		}>("proofBytes", attemptId, which);
		await shell.openPath(await tempFile(file.name, file.bytes));
	});
	handle(IPC.saveDataExport, async () => {
		const target = await dialog.showSaveDialog({
			defaultPath: path.join(
				app.getPath("downloads"),
				`offerfinch-export-${new Date().toISOString().slice(0, 10)}.json`,
			),
		});
		if (target.canceled || !target.filePath) return false;
		const json = await mainState.worker.request<string>("dataExport");
		await fs.promises.writeFile(target.filePath, json, { mode: 0o600 });
		return true;
	});
	handle(IPC.backupSave, () => saveBackup());
	handle(IPC.backupCheck, () => checkBackup());
	handle(IPC.backupDiscard, (id: unknown) => {
		if (typeof id !== "string") throw new Error("Bad request");
		discardBackup(id);
	});
	handle(IPC.backupRestore, (id: unknown) => {
		if (typeof id !== "string") throw new Error("Bad request");
		return restoreBackup(id);
	});
	handle(IPC.saveInterviewEvent, saveInterviewEvent);
	registerDiagnosticsIpc();
	const secretUpdates = secretUpdater(mainState.secrets, (all) =>
		mainState.worker.post({ type: "secrets", secrets: all }),
	);
	handle(IPC.secretSet, async (name: unknown, value: unknown) => {
		if (!isSecretName(name) || typeof value !== "string")
			throw new Error("Bad request");
		await secretUpdates.set(name, value);
	});
	handle(IPC.secretRemove, async (name: unknown) => {
		if (!isSecretName(name)) throw new Error("Bad request");
		await secretUpdates.remove(name);
	});
	handle(IPC.secretStatus, () => mainState.secrets.status());
	handle(IPC.secretAvailable, () => mainState.secrets.available());
	handle(IPC.secretUnreadable, () => mainState.secrets.unreadable());
	handle(IPC.openLoginItems, async () => {
		if (TEST_MODE) return;
		await shell.openExternal(
			"x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
		);
	});
	handle(IPC.loginGet, () => loginItemState());
	handle(IPC.loginSet, (open: unknown) => {
		if (typeof open !== "boolean") throw new Error("Bad request");
		if (!TEST_MODE) app.setLoginItemSettings({ openAtLogin: open });
		return loginItemState();
	});
	handle(IPC.contextMenu, (items: unknown) => contextMenu(items));
	handle(IPC.clipboardLink, async () => {
		const text = (await clipboard.readText()).trim();
		return /^https?:\/\/\S+$/i.test(text) && text.length <= 2000 ? text : null;
	});
	handle(IPC.copyText, (text: unknown) => {
		if (typeof text !== "string" || text.length > 1_000_000)
			throw new Error("Bad request");
		clipboard.writeText(text);
	});
	handle(IPC.notifyTest, async () => {
		await mainState.notifier.show({
			title: "Notifications are on",
			body: "You'll hear about strong matches, questions and applications ready for review.",
			path: "/settings/notifications",
		});
		if (TEST_MODE)
			testHooks.notices.push({
				title: "Notifications are on",
				body: "",
				path: "/settings/notifications",
				kind: "match",
			});
		return mainState.notifier.get();
	});
	handle(IPC.notifyState, () => mainState.notifier.get());
	handle(IPC.notifyClearMissed, () => mainState.notifier.clearMissed());
	handle(IPC.notifySetSound, (sound: unknown) => {
		if (!NOTIFICATION_SOUNDS.includes(sound as NotificationSound))
			throw new Error("Bad request");
		return mainState.notifier.setSound(sound as NotificationSound);
	});
	handle(IPC.notifyChirp, () => {
		const played = mainState.notifier.chirp();
		if (TEST_MODE && played) testHooks.chirps.push(Date.now());
		return played;
	});
	handle(IPC.notifyOpenSettings, async () => {
		if (TEST_MODE) return;
		await shell.openExternal(NOTIFICATION_SETTINGS_URL);
	});
	handle(IPC.siteShow, (site: unknown, mode: unknown, bounds: unknown) => {
		if (
			!isSiteTabId(site) ||
			(mode !== "sign-in" && mode !== "live") ||
			typeof bounds !== "object" ||
			bounds === null
		)
			throw new Error("Bad request");
		const win = mainState.mainWindow;
		if (!win || win.isDestroyed()) throw new Error("No window");
		return mainState.sites.show(site, mode, win, bounds as never);
	});
	handle(IPC.siteHide, (site: unknown) => {
		if (!isSiteTabId(site)) throw new Error("Bad request");
		mainState.sites.hide(site);
	});
	ipcMain.on(IPC.siteBounds, (event, site: unknown, bounds: unknown) => {
		if (!event.senderFrame?.url.startsWith(`${APP_ORIGIN}/`)) return;
		if (!isSiteTabId(site) || typeof bounds !== "object" || bounds === null)
			return;
		mainState.sites.setBounds(site, bounds as never);
	});
	ipcMain.on(IPC.rpcConnect, (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || !event.senderFrame?.url.startsWith(`${APP_ORIGIN}/`)) return;
		connectRenderer(win);
	});
}
