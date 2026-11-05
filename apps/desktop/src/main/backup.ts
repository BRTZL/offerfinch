import fs from "node:fs";
import path from "node:path";
import { COMPANY_NAME_KEY_VERSION } from "@offerfinch/core/domain/url";
import { MIGRATIONS } from "@offerfinch/db/migrations/index";
import Database from "better-sqlite3";
import type { BackupSummary } from "../shared/bridge";
import { DB_FILE } from "./database-file";
import { zipTools } from "./zip";

/**
 * A backup is one zip: `manifest.json`, `offerfinch.sqlite` (a consistent copy made with
 * `VACUUM INTO`, never the live file) and `files/` (profile files, documents, PDFs, proofs).
 * API keys (`secrets.json`), site sign-ins (session partitions), logs, debug snapshots and the
 * migration backups stay out. The platform's built-in zip tools add no dependency.
 */
const BACKUP_FORMAT = 1;
export const MANIFEST = "manifest.json";
const FILES = "files";
/** Work folders, inside the app's data folder so the final swap is a rename on one volume. */
export const STAGING = "staging";
/** Written before a restore moves anything, removed once the restored data has started. */
export const RESTORE_JOURNAL = "restore-journal.json";

/**
 * Settings rows that describe this Mac, not the user's data: the sign-in state of site tabs
 * (their sessions are not in the backup), the login shell's PATH and stalled-step counters.
 */
const MACHINE_SETTINGS = ["siteSessions", "shellPath", "stalls"];

export interface BackupManifest {
	format: number;
	app: "OfferFinch";
	appVersion: string;
	createdAt: string;
	/** The migrations the database copy has applied; the newest decides who can restore it. */
	schema: { migrations: string[]; latest: string | null };
	/** Rows in every table of the copy. */
	tables: Record<string, number>;
	files: { count: number; bytes: number };
}

/** A backup that cannot be used, with a sentence the user can act on. */
export class BackupError extends Error {}

const DAMAGED =
	"This file is not an OfferFinch backup, or it is damaged. Nothing was changed.";

function rowCounts(db: Database.Database): Record<string, number> {
	const tables = db
		.prepare(
			"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
		)
		.all() as { name: string }[];
	const counts: Record<string, number> = {};
	for (const { name } of tables)
		counts[name] = (
			db
				.prepare(`select count(*) as n from "${name.replaceAll('"', '""')}"`)
				.get() as { n: number }
		).n;
	return counts;
}

function appliedMigrations(db: Database.Database): string[] {
	const ledger = db
		.prepare(
			"select 1 from sqlite_master where type = 'table' and name = '__migrations'",
		)
		.get();
	if (!ledger) return [];
	return (
		db.prepare("select name from __migrations order by name").all() as {
			name: string;
		}[]
	).map((r) => r.name);
}

/** Regular files under a folder (a symlink or anything else is refused by the caller). */
function walk(dir: string): { files: string[]; odd: string[] } {
	const files: string[] = [];
	const odd: string[] = [];
	if (!fs.existsSync(dir)) return { files, odd };
	for (const entry of fs.readdirSync(dir, {
		withFileTypes: true,
		recursive: true,
	})) {
		const full = path.join(entry.parentPath, entry.name);
		if (entry.isFile()) files.push(full);
		else if (!entry.isDirectory()) odd.push(full);
	}
	return { files, odd };
}

const totalBytes = (files: string[]) =>
	files.reduce((sum, f) => sum + fs.statSync(f).size, 0);

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

function freshStaging(userData: string, kind: string, now: Date): string {
	const parent = path.join(userData, STAGING);
	fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
	return fs.mkdtempSync(path.join(parent, `${kind}-${stamp(now)}-`));
}

export interface CreateBackupOptions {
	userData: string;
	/** The live database (the worker may hold it open: WAL lets this second reader copy it). */
	dbFile: string;
	/** Where the zip goes. Written beside it first, then renamed, so no half zip is left there. */
	target: string;
	appVersion: string;
	now?: () => Date;
}

/**
 * Makes one backup zip. The database is copied first, then the files, so every file the copy
 * points at is in the zip (a file added in between is extra, which is harmless).
 */
