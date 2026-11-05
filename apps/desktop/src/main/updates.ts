import type { UpdateState } from "../shared/bridge";

/**
 * Over-the-air updates from GitHub Releases (electron-updater, Squirrel.Mac underneath).
 * Checks at launch, every 30 minutes, and when the Mac wakes or the window comes forward (at
 * most every 10 minutes), downloads in the background, and installs when the user restarts (or
 * on the next quit). Only a Developer ID–signed, notarized build can install an
 * update: macOS checks that the new app is signed by the same team as the running one.
 */

/** The part of electron-updater's AppUpdater this uses (a fake stands in for it in tests). */
export interface Updater {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	checkForUpdates(): Promise<unknown>;
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

const CHECK_EVERY_MS = 30 * 60 * 1000;
/** Waking the Mac or bringing the window forward checks again once the last check is this old. */
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
			if (this.announced !== info.version) {
				this.announced = info.version;
				options.onReady(info.version);
			}
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

	private set(state: UpdateState) {
		this.state = state;
		this.options.onChange(state);
	}

	get(): UpdateState {
		return this.state;
	}

	/** Checks now and then every 30 minutes. */
	start() {
		if (!this.updater || this.state.status === "disabled") return;
		void this.check();
		this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
		this.timer.unref?.();
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * Checks again if the last check is over 10 minutes old: for waking from sleep, unlocking
	 * and the window coming forward, so a Mac that sleeps through the timer still hears of a
	 * release soon after it is back.
	 */
	checkIfStale(): void {
		if (this.nowMs() - this.checkedAt < STALE_AFTER_MS) return;
		void this.check();
	}

	/** Checks for an update; does nothing while one is downloading or ready. */
	async check(): Promise<UpdateState> {
		if (!this.updater || this.state.status === "disabled") return this.state;
		if (
			this.state.status === "checking" ||
			this.state.status === "downloading" ||
			this.state.status === "ready"
		)
			return this.state;
		this.checkedAt = this.nowMs();
		try {
			await this.updater.checkForUpdates();
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
		}
		return this.state;
	}

	/** Quits, installs the downloaded update and opens the new version. */
	install(): boolean {
		if (!this.updater || this.state.status !== "ready") return false;
		this.updater.quitAndInstall(false, true);
		return true;
	}
}
