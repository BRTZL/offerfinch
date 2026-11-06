import type { UpdateState } from "../shared/bridge";

/**
 * Over-the-air updates from GitHub Releases (electron-updater: Squirrel.Mac on macOS, NSIS on Windows).
 * Checks at launch, every 6 hours, and when the computer wakes or the window comes forward (at
 * most every 10 minutes), downloads in the background, and installs when the user restarts (or
 * on the next quit). macOS requires Developer ID signing and notarization, with the same team
 * as the running app. Windows NSIS builds currently update without Authenticode signing.
 */

/**
 * What a check started (electron-updater's UpdateCheckResult): with `autoDownload`, the
 * download's promise and the token that cancels it.
 */
interface UpdateCheck {
	cancellationToken?: { cancel(): void } | null;
	downloadPromise?: Promise<unknown> | null;
}

/** The part of electron-updater's AppUpdater this uses (a fake stands in for it in tests). */
export interface Updater {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	checkForUpdates(): Promise<UpdateCheck | null>;
	quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
	on(event: "checking-for-update", fn: () => void): unknown;
	on(event: "update-available", fn: (info: UpdateInfo) => void): unknown;
	on(
		event: "update-not-available",
		fn: (info: { version: string }) => void,
	): unknown;
	on(
		event: "download-progress",
		fn: (progress: { percent: number }) => void,
	): unknown;
	on(event: "update-downloaded", fn: (info: UpdateInfo) => void): unknown;
	on(event: "error", fn: (error: Error) => void): unknown;
}

/** What electron-updater says about a release: GitHub gives the notes as the release's HTML. */
export interface UpdateInfo {
	version: string;
	releaseNotes?: string | { version: string; note: string | null }[] | null;
}

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Waking the computer or bringing the window forward checks again once the last check is this old. */
const STALE_AFTER_MS = 10 * 60 * 1000;

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	rsaquo: "›",
	lsaquo: "‹",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
};

/**
 * The release notes as plain lines, one per bullet: GitHub's release body arrives as HTML
 * (`<ul><li>…<br>…</li></ul>`), a hand-written body may be Markdown bullets. Never HTML out:
 * the text comes from the network and is shown as text.
 */
export function releaseNoteLines(notes: UpdateInfo["releaseNotes"]): string[] {
	const text = Array.isArray(notes)
		? (notes[0]?.note ?? "")
		: typeof notes === "string"
			? notes
			: "";
	if (!text.trim() || text.trim() === "No content.") return [];
	const plain = (s: string) =>
		s
			.replace(/<br\s*\/?>/gi, " ")
			.replace(/<[^>]*>/g, "")
			.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
				if (e[0] === "#") {
					const code =
						e[1] === "x" || e[1] === "X"
							? Number.parseInt(e.slice(2), 16)
							: Number.parseInt(e.slice(1), 10);
					return Number.isFinite(code) ? String.fromCodePoint(code) : m;
				}
				return ENTITIES[e.toLowerCase()] ?? m;
			})
			.replace(/\s+/g, " ")
			.trim();
	const items = [...text.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) =>
		plain(m[1] ?? ""),
	);
	if (items.length) return items.filter(Boolean);
	// Markdown: "- " or "* " starts a bullet, indented lines continue it.
	const bullets: string[] = [];
	for (const line of text.split("\n")) {
		const start = /^\s*[-*]\s+(.*)$/.exec(line);
		if (start) bullets.push(start[1] ?? "");
		else if (bullets.length && line.trim())
			bullets[bullets.length - 1] += ` ${line.trim()}`;
	}
	if (bullets.length) return bullets.map(plain).filter(Boolean);
	const one = plain(text);
	return one ? [one] : [];
}

/** How long suspend() waits for a running check and a cancelled download to end. */
const DRAIN_MS = 5_000;

/** Why entering try-it mode was refused: an update request did not end in time. */
export const UPDATE_STILL_RUNNING =
	"An update check is still running. Try again in a moment.";