export async function createBackup(
	options: CreateBackupOptions,
): Promise<BackupManifest> {
	const now = options.now?.() ?? new Date();
	const staging = freshStaging(options.userData, "export", now);
	try {
		const copy = path.join(staging, DB_FILE);
		const live = new Database(options.dbFile, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			// The worker may be writing: wait for its lock instead of failing at once.
			live.pragma("busy_timeout = 10000");
			live.prepare("vacuum into ?").run(copy);
		} finally {
			live.close();
		}
		const db = new Database(copy);
		let tables: Record<string, number>;
		let migrations: string[];
		try {
			db.prepare(
				`delete from app_settings where key in (${MACHINE_SETTINGS.map(() => "?").join(", ")})`,
			).run(...MACHINE_SETTINGS);
			// The deleted rows' bytes stay in free pages until a vacuum: rewrite the copy.
			db.exec("vacuum");
			tables = rowCounts(db);
			migrations = appliedMigrations(db);
		} finally {
			db.close();
		}
		const source = path.join(options.userData, FILES);
		const { files } = walk(source);
		for (const file of files) {
			const to = path.join(staging, FILES, path.relative(source, file));
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(file, to);
		}
		const manifest: BackupManifest = {
			format: BACKUP_FORMAT,
			app: "OfferFinch",
			appVersion: options.appVersion,
			createdAt: now.toISOString(),
			schema: { migrations, latest: migrations.at(-1) ?? null },
			tables,
			files: { count: files.length, bytes: totalBytes(files) },
		};
		fs.writeFileSync(
			path.join(staging, MANIFEST),
			JSON.stringify(manifest, null, 2),
		);
		const partial = `${options.target}.partial`;
		fs.rmSync(partial, { force: true });
		try {
			// --norsrc: no AppleDouble or __MACOSX entries, so the zip holds only these three.
			await zipTools.create(staging, partial);
			fs.renameSync(partial, options.target);
		} catch (error) {
			fs.rmSync(partial, { force: true });
			throw error;
		}
		fs.chmodSync(options.target, 0o600);
		return manifest;
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

/** The schema this app knows: anything else in a backup's ledger is from a newer version. */
export interface KnownSchema {
	migrations: string[];
	companyKeyVersion: number;
}

const THIS_APP: KnownSchema = {
	migrations: MIGRATIONS.map((m) => m.name),
	companyKeyVersion: COMPANY_NAME_KEY_VERSION,
};

function isKnown(name: string, known: KnownSchema): boolean {
	if (known.migrations.includes(name)) return true;
	const key = /^company_name_key_v(\d+)$/.exec(name);
	return Boolean(key && Number(key[1]) <= known.companyKeyVersion);
}

export interface StagedRestore {
	dir: string;
	manifest: BackupManifest;
	summary: BackupSummary;
}

const damaged = () => new BackupError(DAMAGED);

/** Only the three entries a backup has, and no symlink or device file among the files. */
function checkLayout(dir: string): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const ok =
			(entry.name === MANIFEST && entry.isFile()) ||
			(entry.name === DB_FILE && entry.isFile()) ||
			(entry.name === FILES && entry.isDirectory());
		if (!ok) throw damaged();
	}
	if (!fs.existsSync(path.join(dir, DB_FILE))) throw damaged();
	const { files, odd } = walk(path.join(dir, FILES));
	if (odd.length > 0) throw damaged();
	return files;
}

function readManifest(dir: string): BackupManifest {
	let manifest: BackupManifest;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
	} catch {
		throw damaged();
	}
	if (manifest?.app !== "OfferFinch" || typeof manifest.format !== "number")
		throw damaged();
	if (manifest.format > BACKUP_FORMAT)
		throw new BackupError(
			`This backup was made by a newer version of OfferFinch (${manifest.appVersion}). Update OfferFinch, then restore it. Nothing was changed.`,
		);
	return manifest;
}

/** The database itself: intact, and made by a schema this app knows. Returns its row counts. */
function checkDatabase(
	file: string,
	manifest: BackupManifest,
	known: KnownSchema,
): Record<string, number> {
	const db = new Database(file, { readonly: true, fileMustExist: true });
	try {
		let integrity: unknown;
		try {
			integrity = db.pragma("integrity_check", { simple: true });
		} catch {
			throw damaged();
		}
		if (integrity !== "ok") throw damaged();
		const applied = appliedMigrations(db);
		if (applied.some((name) => !isKnown(name, known)))
			throw new BackupError(
				`This backup was made by a newer version of OfferFinch (${manifest.appVersion}), with changes to the data this version does not know. Update OfferFinch, then restore it. Nothing was changed.`,
			);
		if (applied.length === 0) throw damaged();
		return rowCounts(db);
	} finally {
		db.close();
	}
}

