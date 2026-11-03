import { describe, expect, it } from "vitest";

import { companyNameKey, normalizeUrl } from "../src/domain/url";

describe("normalizeUrl", () => {
	it("drops tracking parameters, fragments, www and trailing slashes", () => {
		expect(
			normalizeUrl(
				"http://www.Example.com/jobs/123/?utm_source=x&gh_src=abc#apply",
			),
		).toBe("https://example.com/jobs/123");
	});
	it("keeps meaningful parameters in a stable order", () => {
		expect(
			normalizeUrl("https://modemobile.com/open-role?gh_jid=8811988002&b=2"),
		).toBe(
			normalizeUrl(
				"https://www.modemobile.com/open-role?b=2&gh_jid=8811988002",
			),
		);
	});
	it("treats the same Lever posting with and without lever-source as one", () => {
		expect(
			normalizeUrl("https://jobs.lever.co/appnation/abc?lever-source=LinkedIn"),
		).toBe("https://jobs.lever.co/appnation/abc");
	});
});

describe("companyNameKey", () => {
	it("matches the same company across spellings", () => {
		expect(companyNameKey("Hilbert's AI")).toBe(companyNameKey("hilberts ai"));
		expect(companyNameKey("ClickHouse, Inc.")).toBe("clickhouse");
		expect(companyNameKey("Société Générale")).toBe(
			companyNameKey("Societe Generale"),
		);
		expect(companyNameKey("Ørsted A/S")).toBe(companyNameKey("Orsted A/S"));
		expect(companyNameKey("Straße GmbH")).toBe("strasse");
		expect(companyNameKey("ＡＣＭＥ Ltd.")).toBe("acme");
	});

	it("keeps different companies apart, in any script", () => {
		expect(companyNameKey("Meta")).not.toBe(companyNameKey("Metabase"));
		expect(companyNameKey("Apple")).not.toBe(
			companyNameKey("Applied Materials"),
		);
		expect(companyNameKey("東京Tech")).toBe("東京tech");
		expect(companyNameKey("東京Tech")).not.toBe(companyNameKey("大阪Tech"));
		expect(companyNameKey("Яндекс")).toBe("яндекс");
		expect(companyNameKey("Яндекс")).not.toBe(companyNameKey("Озон"));
		expect(companyNameKey("インフォテック株式会社")).not.toBe(
			companyNameKey("インフォデック株式会社"),
		);
		// A legal form inside a word is part of the name.
		expect(companyNameKey("Cosmos")).toBe("cosmos");
		expect(companyNameKey("Saga Inc")).toBe("saga");
	});
});
