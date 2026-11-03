import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");

describe("packages/core boundary", () => {
	it("has no Cloudflare imports", () => {
		const offenders = (readdirSync(SRC, { recursive: true }) as string[])
			.filter((file) => file.endsWith(".ts"))
			.filter((file) =>
				/from\s+["'](cloudflare:|@cloudflare\/)|import\(["'](cloudflare:|@cloudflare\/)/.test(
					readFileSync(join(SRC, file), "utf8"),
				),
			);
		expect(offenders).toEqual([]);
	});
});
