import type { Updater } from "./updates";

/** Release notes as GitHub's feed gives them: the body rendered to HTML, lines broken with <br>. */
const NOTES = `<ul>
<li>Matches show up while the scan still runs, so the first ones arrive well before it&#39;s<br>
done.</li>
<li>Codex can find matches and write drafts. A draft is still never checked by the company that<br>
wrote it.</li>
<li>Settings &rsaquo; General checks for updates every 30 minutes.</li>
</ul>`;

/**
 * Tests only (OFFERFINCH_FAKE_UPDATE=<version>): an updater that finds that version, "downloads"
 * it in a few steps and then reports it ready. Installing records the call instead of quitting.
 * OFFERFINCH_FAKE_UPDATE_STEP_MS slows the steps (150 ms by default), to watch the download.
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
		const info = { version: this.version, releaseNotes: NOTES };
		this.emit("update-available", info);
		for (const percent of [25, 60, 100]) {
			await tick();
			this.emit("download-progress", { percent });
		}
		this.emit("update-downloaded", info);
		return null;
	}

	quitAndInstall() {
		this.installs++;
		this.log("fake update install", { version: this.version });
		(globalThis as Record<string, unknown>).__offerfinchInstalls =
			this.installs;
	}
}

const STEP_MS = Number(process.env.OFFERFINCH_FAKE_UPDATE_STEP_MS) || 150;
const tick = () => new Promise((resolve) => setTimeout(resolve, STEP_MS));
