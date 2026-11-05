import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	applyRestore,
	BackupError,
	createBackup,
	MANIFEST,
	RESTORE_JOURNAL,
	recoverInterruptedRestore,
	STAGING,
	stageRestore,
} from "../src/main/backup";
import { DB_FILE } from "../src/main/database-file";
import { createZipTools } from "../src/main/zip";

const folder = (name: string) =>
	fs.mkdtempSync(path.join(os.tmpdir(), `of-backup-${name}-`));

const KNOWN = { migrations: ["0001_init"], companyKeyVersion: 2 };

/** A data folder like the app's: a WAL database with a few jobs, files, keys, sessions. */
function dataFolder(name: string, jobs: string[]) {
	const dir = folder(name);
	const db = new Database(path.join(dir, DB_FILE));
	db.pragma("journal_mode = WAL");
	db.exec(
		"create table __migrations (name text primary key, applied_at integer not null);" +
			"insert into __migrations values ('0001_init', 1), ('company_name_key_v2', 2);" +
			"create table jobs (id integer primary key, title text);" +
			"create table app_settings (key text primary key, value text not null, updated_at integer not null);" +
			`insert into app_settings values ('siteSessions', '{"linkedin":{"signedInAt":"x","needsSignIn":false}}', 1), ('ai', '{}', 1);`,
	);
	const insert = db.prepare("insert into jobs (title) values (?)");
	for (const title of jobs) insert.run(title);
	db.close();
	fs.mkdirSync(path.join(dir, "files", "documents"), { recursive: true });
	fs.writeFileSync(path.join(dir, "files", "documents", "cv.pdf"), name);
	fs.writeFileSync(path.join(dir, "secrets.json"), '{"anthropic":"sealed"}');
	fs.mkdirSync(path.join(dir, "Partitions", "site-linkedin"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(dir, "Partitions", "site-linkedin", "Cookies"),
		"c",
	);
	return dir;
}

const titles = (file: string) => {
	const db = new Database(file, { readonly: true });
	try {
		return (
			db.prepare("select title from jobs order by id").all() as {
				title: string;
			}[]
		).map((r) => r.title);
	} finally {
		db.close();
	}
};

const unzip = (zip: string) => {
	const out = folder("unzip");
	execFileSync("/usr/bin/ditto", ["-x", "-k", zip, out]);
	return out;
};

async function backupOf(dir: string) {
	const zip = path.join(folder("out"), "backup.zip");
	const manifest = await createBackup({
		userData: dir,
		dbFile: path.join(dir, DB_FILE),
		target: zip,
		appVersion: "0.1.0",
	});
	return { zip, manifest };
}

describe("backup", () => {
	it("holds a consistent database copy, the files and a manifest, and no keys or sessions", async () => {
		const dir = dataFolder("a", ["Designer at Example Co", "Engineer at Acme"]);
		// The worker holds the database open and has rows only in its WAL.
		const live = new Database(path.join(dir, DB_FILE));
		live.pragma("wal_autocheckpoint = 0");
		live.prepare("insert into jobs (title) values (?)").run("Only in the WAL");
		const { zip, manifest } = await backupOf(dir);
		live.close();
		const out = unzip(zip);
		expect(fs.readdirSync(out).sort()).toEqual(
			[DB_FILE, "files", MANIFEST].sort(),
		);
		expect(titles(path.join(out, DB_FILE))).toEqual([
			"Designer at Example Co",
			"Engineer at Acme",
			"Only in the WAL",
		]);
		expect(
			fs.readFileSync(path.join(out, "files", "documents", "cv.pdf"), "utf8"),
		).toBe("a");
		expect(manifest.tables.jobs).toBe(3);
		expect(manifest.schema.latest).toBe("company_name_key_v2");
		expect(manifest.files).toEqual({ count: 1, bytes: 1 });
		// Sign-in state of site tabs describes this Mac's sessions, which stay behind.
		const copy = new Database(path.join(out, DB_FILE), { readonly: true });
		expect(copy.prepare("select key from app_settings").all()).toEqual([
			{ key: "ai" },
		]);
		copy.close();
		expect(fs.existsSync(path.join(dir, STAGING))).toBe(true);
		expect(fs.readdirSync(path.join(dir, STAGING))).toEqual([]);
	});
});

describe("checking a backup before restoring", () => {
	it("accepts its own backup and says what is in it", async () => {
		const { zip } = await backupOf(dataFolder("a", ["One", "Two"]));
		const target = dataFolder("b", []);
		const staged = await stageRestore({
			userData: target,
			zipFile: zip,
			known: KNOWN,
		});
		expect(staged.summary).toMatchObject({ jobs: 2, files: 1 });
	});

	it("refuses a damaged zip and leaves no staging behind", async () => {
		const { zip } = await backupOf(dataFolder("a", ["One"]));
		const bytes = fs.readFileSync(zip);
		fs.writeFileSync(zip, bytes.subarray(0, Math.floor(bytes.length / 2)));
		const target = dataFolder("b", []);
		await expect(
			stageRestore({ userData: target, zipFile: zip, known: KNOWN }),
		).rejects.toThrow(/damaged/);
		expect(fs.readdirSync(path.join(target, STAGING))).toEqual([]);
	});

	it("refuses a zip with a path out of the staging folder or a symlink, writing nothing outside", async () => {
		const outsideDir = folder("outside");
		const evil = path.join(folder("evil"), "evil.zip");
		execFileSync("python3", [
			"-I",
			"-c",
			[
				"import sys, stat, zipfile",
				"z = zipfile.ZipFile(sys.argv[1], 'w')",
				"z.writestr('../../escape.txt', 'x')",
				"z.writestr('manifest.json', '{}')",
				"i = zipfile.ZipInfo('files/link')",
				"i.external_attr = (stat.S_IFLNK | 0o777) << 16",
				"z.writestr(i, sys.argv[2])",
				"z.writestr('files/link/inner.txt', 'y')",
				"z.close()",
			].join("\n"),
			evil,
			outsideDir,
		]);
		const target = dataFolder("b", []);
		await expect(
			stageRestore({ userData: target, zipFile: evil, known: KNOWN }),
		).rejects.toThrow(/damaged/);
		expect(fs.readdirSync(outsideDir)).toEqual([]);
		expect(fs.existsSync(path.join(target, "escape.txt"))).toBe(false);
		expect(fs.readdirSync(path.join(target, STAGING))).toEqual([]);
	});

	it("refuses a zip whose database does not match its manifest", async () => {
		const { zip } = await backupOf(dataFolder("a", ["One"]));
		const out = unzip(zip);
		const db = new Database(path.join(out, DB_FILE));
		db.prepare("delete from jobs").run();
		db.close();
		const tampered = path.join(folder("t"), "t.zip");
		execFileSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", out, tampered]);
		await expect(
			stageRestore({
				userData: dataFolder("b", []),
				zipFile: tampered,
				known: KNOWN,
			}),
		).rejects.toThrow(/damaged/);
	});

	it("refuses a backup made by a newer schema", async () => {
		const source = dataFolder("a", ["One"]);
		const db = new Database(path.join(source, DB_FILE));
		db.prepare("insert into __migrations values ('0002_future', 3)").run();
		db.close();
		const { zip } = await backupOf(source);
		await expect(
			stageRestore({
				userData: dataFolder("b", []),
				zipFile: zip,
				known: KNOWN,
			}),
		).rejects.toThrow(/newer version/);
	});

	it("refuses a newer backup format", async () => {
		const { zip } = await backupOf(dataFolder("a", ["One"]));
		const out = unzip(zip);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(out, MANIFEST), "utf8"),
		);
		fs.writeFileSync(
			path.join(out, MANIFEST),
			JSON.stringify({ ...manifest, format: 99 }),
		);
		const newer = path.join(folder("n"), "n.zip");
		execFileSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", out, newer]);
		await expect(
			stageRestore({
				userData: dataFolder("b", []),
				zipFile: newer,
				known: KNOWN,
			}),
		).rejects.toBeInstanceOf(BackupError);
	});
});

