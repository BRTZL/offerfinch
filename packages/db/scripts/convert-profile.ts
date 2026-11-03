/**
 * One-way conversion of a profile kept as Markdown files (earlier versions of the desktop app)
 * into profile records, in an existing app database. Run it only by hand, with the app quit:
 *
 *   pnpm --filter @offerfinch/cli exec tsx ../../packages/db/scripts/convert-profile.ts \
 *     --db "$HOME/Library/Application Support/OfferFinch/offerfinch.sqlite" [--dry-run]
 *
 * It refuses while any process has the database open. Before writing it applies the pending
 * migrations (each backed up by `migrate`) and copies the whole database next to the other
 * backups; it then converts, renders the records and proves no line of the old files was lost.
 * If one was, it removes the records it wrote, so the app keeps reading the files.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
	missingLines,
	recordsFromFiles,
	renderRecords,
} from "@offerfinch/core/profile/records";
import { eq } from "drizzle-orm";

import { openSqlite } from "../src/client";
import { migrate } from "../src/migrate";
import {
	convertProfileFilesWithBackup,
	listRecords,
} from "../src/profile-records";
import { profileRecords, profiles } from "../src/schema/pipeline";

function arg(name: string): string | undefined {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? undefined : process.argv[at + 1];
}

const dbPath = arg("db");
const userId = arg("user") ?? "local";
const dryRun = process.argv.includes("--dry-run");
if (!dbPath || !fs.existsSync(dbPath)) {
	console.error(
		"Usage: convert-profile.ts --db <path to offerfinch.sqlite> [--user local] [--dry-run]",
	);
	process.exit(2);
}

function holders(file: string): string[] {
	try {
		return execFileSync(
			"lsof",
			["-t", ...[file, `${file}-wal`].filter((f) => fs.existsSync(f))],
			{ encoding: "utf8" },
		)
			.split("\n")
			.filter(Boolean);
	} catch {
		return []; // lsof exits 1 when nothing has the file open
	}
}

const open = holders(dbPath);
if (open.length > 0) {
	console.error(
		`Refusing: the database is open in process ${open.join(", ")}. Quit OfferFinch first.`,
	);
	process.exit(3);
}

const backupDir = path.join(path.dirname(dbPath), "backups");
const db = openSqlite(dbPath, { readonly: dryRun });
try {
	const [row] = await db
		.select({ files: profiles.files })
		.from(profiles)
		.where(eq(profiles.userId, userId));
	if (!row) {
		console.log(`No profile files for user "${userId}"; nothing to convert.`);
		process.exit(0);
	}
	const drafts = recordsFromFiles(
		row.files,
		"converted from the earlier profile files",
	);
	const byKind = drafts.reduce<Record<string, number>>((n, d) => {
		n[d.kind] = (n[d.kind] ?? 0) + 1;
		return n;
	}, {});
	const preview = renderRecords(
		drafts.map((d, i) => ({
			...d,
			id: `preview-${i}`,
			position: i,
			sourceDate: new Date(),
		})),
	);
	const lostInPreview = missingLines(row.files, preview);
	console.log(
		`${row.files.length} files -> ${drafts.length} records ${JSON.stringify(byKind)}`,
	);
	if (lostInPreview.length > 0) {
		console.error(
			`Refusing: ${lostInPreview.length} line(s) would be lost:\n${lostInPreview.join("\n")}`,
		);
		process.exit(4);
	}
	if (dryRun) {
		console.log("Dry run: nothing written.");
		process.exit(0);
	}
	const migrated = await migrate(db, { backupDir, keepBackups: 3 });
	for (const file of migrated.backups)
		console.log(`Backup before migration: ${file}`);
	const result = await convertProfileFilesWithBackup(db, userId, backupDir);
	if (!result.backup) {
		console.log("The profile already has records; nothing changed.");
		process.exit(0);
	}
	console.log(`Backup before conversion: ${result.backup}`);
	const lost = missingLines(
		row.files,
		renderRecords(await listRecords(db, userId)),
	);
	if (lost.length > 0) {
		await db.delete(profileRecords).where(eq(profileRecords.userId, userId));
		console.error(
			`Rolled back: ${lost.length} line(s) were lost:\n${lost.join("\n")}`,
		);
		process.exit(5);
	}
	console.log(
		`Converted: ${result.records} records written, every line kept. The files row is left as it was.`,
	);
} finally {
	db.$client.close();
}
