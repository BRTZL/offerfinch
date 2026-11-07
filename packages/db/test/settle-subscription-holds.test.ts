import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openSqlite } from "../src/index";
import { migrate } from "../src/migrate";
import { MIGRATIONS } from "../src/migrations/index";
import { execute } from "./setup";

const NAME = "_settle_subscription_holds";

describe("settle subscription holds migration", () => {
	it("settles held subscription rows at $0, keeps API holds and paid rows, and keeps only paid stops", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jp-holds-mig-"));
		const old = openSqlite(path.join(dir, "old.sqlite"));
		const before = MIGRATIONS.filter((m) => !m.name.endsWith(NAME));
		expect(before).toHaveLength(MIGRATIONS.length - 1);
		await migrate(old, { migrations: before });
		await old.run(
			sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'T', 'u1@example.test', 0, 0, 0)`,
		);
		const hour = 3_600_000;
		const t = Date.UTC(2026, 10, 3, 12);
		const row = (
			id: string,
			provider: string,
			billing: string,
			error: string | null,
			createdAt: number,
		) =>
			old.run(
				sql`insert into llm_usage (id, user_id, task, provider, status, estimate_micros, billing, error, model_calls, created_at) values (${id}, 'u1', 'fit-score', ${provider}, 'reserved', 1880000, ${billing}, ${error}, 1, ${createdAt})`,
			);
		// A Claude call held as billing unclear (the false hold), and a Codex one orphaned.
		await row(
			"held-claude",
			"claude-subscription:claude-opus-5-5",
			"subscription",
			"the answer arrived, but its session also failed",
			t,
		);
		await row(
			"orphan-codex",
			"codex-subscription:default",
			"subscription",
			null,
			t,
		);
		// An API-key call held for an unknown outcome, and a paid Claude call without usage.
		await row(
			"held-api",
			"anthropic:claude-opus-5-5",
			"api",
			"stream ended",
			t,
		);
		await row(
			"paid-claude",
			"claude-subscription:claude-opus-5-5",
			"api",
			"drew on paid extra usage",
			t + 2 * hour,
		);
		// Claude's stop follows its paid call; Codex's stop was for an unknown payment.
		await old.run(
			sql`insert into subscription_pauses (user_id, vendor, paused_at, reason) values ('u1', 'anthropic', ${t + 2 * hour + 60_000}, 'paid'), ('u1', 'openai', ${t + 30_000}, 'unknown')`,
		);

		const result = await migrate(old);
		expect(result.applied).toEqual([
			MIGRATIONS.find((m) => m.name.endsWith(NAME))?.name,
		]);
		const rows = await execute<{
			id: string;
			status: string;
			billing: string;
			cost_micros: number;
			settled_at: number | null;
			error: string | null;
		}>(
			old,
			sql`select id, status, billing, cost_micros, settled_at, error from llm_usage order by id`,
		);
		expect(rows).toEqual([
			{
				id: "held-api",
				status: "reserved",
				billing: "api",
				cost_micros: 0,
				settled_at: null,
				error: "stream ended",
			},
			{
				id: "held-claude",
				status: "settled",
				billing: "subscription",
				cost_micros: 0,
				settled_at: t,
				error: "the answer arrived, but its session also failed",
			},
			{
				id: "orphan-codex",
				status: "settled",
				billing: "subscription",
				cost_micros: 0,
				settled_at: t,
				error: null,
			},
			{
				id: "paid-claude",
				status: "reserved",
				billing: "api",
				cost_micros: 0,
				settled_at: null,
				error: "drew on paid extra usage",
			},
		]);
		const stops = await execute<{ vendor: string; paused_at: number }>(
			old,
			sql`select vendor, paused_at from subscription_pauses order by vendor`,
		);
		expect(stops).toEqual([
			{ vendor: "anthropic", paused_at: t + 2 * hour + 60_000 },
		]);
		old.$close();
	});
});
