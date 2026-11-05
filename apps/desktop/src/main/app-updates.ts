import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { IPC, type UpdateState } from "../shared/bridge";
import { buildMenu } from "./menu";
import { log, mainState, TEST_MODE } from "./state";
import { testHooks } from "./test-hooks";
import { updateTray } from "./tray";
import { type Updater, Updates } from "./updates";
import { FakeUpdater } from "./updates-fake";

/**
 * Only the release workflow's builds can install updates (signed with the Developer ID). It
 * stamps `"offerfinchRelease": true` into the packaged package.json; local builds lack it.
 */
function releaseBuild(): boolean {
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"),
		) as { offerfinchRelease?: unknown };
		return pkg.offerfinchRelease === true;
	} catch {
		return false;
	}
}

/**
 * Release builds update from GitHub Releases. Development and test builds do not, except that
 * tests can swap in a fake updater (OFFERFINCH_FAKE_UPDATE=<version>) to drive the UI.
 */
export async function createUpdates(): Promise<Updates> {
	const fakeVersion = TEST_MODE
		? process.env.OFFERFINCH_FAKE_UPDATE
		: undefined;
	let updater: Updater | null = null;
	let disabledReason: string | null = null;
	if (process.platform === "win32")
		disabledReason =
			"Updates on Windows: download new versions from GitHub Releases.";
	else if (fakeVersion) updater = new FakeUpdater(fakeVersion, log);
	else if (TEST_MODE) disabledReason = "Test builds don't update themselves.";
	else if (!app.isPackaged)
		disabledReason = "Development builds don't update themselves.";
	else if (!releaseBuild())
		disabledReason =
			"This build was made locally and doesn't update itself. Releases from GitHub do.";
	else {
		const { autoUpdater } = await import("electron-updater");
		autoUpdater.logger = {
			info: (m: unknown) => log("updater", String(m)),
			warn: (m: unknown) => log("updater warning", String(m)),
			error: (m: unknown) => log("updater error", String(m)),
			debug: () => {},
		};
		updater = autoUpdater as unknown as Updater;
	}
	return new Updates(updater, {
		currentVersion: app.getVersion(),
		disabledReason,
		log,
		onChange: (state: UpdateState) => {
			for (const win of BrowserWindow.getAllWindows())
				win.webContents.send(IPC.updateChanged, state);
			buildMenu();
			updateTray();
		},
		onReady: (version) => {
			const notice = {
				title: `OfferFinch ${version} is ready`,
				body: "Restart OfferFinch to update. It also installs the next time you quit.",
				path: "/settings/general",
			};
			if (TEST_MODE) testHooks.updateNotices.push(notice);
			void mainState.notifier.show(notice);
		},
	});
}