/** Whether the promise settles within `ms`. */
async function settlesWithin(promise: Promise<void>, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([promise.then(() => true as const), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** The first line of an updater error, without stack or response dumps. */
export function shortError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const line = text.split("\n")[0]?.trim() ?? "";
	if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR_/i.test(line))
		return "No connection to GitHub";
	if (
		/Code signature|code requirement|not signed|did not pass validation/i.test(
			line,
		)
	)
		return "This build can't install updates (it isn't signed with a Developer ID)";
	if (/404/.test(line)) return "No release published yet";
	return line.length > 160 ? `${line.slice(0, 157)}…` : line || "Update failed";
}

export class Updates {
	private state: UpdateState;
	private timer: ReturnType<typeof setInterval> | null = null;
	/** The version the "ready" notice was shown for (once per version). */
	private announced: string | null = null;
	/** Try-it mode (main/demo-actions.ts): no check starts, no notice is shown. */
	private suspended = false;
	/** The check running now, if any. */
	private checking: Promise<void> | null = null;
	/** The download a check started, until it ends: cancelled by suspend(). */
	private download: { cancel: () => void; done: Promise<void> } | null = null;
	/** A download that finished while suspended: announced on resume(). */
	private readyWhileSuspended: string | null = null;
	/** When the last check finished, ms since the epoch (0: never). */
	private checkedAt = 0;

	constructor(
		private readonly updater: Updater | null,
		private readonly options: {
			currentVersion: string;
			/** Why updates are off (a development build, tests); null when they are on. */
			disabledReason: string | null;
			onChange: (state: UpdateState) => void;
			/** A downloaded update is ready: tell the user once per version. */
			onReady: (version: string) => void;
			log: (message: string, data?: unknown) => void;
			now?: () => Date;
		},
	) {
		this.state = options.disabledReason
			? {
					status: "disabled",
					currentVersion: options.currentVersion,
					reason: options.disabledReason,
				}
			: { status: "idle", currentVersion: options.currentVersion };
		if (!updater || options.disabledReason) return;
		updater.autoDownload = true;
		updater.autoInstallOnAppQuit = true;
		updater.on("checking-for-update", () =>
			this.set({ status: "checking", currentVersion: this.current }),
		);
		updater.on("update-available", (info) =>
			this.set({
				status: "downloading",
				currentVersion: this.current,
				version: info.version,
				percent: 0,
				notes: releaseNoteLines(info.releaseNotes),
			}),
		);
		updater.on("download-progress", (p) => {
			if (this.state.status !== "downloading") return;
			this.set({ ...this.state, percent: Math.round(p.percent) });
		});
		updater.on("update-not-available", () =>
			this.set({
				status: "up-to-date",
				currentVersion: this.current,
				checkedAt: this.nowIso(),
			}),
		);
		updater.on("update-downloaded", (info) => {
			const notes = releaseNoteLines(info.releaseNotes);
			this.set({
				status: "ready",
				currentVersion: this.current,
				version: info.version,
				notes:
					notes.length || this.state.status !== "downloading"
						? notes
						: this.state.notes,
			});
			if (this.suspended) this.readyWhileSuspended = info.version;
			else this.announce(info.version);
		});
		updater.on("error", (error) => {
			options.log("update failed", { error: String(error) });
			// No check runs while an update is ready, so an error then comes from preparing or
			// installing it (Squirrel.Mac validates the signature after electron-updater reports
			// it downloaded). Report it so the user can check again instead of a stuck Restart.
			this.set({
				status: "error",
				currentVersion: this.current,
				error: shortError(error),
				checkedAt: this.nowIso(),
			});
		});
	}

	private get current() {
		return this.options.currentVersion;
	}

	private nowMs() {
		return (this.options.now?.() ?? new Date()).getTime();
	}

	private nowIso() {
		return new Date(this.nowMs()).toISOString();
	}

	private announce(version: string) {
		if (this.announced === version) return;
		this.announced = version;
		this.options.onReady(version);
	}

	private set(state: UpdateState) {
		this.state = state;
		this.options.onChange(state);
	}

	get(): UpdateState {
		return this.state;
	}

	/** Checks now and then every 6 hours (not while suspended). */
	start() {
		if (!this.updater || this.state.status === "disabled") return;
		if (this.suspended) return;
		this.stop();
		void this.check();
		this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
		this.timer.unref?.();
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * Try-it mode: no network from here on. Every entry point (the timer, Settings, the app
	 * menu) is refused while suspended, and so is installing a downloaded update. A running check
	 * is waited for and the download it started cancelled; both must have ended within `drainMs`,
	 * or the suspension is undone and this rejects (UPDATE_STILL_RUNNING), so the demo is not
	 * entered while an update request is still on the network. A download that finished before
	 * is announced only on resume().
	 */
	async suspend(drainMs = DRAIN_MS): Promise<void> {
		if (this.suspended) return;
		this.suspended = true;
		this.stop();
		this.options.onChange(this.state);
		const deadline = Date.now() + drainMs;
		const ended = (promise: Promise<void>) =>
			settlesWithin(promise, Math.max(0, deadline - Date.now()));
		if (this.checking !== null && !(await ended(this.checking))) {
			this.refuseSuspend("a check");
		}
		// The check has ended, so a download it started is tracked (and was cancelled there).
		this.download?.cancel();
		if (this.download !== null && !(await ended(this.download.done))) {
			this.refuseSuspend("a download");
		}
	}

	private refuseSuspend(what: string): never {
		this.options.log("update suspension refused", { running: what });
		this.resume();
		throw new Error(UPDATE_STILL_RUNNING);
	}

	/** Try-it mode runs: no check, download or install. */
	isSuspended(): boolean {
		return this.suspended;
	}

	/** Whether a downloaded update can be installed now (not while try-it mode runs). */
	canInstall(): boolean {
		return (
			Boolean(this.updater) && !this.suspended && this.state.status === "ready"
		);
	}

	/** Out of try-it mode: checks again (now and every 6 hours), and announces a ready update. */
	resume() {
		if (!this.suspended) return;
		this.suspended = false;
		this.options.onChange(this.state);
		// A cancelled download reports no event of its own: back to idle, so a check can run.
		const status = this.state.status;
		if (
			(status === "checking" || status === "downloading") &&
			!this.checking &&
			!this.download
		)
			this.set({ status: "idle", currentVersion: this.current });
		const ready = this.readyWhileSuspended;
		this.readyWhileSuspended = null;
		if (ready) this.announce(ready);
		this.start();
	}

	/**
	 * Checks again if the last check is over 10 minutes old: for waking from sleep, unlocking
	 * and the window coming forward, so a computer that sleeps through the timer still hears of a
	 * release soon after it is back.
	 */
	checkIfStale(): void {
		if (this.nowMs() - this.checkedAt < STALE_AFTER_MS) return;
		void this.check();
	}

	/** Checks for an update; does nothing while one is downloading or ready, or suspended. */
	async check(): Promise<UpdateState> {
		if (!this.updater || this.state.status === "disabled") return this.state;
		if (
			this.suspended ||
			this.checking !== null ||
			this.state.status === "checking" ||
			this.state.status === "downloading" ||
			this.state.status === "ready"
		)
			return this.state;
		this.checkedAt = this.nowMs();
		const run = this.runCheck(this.updater);
		this.checking = run;
		await run;
		return this.state;
	}

	/** One check at a time: `checking` is cleared as soon as it ends, so the next may start. */
	private async runCheck(updater: Updater): Promise<void> {
		try {
			this.track(await updater.checkForUpdates());
		} catch (error) {
			// The "error" event usually reports it too; this covers a rejection without one.
			const now = this.state.status as UpdateState["status"];
			if (now !== "error" && now !== "ready")
				this.set({
					status: "error",
					currentVersion: this.current,
					error: shortError(error),
					checkedAt: this.nowIso(),
				});
		} finally {
			this.checking = null;
		}
	}

	/** Keeps hold of the download a check started, so suspend() can cancel it. */
	private track(result: UpdateCheck | null) {
		const promise = result?.downloadPromise;
		if (!promise) return;
		const token = result.cancellationToken;
		const download = {
			cancel: () => token?.cancel(),
			// Its failures are reported by the "error" event; a cancel by none.
			done: promise.then(
				() => {},
				() => {},
			),
		};
		this.download = download;
		void download.done.then(() => {
			if (this.download !== download) return;
			this.download = null;
			// A cancelled download reports no event: one that ended after a refused suspend() (it
			// was cancelled, then the deadline passed) must not leave "downloading" behind, or no
			// check would run again. While suspended, resume() resets it.
			if (!this.suspended && this.state.status === "downloading")
				this.set({ status: "idle", currentVersion: this.current });
		});
		if (this.suspended) download.cancel();
	}

	/**
	 * Quits, installs the downloaded update and opens the new version. Refused (false) while
	 * try-it mode runs: the app menu, the menu bar and Settings hide the button then too.
	 */
	install(): boolean {
		if (!this.updater || this.state.status !== "ready") return false;
		if (this.suspended) {
			this.options.log("update install refused: try-it mode runs");
			return false;
		}
		this.updater.quitAndInstall(process.platform === "win32", true);
		return true;
	}
}