/**
 * Unzips a backup into a staging folder and checks it before anything is replaced: the zip
 * opens, holds only a manifest, a database and files, the database passes `integrity_check`,
 * holds the rows and files the manifest lists, and was made by a schema this app knows. A
 * refusal removes the staging folder and throws a BackupError.
 */
export async function stageRestore(options: {
	userData: string;
	zipFile: string;
	known?: KnownSchema;
	now?: () => Date;
}): Promise<StagedRestore> {
	const dir = freshStaging(
		options.userData,
		"restore",
		options.now?.() ?? new Date(),
	);
	try {
		try {
			await zipTools.extract(options.zipFile, dir);
		} catch {
			throw damaged();
		}
		const files = checkLayout(dir);
		const manifest = readManifest(dir);
		const tables = checkDatabase(
			path.join(dir, DB_FILE),
			manifest,
			options.known ?? THIS_APP,
		);
		const bytes = totalBytes(files);
		if (
			JSON.stringify(tables) !== JSON.stringify(manifest.tables) ||
			files.length !== manifest.files?.count ||
			bytes !== manifest.files?.bytes
		)
			throw damaged();
		return {
			dir,
			manifest,
			summary: {
				createdAt: manifest.createdAt,
				appVersion: manifest.appVersion,
				jobs: tables.jobs ?? 0,
				applications: tables.applications ?? 0,
				documents: tables.documents ?? 0,
				answers: tables.profile_facts ?? 0,
				files: files.length,
				bytes,
			},
		};
	} catch (error) {
		fs.rmSync(dir, { recursive: true, force: true });
		if (error instanceof BackupError) throw error;
		throw damaged();
	}
}

/**
 * What a restore moves: the database (under the name in use and the current name, each with
 * its WAL and shared-memory files) and the files folder. `existed` is taken before anything
 * moves, so a rollback knows what was the user's and what came from the backup.
 */
interface Journal {
	aside: string;
	staged: string;
	existed: Record<string, boolean>;
}

const sqliteTrio = (name: string) => [name, `${name}-wal`, `${name}-shm`];

function items(dbFile: string): string[] {
	return [
		...new Set([...sqliteTrio(path.basename(dbFile)), ...sqliteTrio(DB_FILE)]),
		FILES,
	];
}

/**
 * Puts the user's data back as it was before a restore started: every item that was set aside
 * goes back over whatever is in its place, and anything the restore added where nothing was is
 * removed. Safe to run more than once, and after a crash at any step.
 */
function rollBack(userData: string, journal: Journal) {
	for (const [item, existed] of Object.entries(journal.existed)) {
		const here = path.join(userData, item);
		const aside = path.join(journal.aside, item);
		if (existed) {
			// Not moved yet: what is here is still the user's own.
			if (!fs.existsSync(aside)) continue;
			fs.rmSync(here, { recursive: true, force: true });
			fs.renameSync(aside, here);
		} else fs.rmSync(here, { recursive: true, force: true });
	}
}

/** Written to disk before the rename (fsync), so a power cut never leaves an empty journal. */
function writeJournal(userData: string, journal: Journal) {
	const file = path.join(userData, RESTORE_JOURNAL);
	const fd = fs.openSync(`${file}.tmp`, "w");
	try {
		fs.writeSync(fd, JSON.stringify(journal));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(`${file}.tmp`, file);
}

/** A journal this app wrote, or null: anything else is never acted on. */
function readJournal(file: string): Journal | null {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Journal>;
		if (
			typeof value.aside !== "string" ||
			typeof value.staged !== "string" ||
			!value.existed ||
			typeof value.existed !== "object" ||
			Object.values(value.existed).some((v) => typeof v !== "boolean") ||
			// Item names in the data folder only: never a path out of it.
			Object.keys(value.existed).some(
				(k) => !k || k === "." || k === ".." || /[/\\]/.test(k),
			)
		)
			return null;
		return value as Journal;
	} catch {
		return null;
	}
}

