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
