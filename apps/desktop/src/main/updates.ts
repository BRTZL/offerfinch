import type { UpdateState } from "../shared/bridge";

/**
 * Over-the-air updates from GitHub Releases (electron-updater, Squirrel.Mac underneath).
 * Checks at launch and every 6 hours, downloads in the background, and installs when the user
 * restarts (or on the next quit). Only a Developer ID–signed, notarized build can install an
 * update: macOS checks that the new app is signed by the same team as the running one.
 */

/** The part of electron-updater's AppUpdater this uses (a fake stands in for it in tests). */
export interface Updater {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	checkForUpdates(): Promise<unknown>;
	quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
	on(event: "checking-for-update", fn: () => void): unknown;
	on(
		event: "update-available",
		fn: (info: { version: string }) => void,
	): unknown;
	on(
		event: "update-not-available",
		fn: (info: { version: string }) => void,
	): unknown;
	on(
		event: "download-progress",
		fn: (progress: { percent: number }) => void,
	): unknown;
	on(
		event: "update-downloaded",
		fn: (info: { version: string }) => void,
	): unknown;
	on(event: "error", fn: (error: Error) => void): unknown;
}

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

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
			this.set({
				status: "ready",
				currentVersion: this.current,
				version: info.version,
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

	private nowIso() {
		return (this.options.now?.() ?? new Date()).toISOString();
	}

	private set(state: UpdateState) {
		this.state = state;
		this.options.onChange(state);
	}

	get(): UpdateState {
		return this.state;
	}

	/** Checks now and then every 6 hours. */
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

	/** Checks for an update; does nothing while one is downloading or ready. */
	async check(): Promise<UpdateState> {
		if (!this.updater || this.state.status === "disabled") return this.state;
		if (
			this.state.status === "checking" ||
			this.state.status === "downloading" ||
			this.state.status === "ready"
		)
			return this.state;
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