export interface ApplyRestoreOptions {
	userData: string;
	/** The database file in use now (the earlier name if it was never moved). */
	dbFile: string;
	staged: StagedRestore;
	appVersion: string;
	/** Stops the worker and waits until it has closed the database. */
	stopWorker: () => Promise<void>;
	/** Starts the worker on this database; resolves once it is ready, rejects if it fails. */
	startWorker: (dbFile: string) => Promise<void>;
	now?: () => Date;
	/** Tests only: fail at a step, as a crash or a full disk would. */
	fault?: (step: "safety" | "aside" | "placed" | "started") => void;
}

/**
 * Replaces the data with a staged backup. The worker stops; a safety backup of the current
 * data goes to `backups/` (never pruned); the current database and files are moved aside, the
 * staged ones put in place, and the worker started on them. Any failure before the restored
 * worker is ready puts the current data back and starts the worker on it. Returns the
 * database file in use and the safety backup's path.
 */
export async function applyRestore(
	options: ApplyRestoreOptions,
): Promise<{ dbFile: string; safetyBackup: string }> {
	const { userData } = options;
	const now = options.now?.() ?? new Date();
	const backups = path.join(userData, "backups");
	fs.mkdirSync(backups, { recursive: true });
	const safetyBackup = path.join(backups, `before-restore-${stamp(now)}.zip`);
	await options.stopWorker();
	try {
		options.fault?.("safety");
		await createBackup({
			userData,
			dbFile: options.dbFile,
			target: safetyBackup,
			appVersion: options.appVersion,
			now: () => now,
		});
	} catch (error) {
		await options.startWorker(options.dbFile);
		throw new BackupError(
			`The safety copy of your current data could not be made, so nothing was restored (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	const journal: Journal = {
		aside: fs.mkdtempSync(
			path.join(userData, STAGING, `previous-${stamp(now)}-`),
		),
		staged: options.staged.dir,
		existed: Object.fromEntries(
			items(options.dbFile).map((item) => [
				item,
				fs.existsSync(path.join(userData, item)),
			]),
		),
	};
	const placed = path.join(userData, DB_FILE);
	try {
		writeJournal(userData, journal);
		for (const [item, existed] of Object.entries(journal.existed))
			if (existed)
				fs.renameSync(
					path.join(userData, item),
					path.join(journal.aside, item),
				);
		options.fault?.("aside");
		fs.renameSync(path.join(options.staged.dir, DB_FILE), placed);
		const stagedFiles = path.join(options.staged.dir, FILES);
		if (fs.existsSync(stagedFiles))
			fs.renameSync(stagedFiles, path.join(userData, FILES));
		options.fault?.("placed");
		await options.startWorker(placed);
		options.fault?.("started");
	} catch (error) {
		await options.stopWorker().catch(() => {});
		rollBack(userData, journal);
		fs.rmSync(path.join(userData, RESTORE_JOURNAL), { force: true });
		fs.rmSync(journal.aside, { recursive: true, force: true });
		await options.startWorker(options.dbFile);
		throw new BackupError(
			`The backup could not be restored, so your data was left as it was (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	fs.rmSync(path.join(userData, RESTORE_JOURNAL), { force: true });
	fs.rmSync(journal.aside, { recursive: true, force: true });
	fs.rmSync(options.staged.dir, { recursive: true, force: true });
	return { dbFile: placed, safetyBackup };
}

/**
 * At start, before the database is opened: a restore that did not finish (the app quit or
 * crashed in the middle) is undone, so the user's earlier data is in place and the backup can
 * be restored again. Then leftover work folders are removed. Returns whether it rolled back.
 */
export function recoverInterruptedRestore(
	userData: string,
	log: (message: string, data?: unknown) => void,
): boolean {
	const file = path.join(userData, RESTORE_JOURNAL);
	let rolledBack = false;
	if (fs.existsSync(file)) {
		const journal = readJournal(file);
		if (!journal) {
			// Unreadable: nothing is moved or deleted (the earlier data may be in the work folder);
			// the journal is kept aside for a person to look at, and the app starts.
			fs.renameSync(file, `${file}.unreadable-${Date.now()}`);
			log(
				"an unfinished restore's journal could not be read; nothing was changed, the work folder is kept",
			);
			return false;
		}
		rollBack(userData, journal);
		fs.rmSync(file, { force: true });
		rolledBack = true;
		log("an unfinished restore was undone; the earlier data is in place");
	}
	fs.rmSync(path.join(userData, STAGING), { recursive: true, force: true });
	return rolledBack;
}
