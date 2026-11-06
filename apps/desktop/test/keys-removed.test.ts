import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSqlite } from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerInit } from "../src/shared/worker-protocol";
import { WorkerApp } from "../src/worker/app";
import { apiKeySteps } from "../src/worker/model-choice";
import { SettingsStore } from "../src/worker/settings";

/**
 * API keys are gone: a step an earlier version ran on a key reads as no model, is noted once for
 * Settings › Models, and gets a model at start from what is signed in (fake CLIs, no real one).
 */

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

const OLD = {
	scoring: { mode: "claude-subscription", model: "claude-sonnet-5-5" },
	tailoring: { mode: "api", model: "claude-opus-5-5" },
	claims: { mode: "api", model: "gpt-5.5-mini" },
};

async function upgrade(fake: Record<string, string>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-keys-"));
	dirs.push(dir);
	const dbFile = path.join(dir, "offerfinch.sqlite");
	const db = openSqlite(dbFile);
	await migrate(db, { backupDir: path.join(dir, "backups") });
	db.$client
		.prepare(
			"insert into app_settings (key, value, updated_at) values ('ai', ?, ?)",
		)
		.run(JSON.stringify(OLD), Date.now());
	db.$close();
	fs.writeFileSync(path.join(dir, "fake-clis.json"), JSON.stringify(fake));
	const init: WorkerInit = {
		type: "init",
		userData: dir,
		dbFile,
		version: "0.0.0-keys-test",
		claudeHost: path.join(dir, "no-claude-host.js"),
		test: { fakeModels: true, noSchedule: true, fakeClis: true },
	};
	const start = async () => {
		const app = await WorkerApp.open(init, {
			exit: () => {},
			status: () => {},
			notify: () => {},
			site: async () => {
				throw new Error("No site tabs here");
			},
			log: () => {},
		});
		vi.spyOn(app.runner, "poke").mockImplementation(() => {});
		await app.start();
		await app.pathRefresh;
		await app.background;
		const ai = await app.settings.get("ai");
		const notice = await app.settings.get("keysRemoved");
		const raw = await app.settings.raw("ai");
		await app.stop();
		return { ai, notice, raw };
	};
	return { dir, start };
}

describe("steps that ran on an API key", () => {
	it("reads the key steps from the row as stored", () => {
		expect(apiKeySteps(OLD)).toEqual(["tailoring", "claims"]);
		expect(apiKeySteps({ scoring: { model: null } })).toEqual([]);
		expect(apiKeySteps(undefined)).toEqual([]);
	});

	it("get Claude when it is signed in, and the notice once", async () => {
		const { start } = await upgrade({ claude: "logged_in" });
		const first = await start();
		expect(first.ai).toEqual({
			scoring: { model: "claude:claude-sonnet-5-5" },
			tailoring: { model: "claude:claude-sonnet-5-5" },
			claims: { model: "claude:claude-opus-5-5" },
		});
		expect(first.notice).toEqual({
			steps: ["tailoring", "claims"],
			dismissed: false,
		});
		// Written in today's shape: the next start has nothing to fill or note.
		expect(apiKeySteps(first.raw)).toEqual([]);
	}, 30_000);

	it("wait for a model while nothing is signed in, and are filled on a later start", async () => {
		const { dir, start } = await upgrade({});
		const first = await start();
		expect(first.ai.tailoring).toEqual({ model: null });
		expect(first.ai.claims).toEqual({ model: null });
		expect(apiKeySteps(first.raw)).toEqual(["tailoring", "claims"]);
		// Codex signs in; the user had dismissed the notice: it stays dismissed.
		const db = openSqlite(path.join(dir, "offerfinch.sqlite"));
		await new SettingsStore(db).set("keysRemoved", {
			steps: ["tailoring", "claims"],
			dismissed: true,
		});
		db.$close();
		fs.writeFileSync(
			path.join(dir, "fake-clis.json"),
			JSON.stringify({ codex: "logged_in" }),
		);
		const second = await start();
		expect(second.ai).toEqual({
			scoring: { model: "claude:claude-sonnet-5-5" },
			tailoring: { model: "codex:" },
			claims: { model: "codex:" },
		});
		expect(second.notice?.dismissed).toBe(true);
	}, 30_000);
});
