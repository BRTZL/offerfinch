import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { forgetOldKeys, OLD_KEYS_FILE } from "../src/main/old-keys";

describe("API keys of earlier versions", () => {
	it("are deleted at start without being read, and only once", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-keys-"));
		fs.writeFileSync(path.join(dir, OLD_KEYS_FILE), '{"anthropic":"sealed"}');
		fs.writeFileSync(path.join(dir, `${OLD_KEYS_FILE}.tmp`), "{}");
		fs.writeFileSync(path.join(dir, "offerfinch.sqlite"), "data");
		expect(forgetOldKeys(dir)).toBe(true);
		expect(fs.readdirSync(dir)).toEqual(["offerfinch.sqlite"]);
		expect(forgetOldKeys(dir)).toBe(false);
	});
});
