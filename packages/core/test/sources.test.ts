import { describe, expect, it } from "vitest";

import { AshbySource } from "../src/sources/ashby";
import { GreenhouseSource } from "../src/sources/greenhouse";
import { LeverSource } from "../src/sources/lever";
import { BoardNotFoundError } from "../src/sources/types";
import { fakeFetch, fixture } from "./helpers";

describe("AshbySource (recorded clickhouse board)", () => {
	const source = new AshbySource(
		fakeFetch({
			"job-board/clickhouse": { body: fixture("ashby-clickhouse.json") },
		}),
	);

	it("maps postings to normalized jobs", async () => {
		const jobs = await source.listJobs({ sourceKey: "clickhouse" });
		expect(jobs).toHaveLength(5);
		const first = jobs[0];
		expect(first?.source).toBe("ashby");
		expect(first?.url).toMatch(/^https:\/\/jobs\.ashbyhq\.com\/clickhouse\//);
		expect(first?.title.length).toBeGreaterThan(3);
		expect(first?.descriptionText.length).toBeGreaterThan(100);
		expect(jobs.some((job) => job.workplaceType === "hybrid")).toBe(true);
		expect(jobs.some((job) => job.locations.length > 1)).toBe(true);
	});

	it("reports a missing board", async () => {
		await expect(
			new AshbySource(fakeFetch({})).listJobs({ sourceKey: "nope" }),
		).rejects.toBeInstanceOf(BoardNotFoundError);
	});
});

describe("GreenhouseSource (recorded modemobile board)", () => {
	const source = new GreenhouseSource(
		fakeFetch({
			"boards/modemobile": { body: fixture("greenhouse-modemobile.json") },
		}),
	);

	it("decodes escaped HTML content to text", async () => {
		const jobs = await source.listJobs({ sourceKey: "modemobile" });
		expect(jobs).toHaveLength(5);
		for (const job of jobs) {
			expect(job.source).toBe("greenhouse");
			expect(job.externalId).toMatch(/^\d+$/);
			expect(job.descriptionText).not.toMatch(/&lt;|<p>/);
		}
		expect(jobs.find((job) => /remote/i.test(job.title))?.workplaceType).toBe(
			"remote",
		);
	});

	it("reports a missing board", async () => {
		await expect(
			new GreenhouseSource(fakeFetch({})).listJobs({ sourceKey: "nope" }),
		).rejects.toBeInstanceOf(BoardNotFoundError);
	});
});

describe("LeverSource (recorded appnation board)", () => {
	const source = new LeverSource(
		fakeFetch({
			"postings/appnation": { body: fixture("lever-appnation.json") },
		}),
	);

	it("maps workplace type, country and list sections", async () => {
		const jobs = await source.listJobs({ sourceKey: "appnation" });
		expect(jobs).toHaveLength(4);
		const first = jobs[0];
		expect(first?.source).toBe("lever");
		expect(first?.workplaceType).toBe("hybrid");
		expect(first?.locations[0]).toMatch(/Ankara, Turkey/);
		expect(first?.descriptionText).toMatch(/What You’ll Do/);
		// List items keep their text on the bullet line.
		expect(first?.descriptionText).not.toMatch(/^-\s*$/m);
	});
});