// Exercise the restore's real layout, manifest and database checks on a tar-written zip.
describe.skipIf(process.platform !== "darwin")(
	"Windows zip restore compatibility",
	() => {
		it("stages a real backup repacked by bsdtar to a .partial name", async () => {
			const { zip } = await backupOf(dataFolder("tar", ["Sample role"]));
			const source = unzip(zip);
			const partial = path.join(folder("tar-out"), "backup.zip.partial");
			await createZipTools({ platform: "win32", tar: "/usr/bin/tar" }).create(
				source,
				partial,
			);
			const staged = await stageRestore({
				userData: dataFolder("target", []),
				zipFile: partial,
				known: KNOWN,
			});
			expect(staged.summary).toMatchObject({ jobs: 1, files: 1 });
			expect(titles(path.join(staged.dir, DB_FILE))).toEqual(["Sample role"]);
		});
	},
);

describe("restoring", () => {
	const restoreInto = async (
		target: string,
		zip: string,
		fault?: Parameters<typeof applyRestore>[0]["fault"],
	) => {
		const started: string[] = [];
		const staged = await stageRestore({
			userData: target,
			zipFile: zip,
			known: KNOWN,
		});
		const result = applyRestore({
			userData: target,
			dbFile: path.join(target, DB_FILE),
			staged,
			appVersion: "0.1.0",
			stopWorker: async () => {},
			startWorker: async (file) => {
				started.push(file);
			},
			fault,
		});
		return { result, started };
	};

	it("replaces the database and files, keeps keys and sessions, and makes a safety backup", async () => {
		const { zip } = await backupOf(dataFolder("a", ["From A"]));
		const target = dataFolder("b", ["From B"]);
		const { result, started } = await restoreInto(target, zip);
		const { safetyBackup } = await result;
		expect(titles(path.join(target, DB_FILE))).toEqual(["From A"]);
		expect(
			fs.readFileSync(
				path.join(target, "files", "documents", "cv.pdf"),
				"utf8",
			),
		).toBe("a");
		expect(fs.readFileSync(path.join(target, "secrets.json"), "utf8")).toBe(
			'{"anthropic":"sealed"}',
		);
		expect(
			fs.existsSync(
				path.join(target, "Partitions", "site-linkedin", "Cookies"),
			),
		).toBe(true);
		expect(started).toEqual([path.join(target, DB_FILE)]);
		expect(titles(path.join(unzip(safetyBackup), DB_FILE))).toEqual(["From B"]);
		expect(fs.existsSync(path.join(target, RESTORE_JOURNAL))).toBe(false);
		expect(fs.readdirSync(path.join(target, STAGING))).toEqual([]);
	});

	for (const step of ["aside", "placed", "started"] as const)
		it(`leaves the current data as it was when it fails at "${step}"`, async () => {
			const { zip } = await backupOf(dataFolder("a", ["From A"]));
			const target = dataFolder("b", ["From B"]);
			const { result, started } = await restoreInto(target, zip, (at) => {
				if (at === step) throw new Error(`disk full at ${at}`);
			});
			await expect(result).rejects.toThrow(/left as it was/);
			expect(titles(path.join(target, DB_FILE))).toEqual(["From B"]);
			expect(
				fs.readFileSync(
					path.join(target, "files", "documents", "cv.pdf"),
					"utf8",
				),
			).toBe("b");
			expect(started.at(-1)).toBe(path.join(target, DB_FILE));
			expect(fs.existsSync(path.join(target, RESTORE_JOURNAL))).toBe(false);
		});

	it("restores nothing when the safety backup cannot be made", async () => {
		const { zip } = await backupOf(dataFolder("a", ["From A"]));
		const target = dataFolder("b", ["From B"]);
		const { result } = await restoreInto(target, zip, (at) => {
			if (at === "safety") throw new Error("no room");
		});
		await expect(result).rejects.toThrow(/safety copy/);
		expect(titles(path.join(target, DB_FILE))).toEqual(["From B"]);
	});

	it("undoes a restore the app quit in the middle of, at the next start", async () => {
		const { zip } = await backupOf(dataFolder("a", ["From A"]));
		const target = dataFolder("b", ["From B"]);
		const staged = await stageRestore({
			userData: target,
			zipFile: zip,
			known: KNOWN,
		});
		// The state a crash leaves after the swap: B's data aside, A's in place, the journal.
		const aside = fs.mkdtempSync(path.join(target, STAGING, "previous-"));
		fs.writeFileSync(
			path.join(target, RESTORE_JOURNAL),
			JSON.stringify({
				aside,
				staged: staged.dir,
				existed: {
					[DB_FILE]: true,
					[`${DB_FILE}-wal`]: false,
					[`${DB_FILE}-shm`]: false,
					files: true,
				},
			}),
		);
		for (const item of [DB_FILE, "files"])
			fs.renameSync(path.join(target, item), path.join(aside, item));
		for (const item of [DB_FILE, "files"])
			fs.renameSync(path.join(staged.dir, item), path.join(target, item));
		// The restored worker had started and written a WAL.
		fs.writeFileSync(path.join(target, `${DB_FILE}-wal`), "");
		expect(titles(path.join(target, DB_FILE))).toEqual(["From A"]);
		expect(recoverInterruptedRestore(target, () => {})).toBe(true);
		// The restored database's WAL went with it (read before opening B, which makes its own).
		expect(fs.existsSync(path.join(target, `${DB_FILE}-wal`))).toBe(false);
		expect(titles(path.join(target, DB_FILE))).toEqual(["From B"]);
		expect(
			fs.readFileSync(
				path.join(target, "files", "documents", "cv.pdf"),
				"utf8",
			),
		).toBe("b");
		expect(fs.existsSync(path.join(target, RESTORE_JOURNAL))).toBe(false);
		expect(fs.existsSync(path.join(target, STAGING))).toBe(false);
	});
});

