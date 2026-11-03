import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Notification } from "electron";
import type { NotificationSound, NotificationState } from "../shared/bridge";
import { type ActionableNotice, noticeButtons } from "./notice-actions";

/** OfferFinch's chirp, in the app bundle's Resources (electron-builder mac.extraResources). */
export const CHIRP_SOUND = "chirp.aiff";

/**
 * The notification options for a sound choice. macOS (26.6 and later) refuses an app's own
 * notification sound and plays its default one instead, so the chirp's notification goes out
 * silent and the app plays the chirp itself once macOS has shown it.
 */
export function soundOptions(sound: NotificationSound): { silent?: boolean } {
	return sound === "default" ? {} : { silent: true };
}

/** Plays the chirp file with macOS's player, without waiting for it; a failure is only logged. */
export function chirpPlayer(
	file: string,
	log: (message: string, data?: unknown) => void,
): () => void {
	return () => {
		execFile("/usr/bin/afplay", [file], (error) => {
			if (error) log("chirp not played", { error: String(error) });
		});
	};
}

/**
 * macOS notifications through Electron (UNUserNotificationCenter on macOS). Electron has no call
 * that reads the permission, so the state is what delivery last showed: a notification macOS
 * accepted ("show"), or one it refused ("failed"; UNErrorDomain 1 is "not allowed"). Notices
 * that could not be shown are counted, so the app can say so instead of losing them silently.
 */
export class Notifier {
	private state: NotificationState;
	private readonly file: string;
	/** Shown notifications, held until closed: a collected one would lose its click handler. */
	private readonly live = new Set<Notification>();
	/** A button in Notification Center was pressed: its index in the notification's `actions`. */
	onAction: (notice: ActionableNotice, index: number) => void = () => {};

	constructor(
		userData: string,
		private readonly onClick: (path: string) => void,
		private readonly log: (message: string, data?: unknown) => void,
		/** Test runs: count as delivered without asking macOS (its permission is the user's). */
		private readonly standIn = false,
		/** Plays the chirp, for a notification macOS has shown with the chirp chosen. */
		private readonly playChirp: () => void = () => {},
	) {
		this.file = path.join(userData, "notifications.json");
		this.state = {
			status: "unknown",
			missed: 0,
			lastError: null,
			at: null,
			sound: "chirp",
		};
		try {
			this.state = {
				...this.state,
				...JSON.parse(fs.readFileSync(this.file, "utf8")),
			};
		} catch {}
		if (!standIn && !Notification.isSupported())
			this.state.status = "unsupported";
	}

	get(): NotificationState {
		return { ...this.state };
	}

	/** Chooses the sound every later notification makes. */
	setSound(sound: NotificationSound): NotificationState {
		this.save({ sound });
		return this.get();
	}

	/** Clears the missed count (the user has seen the in-app notice). */
	clearMissed(): NotificationState {
		this.save({ missed: 0 });
		return this.get();
	}

	private save(patch: Partial<NotificationState>) {
		this.state = { ...this.state, ...patch };
		try {
			fs.writeFileSync(this.file, JSON.stringify(this.state));
		} catch {}
	}

	/**
	 * Shows a notification; resolves with what macOS did with it (within 6 seconds), and records
	 * it as the current state.
	 */
	show(
		input: ActionableNotice & { title: string; body: string },
	): Promise<"delivered" | "blocked" | "unknown"> {
		if (this.standIn) {
			this.save({
				status: "delivered",
				lastError: null,
				at: new Date().toISOString(),
			});
			return Promise.resolve("delivered");
		}
		if (!Notification.isSupported()) return Promise.resolve("blocked");
		const n = new Notification({
			title: input.title,
			body: input.body,
			...soundOptions(this.state.sound),
			actions: noticeButtons(input.actions),
		});
		this.live.add(n);
		const forget = () => this.live.delete(n);
		n.on("click", () => {
			forget();
			this.onClick(input.path);
		});
		// Main holds the notification and its handlers, so a button works with the window closed.
		n.on("action", (event) => {
			forget();
			this.onAction(input, event.actionIndex);
		});
		n.on("close", forget);
		return new Promise((resolve) => {
			const done = (outcome: "delivered" | "blocked" | "unknown") => {
				clearTimeout(timer);
				resolve(outcome);
			};
			const timer = setTimeout(() => done("unknown"), 6_000);
			const sound = this.state.sound;
			n.once("show", () => {
				if (sound === "chirp") this.playChirp();
				this.save({
					status: "delivered",
					lastError: null,
					at: new Date().toISOString(),
				});
				done("delivered");
			});
			n.once("failed", (_event, error: string) => {
				forget();
				this.save({
					status: /UNErrorDomain error 1\b|not allowed/i.test(error)
						? "blocked"
						: "failed",
					missed: this.state.missed + 1,
					lastError: error,
					at: new Date().toISOString(),
				});
				this.log("notification not shown", { error });
				done("blocked");
			});
			n.show();
		});
	}
}

/** System Settings › Notifications, at this app's entry when macOS lists it. */
export const NOTIFICATION_SETTINGS_URL =
	"x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=app.offerfinch.desktop";
