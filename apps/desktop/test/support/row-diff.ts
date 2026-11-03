/**
 * Row-by-row comparison of two states of one database file: each row by its primary key (or, for
 * a table without one, its first unique index), so a deleted row cannot hide behind an inserted
 * one and an overwritten value cannot hide behind an unchanged count.
 */
import { type Database, openSqlite } from "@offerfinch/db";

import { userTables } from "./upgrade-fixture";

type Row = Record<string, unknown>;
/** Table -> row key ("col=value, ...") -> row. */
export type Snapshot = Record<string, Map<string, Row>>;

/** Columns a write moves whatever it writes: never compared. */
const MOVED_BY_ANY_WRITE = new Set(["updated_at"]);

function keyColumns(db: Database, table: string): string[] {
	const info = db.$client.pragma(`table_info("${table}")`) as {
		name: string;
		pk: number;
	}[];
	const pk = info
		.filter((c) => c.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((c) => c.name);
	if (pk.length > 0) return pk;
	const unique = (
		db.$client.pragma(`index_list("${table}")`) as {
			name: string;
			unique: number;
			partial: number;
		}[]
	).find((i) => i.unique && !i.partial);
	if (!unique) throw new Error(`${table} has no primary key or unique index`);
	return (
		db.$client.pragma(`index_info("${unique.name}")`) as { name: string }[]
	).map((c) => c.name);
}

export function snapshot(dbFile: string): Snapshot {
	const db = openSqlite(dbFile);
	const out: Snapshot = {};
	for (const table of userTables(db)) {
		const keys = keyColumns(db, table);
		const rows = db.$client.prepare(`select * from "${table}"`).all() as Row[];
		out[table] = new Map(
			rows.map((row) => [keys.map((k) => `${k}=${row[k]}`).join(", "), row]),
		);
	}
	db.$close();
	return out;
}

/**
 * What happened to the rows `before` had: `lost` as "table [key]", `changed` as
 * "table [key] column". Rows added after and columns a migration added are not listed.
 */
export function rowChanges(before: Snapshot, after: Snapshot) {
	const lost: string[] = [];
	const changed: string[] = [];
	for (const [table, rows] of Object.entries(before)) {
		for (const [key, row] of rows) {
			const now = after[table]?.get(key);
			if (!now) {
				lost.push(`${table} [${key}]`);
				continue;
			}
			for (const [column, value] of Object.entries(row))
				if (!MOVED_BY_ANY_WRITE.has(column) && now[column] !== value)
					changed.push(`${table} [${key}] ${column}`);
		}
	}
	return { lost: lost.sort(), changed: changed.sort() };
}

/** Rows added since `before`, with their table, sorted by table and key. */
export function addedRows(before: Snapshot, after: Snapshot) {
	const added: { table: string; key: string; row: Row }[] = [];
	for (const [table, rows] of Object.entries(after))
		for (const [key, row] of rows)
			if (!before[table]?.has(key)) added.push({ table, key, row });
	return added.sort((a, b) =>
		`${a.table} ${a.key}`.localeCompare(`${b.table} ${b.key}`),
	);
}

/** Rows added since `before`, as "table [key]". */
export function rowsAdded(before: Snapshot, after: Snapshot): string[] {
	return addedRows(before, after).map((a) => `${a.table} [${a.key}]`);
}
