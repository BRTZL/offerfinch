import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, dialog } from "electron";
import type {
	BackupSaveResult,
	RestoreCheck,
	RestoreResult,
} from "../shared/bridge";
import {
	applyRestore,
	BackupError,
	createBackup,
	type StagedRestore,
	stageRestore,
} from "./backup";
import { BACKUP_RUNNING, lifecycle } from "./lifecycle";
import { log, mainState } from "./state";

/** Unpacked backups waiting for the user's yes, by id. Only one at a time is kept. */
const waiting = new Map<string, StagedRestore>();

const message = (error: unknown) =>
	error instanceof BackupError
		? error.message
		: `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;

function discardAll() {
	for (const staged of waiting.values())
		fs.rmSync(staged.dir, { recursive: true, force: true });
	waiting.clear();
}

/**
 * One backup or restore at a time, never while try-it mode switches (main/lifecycle.ts): a
 * second click waits for nothing and is refused.
 */
export async function saveBackup(): Promise<BackupSaveResult> {
	// Held from the dialog on: a second action started while it is open is refused.
	const hold = lifecycle.take(BACKUP_RUNNING);
	if ("busy" in hold) return { status: "failed", error: hold.busy };
	try {
		const target = await dialog.showSaveDialog({
			defaultPath: path.join(
				app.getPath("downloads"),
				`offerfinch-backup-${new Date().toISOString().slice(0, 10)}.zip`,
			),
			filters: [{ name: "OfferFinch backup", extensions: ["zip"] }],
		});
		if (target.canceled || !target.filePath) return { status: "canceled" };
		const manifest = await createBackup({
			userData: app.getPath("userData"),
			dbFile: mainState.databaseFile,
			target: target.filePath,
			appVersion: app.getVersion(),
		});
		log("backup saved", { tables: Object.keys(manifest.tables).length });
		return { status: "saved", name: path.basename(target.filePath) };
	} catch (error) {
		log("backup failed", String(error));
		return { status: "failed", error: message(error) };
	} finally {
		hold.release();
	}
}

export async function checkBackup(): Promise<RestoreCheck> {
	const hold = lifecycle.take(BACKUP_RUNNING);
	if ("busy" in hold) return { status: "refused", error: hold.busy };
	try {
		const chosen = await dialog.showOpenDialog({
			properties: ["openFile"],
			filters: [{ name: "OfferFinch backup", extensions: ["zip"] }],
		});
		const file = chosen.filePaths[0];
		if (chosen.canceled || !file) return { status: "canceled" };
		discardAll();
		const staged = await stageRestore({
			userData: app.getPath("userData"),
			zipFile: file,
		});
		const id = randomUUID();
		waiting.set(id, staged);
		return { status: "ready", id, summary: staged.summary };
	} catch (error) {
		log("backup refused", String(error));
		return { status: "refused", error: message(error) };
	} finally {
		hold.release();
	}
}

export function discardBackup(id: string): void {
	const staged = waiting.get(id);
	waiting.delete(id);
	if (staged) fs.rmSync(staged.dir, { recursive: true, force: true });
}

export async function restoreBackup(id: string): Promise<RestoreResult> {
	const staged = waiting.get(id);
	if (!staged)
		return {
			status: "failed",
			error: "Choose the backup again: it is no longer ready to restore.",
		};
	// Refused before the staged backup is taken, so the same restore can be tried again.
	const hold = lifecycle.take(BACKUP_RUNNING);
	if ("busy" in hold) return { status: "failed", error: hold.busy };
	waiting.delete(id);
	try {
		const result = await applyRestore({
			userData: app.getPath("userData"),
			dbFile: mainState.databaseFile,
			staged,
			appVersion: app.getVersion(),
			// Its exit lets go of the site tabs its runs held (site-wiring.ts).
			stopWorker: () => mainState.worker.stop(),
			startWorker: async (dbFile) => {
				mainState.databaseFile = dbFile;
				await mainState.worker.restart();
			},
		});
		log("backup restored", {
			safetyBackup: path.basename(result.safetyBackup),
		});
		return { status: "restored", safetyBackup: result.safetyBackup };
	} catch (error) {
		log("restore failed", String(error));
		fs.rmSync(staged.dir, { recursive: true, force: true });
		return { status: "failed", error: message(error) };
	} finally {
		hold.release();
	}
}
