import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Database, openSqlite } from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { describe, expect, it } from "vitest";

import { SettingsStore } from "../src/worker/settings";

async function store() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-settings-"));
	const db: Database = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	return new SettingsStore(db);
}

describe("app settings", () => {
	it("setting a nullable setting to null unsets it (a database that had it starts)", async () => {
		const settings = await store();
		// An earlier version's LinkedIn switch, as an upgraded database has it.
		await settings.set("linkedinEnabled", true);
		expect(await settings.get("linkedinEnabled")).toBe(true);
		await settings.set("linkedinEnabled", null);
		expect(await settings.get("linkedinEnabled")).toBeNull();
		// Unsetting what is not set is fine too.
		await settings.set("linkedinEnabled", null);
		await settings.set("movedSearches", "Moved 2 searches.");
		await settings.set("movedSearches", null);
		expect(await settings.get("movedSearches")).toBeNull();
	});
});

describe("document look", () => {
	it("is the classic look until one is chosen; a stored look missing a field keeps the rest", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-settings-"));
		const db: Database = openSqlite(path.join(dir, "test.sqlite"));
		await migrate(db);
		const settings = new SettingsStore(db);
		expect(await settings.get("documentLook")).toEqual({
			template: "classic",
			font: "helvetica",
			accent: "ink",
			pageSize: "A4",
		});
		// A look stored before a field existed (here: the page size) reads with its default.
		db.$client
			.prepare(
				"insert into app_settings (key, value, updated_at) values ('documentLook', ?, ?)",
			)
			.run(
				JSON.stringify({
					template: "compact",
					font: "georgia",
					accent: "navy",
				}),
				Date.now(),
			);
		expect(await settings.get("documentLook")).toEqual({
			template: "compact",
			font: "georgia",
			accent: "navy",
			pageSize: "A4",
		});
	});
});

describe("writing style", () => {
	/** Writes `writingStyle` as stored by another version, around the schema. */
	async function stored(value: unknown) {
		const settings = await store();
		const db = (settings as unknown as { db: Database }).db;
		db.$client
			.prepare(
				"insert into app_settings (key, value, updated_at) values ('writingStyle', ?, ?)",
			)
			.run(JSON.stringify(value), Date.now());
		return settings;
	}

	it("reads the default when unset, and saves what Settings › Writing sends", async () => {
		const settings = await store();
		expect(await settings.get("writingStyle")).toEqual({
			tone: "plain",
			coverLetterLength: "standard",
			avoidWords: [],
			guidance: "",
		});
		await settings.set("writingStyle", {
			tone: "warm",
			coverLetterLength: "fuller",
			avoidWords: [" synergy ", "Synergy"],
			guidance: " Never say rockstar. ",
		});
		expect(await settings.get("writingStyle")).toEqual({
			tone: "warm",
			coverLetterLength: "fuller",
			avoidWords: ["synergy"],
			guidance: "Never say rockstar.",
		});
		await expect(
			settings.set("writingStyle", {
				tone: "warm",
				coverLetterLength: "fuller",
				avoidWords: [],
				guidance: "x".repeat(1001),
			}),
		).rejects.toThrow(/at most 1000 characters/);
	});

	it("keeps the stored choices when a field is missing or unknown to this version", async () => {
		const settings = await stored({
			tone: "formal",
			coverLetterLength: "a-future-length",
			avoidWords: ["synergy"],
		});
		expect(await settings.get("writingStyle")).toEqual({
			tone: "formal",
			coverLetterLength: "standard",
			avoidWords: ["synergy"],
			guidance: "",
		});
	});
});

describe("model settings of earlier versions", () => {
	/** Writes `ai` as an earlier version stored it, around the schema. */
	async function storedAi(value: unknown) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-settings-"));
		const db: Database = openSqlite(path.join(dir, "test.sqlite"));
		await migrate(db);
		db.$client
			.prepare(
				"insert into app_settings (key, value, updated_at) values ('ai', ?, ?)",
			)
			.run(JSON.stringify(value), Date.now());
		return new SettingsStore(db).get("ai");
	}

	it("reads each plan as its provider's model, keys as no model, the test models as themselves", async () => {
		expect(
			await storedAi({
				scoring: { mode: "claude-subscription", effort: "high" },
				tailoring: { mode: "claude-subscription" },
				claims: { mode: "claude-subscription", model: "claude-haiku-5-5" },
			}),
		).toEqual({
			// No model stored: the step's default then and now.
			scoring: { model: "claude:claude-opus-5-5", effort: "high" },
			tailoring: { model: "claude:claude-sonnet-5-5" },
			claims: { model: "claude:claude-haiku-5-5" },
		});
		expect(
			await storedAi({
				scoring: { mode: "codex-subscription" },
				tailoring: { mode: "codex-subscription", model: "gpt-6.1-sol" },
				claims: { mode: "codex-subscription", effort: "low" },
			}),
		).toEqual({
			// No model: the account's default Codex model.
			scoring: { model: "codex:" },
			tailoring: { model: "codex:gpt-6.1-sol" },
			claims: { model: "codex:", effort: "low" },
		});
		expect(
			await storedAi({
				scoring: { mode: "api", model: "claude-opus-5" },
				tailoring: { mode: "api", effort: "max" },
				claims: { mode: "fake" },
			}),
		).toEqual({
			scoring: { model: null },
			tailoring: { model: null },
			claims: { model: "fake:test" },
		});
	});

	it("never sends one company's stored model to the other's plan", async () => {
		expect(
			await storedAi({
				scoring: { mode: "claude-subscription", model: "gpt-6.1-terra" },
				tailoring: { mode: "codex-subscription", model: "claude-opus-5-5" },
				claims: { mode: "codex-subscription", model: " gpt-6.1-terra " },
			}),
		).toEqual({
			scoring: { model: "claude:claude-opus-5-5" },
			tailoring: { model: "codex:" },
			claims: { model: "codex:gpt-6.1-terra" },
		});
	});

	it("keeps the steps that read when one does not, and the new shape as it is", async () => {
		expect(
			await storedAi({
				scoring: { mode: "claude-subscription" },
				tailoring: { mode: "someday" },
				claims: { model: "codex:gpt-6.1-sol", effort: "xhigh" },
			}),
		).toEqual({
			scoring: { model: "claude:claude-opus-5-5" },
			tailoring: { model: null },
			claims: { model: "codex:gpt-6.1-sol", effort: "xhigh" },
		});
		expect(await storedAi("nonsense")).toEqual({
			scoring: { model: null },
			tailoring: { model: null },
			claims: { model: null },
		});
	});

	it("reads what it writes, and refuses a reference that is not one", async () => {
		const settings = await store();
		const ai = {
			scoring: {
				model: "claude:claude-opus-5-5" as const,
				effort: "low" as const,
			},
			tailoring: { model: "codex:" as const },
			claims: { model: null },
		};
		await settings.set("ai", ai);
		expect(await settings.get("ai")).toEqual(ai);
		await expect(
			settings.set("ai", { ...ai, claims: { model: "gpt-6:x" as never } }),
		).rejects.toThrow(/model reference/);
		await expect(
			settings.set("ai", {
				...ai,
				claims: { model: "opencode:no-source" as never },
			}),
		).rejects.toThrow(/model reference/);
	});
});
