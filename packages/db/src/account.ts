import type { BlobStore } from "@offerfinch/core/export/export";
import {
	and,
	eq,
	getTableColumns,
	getTableName,
	is,
	isNotNull,
	sql,
} from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";

import type { Database } from "./client";
import * as authSchema from "./schema/auth";
import { user } from "./schema/auth";
import * as dismissalSchema from "./schema/dismissals";
import * as pipelineSchema from "./schema/pipeline";
import { documents, submissionAttempts } from "./schema/pipeline";
import * as trackingSchema from "./schema/tracking";

/**
 * Every table that holds a user's rows, found from the schema itself (any table with a
 * `userId` column), so export, deletion and their tests cannot miss a table added later. A new
 * schema file must be listed here; `test/account.test.ts` fails until it is. The runner's own
 * tables (`schema/jobs.ts`) are left out: flow runs are the app's machinery, not the user's data.
 */
export const USER_TABLES: SQLiteTable[] = (
	[
		...Object.values(authSchema),
		...Object.values(pipelineSchema),
		...Object.values(dismissalSchema),
		...Object.values(trackingSchema),
	] as unknown[]
).filter(
	(value): value is SQLiteTable =>
		is(value, SQLiteTable) && "userId" in getTableColumns(value as SQLiteTable),
);

/** Columns never exported: password hashes, OAuth tokens, session tokens. */
const SECRET_COLUMNS = new Set([
	"password",
	"accessToken",
	"refreshToken",
	"idToken",
	"token",
]);

const userIdOf = (table: SQLiteTable) =>
	(getTableColumns(table) as Record<string, never>).userId as never;

/** Keys of every stored file of a user: exports and submission screenshots. */
async function blobKeys(db: Database, userId: string): Promise<string[]> {
	const docs = await db
		.select({ key: documents.storageKey })
		.from(documents)
		.where(and(eq(documents.userId, userId), isNotNull(documents.storageKey)));
	const shots = await db
		.select({
			before: submissionAttempts.screenshotBeforeKey,
			after: submissionAttempts.screenshotAfterKey,
		})
		.from(submissionAttempts)
		.where(eq(submissionAttempts.userId, userId));
	return [
		...docs.map((d) => d.key),
		...shots.flatMap((s) => [s.before, s.after]),
	].filter((k): k is string => Boolean(k));
}

/**
 * Everything stored for a user, as one JSON document: the account (no password or tokens),
 * every row of every per-user table, and every stored file, base64.
 */
export async function exportUserData(
	db: Database,
	blobs: BlobStore,
	userId: string,
) {
	const [account] = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			emailVerified: user.emailVerified,
			createdAt: user.createdAt,
		})
		.from(user)
		.where(eq(user.id, userId));
	if (!account) throw new Error("No such user");
	const tables: Record<string, Record<string, unknown>[]> = {};
	for (const table of USER_TABLES) {
		const rows = (await db
			.select()
			.from(table)
			.where(eq(userIdOf(table), userId))) as Record<string, unknown>[];
		tables[getTableName(table)] = rows.map((row) =>
			Object.fromEntries(
				Object.entries(row).filter(([key]) => !SECRET_COLUMNS.has(key)),
			),
		);
	}
	const files: { key: string; base64: string }[] = [];
	for (const key of await blobKeys(db, userId)) {
		const bytes = await blobs.get(key);
		if (bytes)
			files.push({ key, base64: Buffer.from(bytes).toString("base64") });
	}
	return {
		format: "offerfinch-export/1",
		exportedAt: new Date().toISOString(),
		account,
		tables,
		files,
	};
}

/**
 * What deleting an account removes beyond the database cascade: every stored file under the
 * user's prefix (and any listed elsewhere), pending verification and reset tokens, and the email
 * on a used invite. The user row, and with it every per-user row (workflow events included), is
 * deleted by the caller: Better-Auth's delete-user, or `deleteUserRow`.
 */
export async function deleteUserData(
	db: Database,
	blobs: BlobStore,
	account: { id: string; email: string },
	options: { deleteUserRow?: boolean } = {},
): Promise<{ files: number }> {
	let files = 0;
	for (const key of await blobKeys(db, account.id))
		if (!key.startsWith(`users/${account.id}/`))
			files += await blobs.deletePrefix(key);
	files += await blobs.deletePrefix(`users/${account.id}/`);
	if (options.deleteUserRow) {
		await db.delete(user).where(eq(user.id, account.id));
	}
	return { files };
}

/** Rows left for a user in every per-user table (deletion tests). */
export async function countUserRows(
	db: Database,
	userId: string,
): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const table of USER_TABLES) {
		const [row] = await db
			.select({ n: sql<number>`count(*)` })
			.from(table)
			.where(eq(userIdOf(table), userId));
		counts[getTableName(table)] = Number(row?.n ?? 0);
	}
	const [self] = await db
		.select({ n: sql<number>`count(*)` })
		.from(user)
		.where(eq(user.id, userId));
	counts.user = Number(self?.n ?? 0);
	return counts;
}
