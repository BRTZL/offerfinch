import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HostRateLimiter } from "@offerfinch/core/scrape/rate-limit";
import { RobotsCache } from "@offerfinch/core/scrape/robots";
import { ScrapeSource } from "@offerfinch/core/scrape/source";
import { RobotsDisallowedError } from "@offerfinch/core/sources/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localBrowser } from "./browser";

/** Real Chromium against a local site whose careers page redirects twice, into a disallowed path. */
let server: Server;
let base = "";
const hits: string[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		hits.push(req.url ?? "");
		const redirects: Record<string, string> = {
			"/careers": "/jobs",
			"/jobs": "/private/jobs",
			"/open": "/listing",
		};
		if (req.url === "/robots.txt") {
			res.writeHead(200, { "content-type": "text/plain" });
			return res.end("User-agent: *\nDisallow: /private");
		}
		const location = redirects[req.url ?? ""];
		if (location) {
			res.writeHead(302, { location });
			return res.end();
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(
			'<a href="/jobs/senior-engineer">Senior Software Engineer</a><a href="/jobs/backend-engineer">Backend Engineer</a>',
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.close();
});

function source(waited: string[]) {
	class RecordingLimiter extends HostRateLimiter {
		override async wait(url: string) {
			waited.push(new URL(url).pathname);
		}
	}
	return new ScrapeSource({
		browser: localBrowser(),
		robots: new RobotsCache("JobPipelineBot/0.1"),
		rateLimiter: new RecordingLimiter(0),
		maxDetailPages: 0,
	});
}

describe("redirects in a real browser", () => {
	it("checks each redirect hop and never fetches a disallowed destination", async () => {
		hits.length = 0;
		const waited: string[] = [];
		await expect(
			source(waited).listJobs({ sourceKey: `${base}/careers` }),
		).rejects.toBeInstanceOf(RobotsDisallowedError);
		expect(hits.filter((h) => h !== "/robots.txt")).toEqual([
			"/careers",
			"/jobs",
		]);
		expect(waited).toEqual(["/careers", "/jobs"]);
	}, 60_000);

	it("follows allowed redirects to the page and reads it", async () => {
		hits.length = 0;
		const waited: string[] = [];
		const jobs = await source(waited).listJobs({ sourceKey: `${base}/open` });
		expect(jobs.map((j) => j.title)).toEqual([
			"Senior Software Engineer",
			"Backend Engineer",
		]);
		expect(waited).toEqual(["/open", "/listing"]);
	}, 60_000);
});
