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
	demo: boolean;
	/** The database the worker opens. */
	databaseFile: string;
	/** The real database while demo runs (restored exactly on leaving), else null. */
	realDatabaseFile: string | null;
}

export interface DemoSwitch {
	userData: string;
	/** Stops the worker and waits until it has closed its database. */
	stopWorker: () => Promise<void>;
	/** Starts the worker on `state.databaseFile` (in demo mode when `state.demo`). */
	startWorker: () => Promise<void>;
	log?: (message: string, data?: unknown) => void;
}

/**
 * Into try-it mode: the worker stops (closing the real database), a fresh demo folder is made,
 * and the worker starts again on the demo database, which it fills with the sample data. If
 * the demo worker does not start, the real one is started again and the error is passed on.
 */
export async function enterDemo(
	state: DemoState,
	sw: DemoSwitch,
): Promise<void> {
	if (state.demo) return;
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
		await sw.stopWorker();
		state.demo = false;
		state.databaseFile = state.realDatabaseFile;
		state.realDatabaseFile = null;
		eraseDemo(sw.userData);
		await sw.startWorker();
		throw error;
	}
}

/**
 * Out of try-it mode: the worker stops (closing the demo database), the demo folder is deleted,
 * and the worker starts again on the real database, the same file as before.
 */
export async function leaveDemo(
	state: DemoState,
	sw: DemoSwitch,
): Promise<void> {
	if (!state.demo) return;
	await sw.stopWorker();
	state.demo = false;
	state.databaseFile = state.realDatabaseFile ?? state.databaseFile;
	state.realDatabaseFile = null;
	eraseDemo(sw.userData);
	await sw.startWorker();
	sw.log?.("demo mode left; its data was deleted");
}
