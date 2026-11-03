import type { Updater } from "./updates";

/**
 * Tests only (OFFERFINCH_FAKE_UPDATE=<version>): an updater that finds that version, "downloads"
 * it in a few steps and then reports it ready. Installing records the call instead of quitting.
 */
export class FakeUpdater implements Updater {
	autoDownload = true;
	autoInstallOnAppQuit = true;
	installs = 0;
	private listeners = new Map<string, ((arg?: unknown) => void)[]>();

	constructor(
		private readonly version: string,
		private readonly log: (message: string, data?: unknown) => void,
	) {}

	on(event: string, fn: (arg: never) => void) {
		const list = this.listeners.get(event) ?? [];
		list.push(fn as (arg?: unknown) => void);
		this.listeners.set(event, list);
		return this;
	}

	private emit(event: string, arg?: unknown) {
		for (const fn of this.listeners.get(event) ?? []) fn(arg);
	}

	async checkForUpdates() {
		this.emit("checking-for-update");
		await tick();
		this.emit("update-available", { version: this.version });
		for (const percent of [25, 60, 100]) {
			await tick();
			this.emit("download-progress", { percent });
		}
		this.emit("update-downloaded", { version: this.version });
		return null;
	}

	quitAndInstall() {
		this.installs++;
		this.log("fake update install", { version: this.version });
		(globalThis as Record<string, unknown>).__offerfinchInstalls =
			this.installs;
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 150));
