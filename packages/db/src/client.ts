import { AsyncLocalStorage } from "node:async_hooks";
import BetterSqlite3 from "better-sqlite3";
import { betterSQLite3Codecs } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import { relations } from "./relations";

/**
 * One connection, one writer. better-sqlite3 is synchronous, so a statement never interleaves
 * with another; what can interleave is an async transaction (`await` between its statements).
 * Every transaction therefore holds a process-wide async lock from BEGIN to COMMIT, and a
 * statement outside a transaction waits for it. Statements inside the transaction's async
 * context (AsyncLocalStorage) run straight through, nested transactions become savepoints.
 * Postgres' row locks and advisory locks become this: one transaction at a time.
 */
class AsyncLock {
	private tail: Promise<void> = Promise.resolve();
	private held = 0;

	get busy(): boolean {
		return this.held > 0;
	}

	/** Busy from the call on, queued or running, so a later statement queues behind it. */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release: () => void = () => {};
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.held++;
		try {
			await previous;
			return await fn();
		} finally {
			this.held--;
			release();
		}
	}
}

interface TxScope {
	active: boolean;
}

export interface OpenOptions {
	/** better-sqlite3's compiled addon, for a runtime other than this Node (Electron). */
	nativeBinding?: string;
	readonly?: boolean;
	/** Logs each statement (tests). */
	verbose?: (sql: string) => void;
}

function bindable(value: unknown): unknown {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value === undefined) return null;
	if (
		value !== null &&
		typeof value === "object" &&
		!(value instanceof Uint8Array)
	)
		return JSON.stringify(value);
	return value;
}

/** Opens (creating if needed) a database file in WAL mode with foreign keys on. */
export function openSqlite(path: string, options: OpenOptions = {}) {
	const client = new BetterSqlite3(path, {
		nativeBinding: options.nativeBinding,
		readonly: options.readonly ?? false,
	});
	if (!options.readonly) {
		client.pragma("journal_mode = WAL");
		client.pragma("synchronous = NORMAL");
	}
	client.pragma("foreign_keys = ON");
	client.pragma("busy_timeout = 5000");
	return createDatabase(client, options);
}

function createDatabase(
	client: BetterSqlite3.Database,
	options: OpenOptions = {},
) {
	const lock = new AsyncLock();
	const scope = new AsyncLocalStorage<TxScope>();
	const cache = new Map<string, BetterSqlite3.Statement>();
	const prepare = (sql: string) => {
		let statement = cache.get(sql);
		if (!statement) {
			statement = client.prepare(sql);
			if (cache.size > 500) cache.clear();
			cache.set(sql, statement);
		}
		return statement;
	};
	/** Inside the transaction that holds the lock: run now. Otherwise wait for it. */
	const exec = <T>(fn: () => T): Promise<T> => {
		if (scope.getStore()?.active) return Promise.resolve().then(fn);
		if (!lock.busy) {
			try {
				return Promise.resolve(fn());
			} catch (error) {
				return Promise.reject(error);
			}
		}
		return lock.run(async () => fn());
	};
	const run = (sql: string, params: unknown[]) => {
		options.verbose?.(sql);
		const statement = prepare(sql);
		const bound = params.map(bindable);
		if (statement.reader) return statement.all(...bound);
		return statement.run(...bound);
	};
	const db = drizzle(
		{
			run: (sql, params) => exec(() => run(sql, params)),
			all: (sql, params, rowMode) =>
				exec(() => {
					options.verbose?.(sql);
					const statement = prepare(sql);
					if (!statement.reader) {
						statement.run(...params.map(bindable));
						return [] as never;
					}
					return statement
						.raw(rowMode !== "object")
						.all(...params.map(bindable)) as never;
				}),
			get: (sql, params, rowMode) =>
				exec(() => {
					options.verbose?.(sql);
					const statement = prepare(sql);
					if (!statement.reader) {
						statement.run(...params.map(bindable));
						return undefined as never;
					}
					return statement
						.raw(rowMode !== "object")
						.get(...params.map(bindable)) as never;
				}),
		},
		// better-sqlite3's own codecs: JSON text, ms timestamps and 0/1 booleans decoded.
		{ relations, codecs: betterSQLite3Codecs },
	);
	const original = db.transaction.bind(db);
	type TxFn = Parameters<typeof original>[0];
	// Top-level transactions take the lock; BEGIN IMMEDIATE takes SQLite's write lock up front,
	// so another process (the CLI, an import) cannot upgrade a read into a deadlock.
	db.transaction = (async (fn: TxFn) => {
		const current = scope.getStore();
		if (current?.active)
			throw new Error(
				"Nested db.transaction(): use the transaction handle (tx.transaction) inside a transaction",
			);
		return lock.run(() => {
			const tx: TxScope = { active: true };
			return scope.run(tx, async () => {
				try {
					return await original(fn, { behavior: "immediate" });
				} finally {
					tx.active = false;
				}
			});
		});
	}) as typeof db.transaction;
	return Object.assign(db, {
		$client: client,
		/** Runs raw SQL outside drizzle (pragmas, VACUUM INTO, migrations), under the lock. */
		$exec: (sql: string) => exec(() => client.exec(sql)),
		$close: () => client.close(),
	});
}

export type Database = ReturnType<typeof createDatabase>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
