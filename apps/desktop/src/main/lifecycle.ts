/**
 * One lock for everything that changes which data the worker runs on, or reads it as a whole
 * (docs/decisions.md, 2026-11-05): entering and leaving try-it mode, a restore, a backup. They
 * run one at a time, alone. Saving or removing an API key holds it too, shared: keys may be
 * saved side by side, never while the worker is being switched. A conflicting operation is
 * refused before it begins, never queued, with the running one's reason.
 */
class LifecycleLock {
	/** The refusal the running exclusive operation gives others; null when none runs. */
	private running: string | null = null;
	private shared = 0;

	/** Takes the lock alone: refused (the reason returned) while anything else holds it. */
	take(refusal: string): { release: () => void } | { busy: string } {
		if (this.running) return { busy: this.running };
		if (this.shared > 0) return { busy: KEY_SAVE_RUNNING };
		this.running = refusal;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.running = null;
			},
		};
	}

	/** Takes a shared hold (key saves): refused only while an exclusive operation runs. */
	share(): { release: () => void } | { busy: string } {
		if (this.running) return { busy: this.running };
		this.shared++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.shared--;
			},
		};
	}
}

const KEY_SAVE_RUNNING = "An API key is being saved. Try again in a moment.";

export const BACKUP_RUNNING = "A backup or restore is running.";
export const DEMO_SWITCHING =
	"The app is switching to or from the sample data. Try again in a moment.";

/** The app's one lock (main/backup-actions.ts, demo-actions.ts, ipc.ts). */
export const lifecycle = new LifecycleLock();
