/**
 * One lock for everything that changes which data the worker runs on, or reads it as a whole
 * (docs/decisions.md, 2026-11-05): entering and leaving try-it mode, a restore, a backup. They
 * run one at a time, alone. A conflicting operation is refused before it begins, never queued,
 * with the running one's reason.
 */
class LifecycleLock {
	/** The refusal the running exclusive operation gives others; null when none runs. */
	private running: string | null = null;

	/** Takes the lock alone: refused (the reason returned) while anything else holds it. */
	take(refusal: string): { release: () => void } | { busy: string } {
		if (this.running) return { busy: this.running };
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

	/** The refusal of the exclusive operation running now (which one it is), or null. */
	holder(): string | null {
		return this.running;
	}
}

export const BACKUP_RUNNING = "A backup or restore is running.";
export const DEMO_SWITCHING =
	"The app is switching to or from the sample data. Try again in a moment.";

/** The app's one lock (main/backup-actions.ts, demo-actions.ts, ipc.ts). */
export const lifecycle = new LifecycleLock();
