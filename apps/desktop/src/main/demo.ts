import fs from "node:fs";
import path from "node:path";
import { DB_FILE } from "./database-file";

/**
 * Try-it mode's data (docs/decisions.md, 2026-11-05): a folder of its own inside the app's data
 * folder, with its own database and files. The worker is started on it instead of the real
 * database, so nothing real is read or written while it runs; leaving deletes the folder.
 */
export const DEMO_DIR = "demo";

/** The demo folder: always `<userData>/demo`, never anything else. */
export function demoFolder(userData: string): string {
	return path.join(path.resolve(userData), DEMO_DIR);
}

/**
 * Deletes the demo folder and everything in it. Only ever that folder: the path is checked to
 * be `demo` directly inside the data folder before anything is removed.
 */
export function eraseDemo(userData: string): boolean {
	const root = path.resolve(userData);
	const folder = demoFolder(root);
	if (path.dirname(folder) !== root || path.basename(folder) !== DEMO_DIR)
		throw new Error(`Refused to erase ${folder}: not the demo folder`);
	if (!fs.existsSync(folder)) return false;
	fs.rmSync(folder, { recursive: true, force: true });
	return true;
}

/** What the switch changes: main's state (`mainState`), or a test's. */
export interface DemoState {
	/** The worker starts on the demo data (`workerInit` reads it). */
	demo: boolean;
	/** The database the worker opens. */
	databaseFile: string;
	/** The real database while demo runs (restored exactly on leaving), else null. */
	realDatabaseFile: string | null;
	/**
	 * Leaving did not finish (the real worker did not start): why. The demo's data is gone and
	 * `demo` is already false, so another leave only starts the real worker again. Null when
	 * no leave is unfinished.
	 */
	leaveFailed: string | null;
}

export interface DemoSwitch {
	userData: string;
	/** Stops the worker and waits until its process has exited (rejects if it does not). */
	stopWorker: () => Promise<void>;
	/** Starts the worker on `state.databaseFile` (in demo mode when `state.demo`). */
	startWorker: () => Promise<void>;
	log?: (message: string, data?: unknown) => void;
}

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * Into try-it mode: the worker stops (closing the real database), a fresh demo folder is made,
 * and the worker starts again on the demo database, which it fills with the sample data. If
 * the demo worker does not start, the app leaves the demo again (the real worker starts) and
 * the error is passed on; if that fails too, `leaveFailed` says so and Leave tries again.
 */
export async function enterDemo(
	state: DemoState,
	sw: DemoSwitch,
): Promise<void> {
	if (state.demo) return;
	if (state.leaveFailed !== null)
		throw new Error("Leaving the demo did not finish: leave it first.");
	await sw.stopWorker();
	eraseDemo(sw.userData);
	const folder = demoFolder(sw.userData);
	fs.mkdirSync(folder, { recursive: true });
	state.realDatabaseFile = state.databaseFile;
	state.databaseFile = path.join(folder, DB_FILE);
	state.demo = true;
	try {
		await sw.startWorker();
		sw.log?.("demo mode started");
	} catch (error) {
		sw.log?.("demo mode did not start", String(error));
		await leaveDemo(state, sw).catch(() => {});
		throw error;
	}
}

/**
 * Out of try-it mode: the worker stops (its process has exited, so the demo database is
 * closed), the demo folder is deleted, and the worker starts again on the real database, the
 * same file as before. Until that worker has started, `leaveFailed` is set: a failed leave is
 * tried again by calling this again, which starts the real worker anew.
 */
export async function leaveDemo(
	state: DemoState,
	sw: DemoSwitch,
): Promise<void> {
	if (!state.demo && state.leaveFailed === null) return;
	// A worker that does not stop leaves everything as it was: still in the demo.
	await sw.stopWorker();
	state.leaveFailed = "Leaving the demo did not finish.";
	state.demo = false;
	state.databaseFile = state.realDatabaseFile ?? state.databaseFile;
	state.realDatabaseFile = null;
	try {
		eraseDemo(sw.userData);
		await sw.startWorker();
	} catch (error) {
		state.leaveFailed = messageOf(error);
		sw.log?.("leaving demo mode did not finish", state.leaveFailed);
		throw error;
	}
	state.leaveFailed = null;
	sw.log?.("demo mode left; its data was deleted");
}
