import fs from "node:fs";
import path from "node:path";

import {
	type DraftRecord,
	type ProfileRecord,
	type RecordInput,
	type RecordKind,
	recordInputSchema,
	recordsFromFiles,
} from "@offerfinch/core/profile/records";
import { and, asc, eq, max } from "drizzle-orm";

import type { Database, Tx } from "./client";
import { profileRecords, profiles } from "./schema/pipeline";

type Db = Database | Tx;

/** A stored row as a record; a row whose data no longer parses is skipped, never guessed at. */
function toRecord(
	row: typeof profileRecords.$inferSelect,
): ProfileRecord | null {
	const parsed = recordInputSchema.safeParse({
		kind: row.kind,
		data: row.data,
	});
	if (!parsed.success) return null;
	return {
		...parsed.data,
		id: row.id,
		position: row.position,
		source: row.source,
		sourceDate: row.sourceDate,
	};
}

/** The user's records, About first, each kind in its saved order. */
export async function listRecords(
	t: Db,
	userId: string,
): Promise<ProfileRecord[]> {
	const rows = await t
		.select()
		.from(profileRecords)
		.where(eq(profileRecords.userId, userId))
		.orderBy(
			asc(profileRecords.kind),
			asc(profileRecords.position),
			asc(profileRecords.id),
		);
	return rows.map(toRecord).filter((r): r is ProfileRecord => r !== null);
}

async function hasRecords(t: Db, userId: string): Promise<boolean> {
	const [row] = await t
		.select({ id: profileRecords.id })
		.from(profileRecords)
		.where(eq(profileRecords.userId, userId))
		.limit(1);
	return Boolean(row);
}

/**
 * Replaces every record with `drafts` (a reviewed resume import or a profile conversion), in
 * their order. Answers are facts and stay.
 */
export async function replaceRecords(
	db: Database,
	userId: string,
	drafts: readonly DraftRecord[],
	now = new Date(),
): Promise<number> {
	const valid = drafts.map((d) => ({
		...recordInputSchema.parse({ kind: d.kind, data: d.data }),
		source: d.source,
	}));
	if (valid.filter((d) => d.kind === "about").length > 1)
		throw new Error("Refusing: a profile has one About record");
	return db.transaction(async (tx) => {
		await tx.delete(profileRecords).where(eq(profileRecords.userId, userId));
		const position: Partial<Record<RecordKind, number>> = {};
		for (const d of valid) {
			const at = position[d.kind] ?? 0;
			position[d.kind] = at + 1;
			await tx.insert(profileRecords).values({
				userId,
				kind: d.kind,
				position: at,
				data: d.data,
				source: d.source,
				sourceDate: now,
			});
		}
		return valid.length;
	});
}

/** Adds a record at the end of its kind. The About record is one per profile. */
export async function addRecord(
	db: Database,
	userId: string,
	input: RecordInput,
	source: string,
	now = new Date(),
): Promise<ProfileRecord> {
	const record = recordInputSchema.parse(input);
	return db.transaction(async (tx) => {
		const [last] = await tx
			.select({ n: max(profileRecords.position) })
			.from(profileRecords)
			.where(
				and(
					eq(profileRecords.userId, userId),
					eq(profileRecords.kind, record.kind),
				),
			);
		if (record.kind === "about" && last?.n !== null && last?.n !== undefined)
			throw new Error(
				"Refusing: a profile has one About record; edit it instead",
			);
		const [row] = await tx
			.insert(profileRecords)
			.values({
				userId,
				kind: record.kind,
				position: (last?.n ?? -1) + 1,
				data: record.data,
				source,
				sourceDate: now,
			})
			.returning();
		const saved = row ? toRecord(row) : null;
		if (!saved) throw new Error("record insert returned nothing");
		return saved;
	});
}

/** Edits a record's fields; its source becomes the editor and its date today. Null when not theirs. */
export async function updateRecord(
	db: Database,
	userId: string,
	id: string,
	input: RecordInput,
	{ source, now = new Date() }: { source: string; now?: Date },
): Promise<ProfileRecord | null> {
	const record = recordInputSchema.parse(input);
	const [row] = await db
		.update(profileRecords)
		.set({ data: record.data, source, sourceDate: now, updatedAt: now })
		.where(
			and(
				eq(profileRecords.id, id),
				eq(profileRecords.userId, userId),
				eq(profileRecords.kind, record.kind),
			),
		)
		.returning();
	return row ? toRecord(row) : null;
}

export async function removeRecord(
	db: Database,
	userId: string,
	id: string,
): Promise<boolean> {
	const rows = await db
		.delete(profileRecords)
		.where(and(eq(profileRecords.id, id), eq(profileRecords.userId, userId)))
		.returning({ id: profileRecords.id });
	return rows.length > 0;
}

/** Moves a record one place up or down within its kind. */
export async function moveRecord(
	db: Database,
	userId: string,
	id: string,
	direction: "up" | "down",
): Promise<boolean> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(profileRecords)
			.where(and(eq(profileRecords.id, id), eq(profileRecords.userId, userId)));
		if (!row) return false;
		const siblings = await tx
			.select({ id: profileRecords.id })
			.from(profileRecords)
			.where(
				and(
					eq(profileRecords.userId, userId),
					eq(profileRecords.kind, row.kind),
				),
			)
			.orderBy(asc(profileRecords.position), asc(profileRecords.id));
		const at = siblings.findIndex((s) => s.id === id);
		const to = direction === "up" ? at - 1 : at + 1;
		if (to < 0 || to >= siblings.length) return false;
		const order = siblings.map((s) => s.id);
		[order[at], order[to]] = [order[to] as string, order[at] as string];
		for (const [i, sid] of order.entries())
			await tx
				.update(profileRecords)
				.set({ position: i })
				.where(eq(profileRecords.id, sid));
		return true;
	});
}

/**
 * Converts a profile kept as Markdown files (`profiles.files`, before records) into records, once:
 * nothing happens when the user already has records or has no files. The files row is left as
 * it was. Returns how many records were written.
 */
export async function convertProfileFiles(
	db: Database,
	userId: string,
	source = "converted from the earlier profile files",
): Promise<number> {
	if (await hasRecords(db, userId)) return 0;
	const [row] = await db
		.select({ files: profiles.files })
		.from(profiles)
		.where(eq(profiles.userId, userId));
	if (!row || row.files.length === 0) return 0;
	return replaceRecords(db, userId, recordsFromFiles(row.files, source));
}

/**
 * `convertProfileFiles` after a full copy of the database (`vacuum into`), for a profile kept as
 * files by an earlier version. Runs only when the user starts it. The copy is named so the
 * migration backups' pruning never removes it.
 */
export async function convertProfileFilesWithBackup(
	db: Database,
	userId: string,
	backupDir: string,
	now = new Date(),
): Promise<{ records: number; backup: string | null }> {
	if (await hasRecords(db, userId)) return { records: 0, backup: null };
	const [row] = await db
		.select({ id: profiles.id })
		.from(profiles)
		.where(eq(profiles.userId, userId));
	if (!row) return { records: 0, backup: null };
	fs.mkdirSync(backupDir, { recursive: true });
	const backup = path.join(
		backupDir,
		`profile-files-${now.toISOString().replace(/[:.]/g, "-")}.sqlite`,
	);
	db.$client.prepare("vacuum into ?").run(backup);
	return { records: await convertProfileFiles(db, userId), backup };
}