describe("an unreadable restore journal", () => {
	it("changes nothing, keeps the work folder and lets the app start", () => {
		for (const journal of [
			"",
			"{not json",
			JSON.stringify({ aside: 1, staged: "x", existed: {} }),
			JSON.stringify({
				aside: "/tmp/x",
				staged: "/tmp/y",
				existed: { "../outside": false },
			}),
		]) {
			const target = dataFolder("journal", ["Mine"]);
			const work = path.join(target, STAGING, "previous-1");
			fs.mkdirSync(work, { recursive: true });
			fs.writeFileSync(path.join(work, "kept"), "the earlier data");
			fs.writeFileSync(path.join(target, RESTORE_JOURNAL), journal);
			const said: string[] = [];
			expect(recoverInterruptedRestore(target, (m) => said.push(m))).toBe(
				false,
			);
			expect(titles(path.join(target, DB_FILE))).toEqual(["Mine"]);
			expect(fs.readFileSync(path.join(work, "kept"), "utf8")).toBe(
				"the earlier data",
			);
			expect(fs.existsSync(path.join(target, RESTORE_JOURNAL))).toBe(false);
			expect(
				fs
					.readdirSync(target)
					.some((f) => f.startsWith(`${RESTORE_JOURNAL}.unreadable-`)),
			).toBe(true);
			expect(said.join(" ")).toMatch(/could not be read/);
		}
	});
});
