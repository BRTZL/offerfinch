import { describe, expect, it } from "vitest";

import { NoopNotifier } from "../src/notify/ntfy";
import {
	type CheckableJob,
	type ClosedPostingStore,
	checkPostingOpen,
	politePageFetcher,
	postingAge,
	sweepClosedPostings,
} from "../src/pipeline/closed";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { FlowStep, PipelineDeps } from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { FakeLlmProvider } from "../src/scoring/fake";
import { AshbySource } from "../src/sources/ashby";
import { GreenhouseSource } from "../src/sources/greenhouse";
import { LeverSource } from "../src/sources/lever";
import type { FetchLike } from "../src/sources/types";
import { MemoryRepo } from "./memory-repo";

/**
 * Answers by URL substring (a key ending in "$": by the URL's end); records each URL asked. A
 * function answer can hang or throw.
 */
function routes(
	table: Record<
		string,
		| { status: number; body?: unknown }
		| ((init?: RequestInit) => Promise<Response>)
	>,
) {
	const asked: string[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		asked.push(url);
		for (const [part, answer] of Object.entries(table))
			if (
				part.endsWith("$")
					? url.endsWith(part.slice(0, -1))
					: url.includes(part)
			) {
				if (typeof answer === "function") return answer(init);
				return new Response(JSON.stringify(answer.body ?? {}), {
					status: answer.status,
					headers: { "content-type": "application/json" },
				});
			}
		return new Response("{}", { status: 404 });
	};
	return { fetchImpl, asked };
}

/** The Greenhouse board for acmerobotics, listing these posting ids. */
const ghBoard = (...ids: number[]) => ({
	"/boards/acmerobotics/jobs$": {
		status: 200,
		body: { jobs: ids.map((id) => ({ id })) },
	},
});

/** Never answers; rejects when the request's signal aborts (a timeout). */
const hang = (init?: RequestInit) =>
	new Promise<Response>((_, reject) => {
		init?.signal?.addEventListener("abort", () =>
			reject(init.signal?.reason ?? new Error("aborted")),
		);
	});

const boardJob = (overrides: Partial<CheckableJob> = {}): CheckableJob => ({
	jobId: "j1",
	source: "greenhouse",
	url: "https://acme.example/careers?gh_jid=4001",
	externalId: "4001",
	companyKey: "acmerobotics",
	validThrough: null,
	...overrides,
});

describe("board readers' posting check", () => {
	it("Greenhouse: 404 is gone, the same posting is open, a 5xx or another posting throws", async () => {
		const { fetchImpl, asked } = routes({
			"/jobs/4001": { status: 200, body: { id: 4001 } },
			"/jobs/4002": { status: 404 },
			"/jobs/4003": { status: 503 },
			"/jobs/4004": { status: 200, body: { id: 9999 } },
			...ghBoard(4001, 4003),
		});
		const gh = new GreenhouseSource(fetchImpl);
		expect(await gh.checkPosting("acmerobotics", "4001")).toBe("open");
		expect(await gh.checkPosting("acmerobotics", "4002")).toBe("gone");
		await expect(gh.checkPosting("acmerobotics", "4003")).rejects.toThrow(
			/HTTP 503/,
		);
		await expect(gh.checkPosting("acmerobotics", "4004")).rejects.toThrow(
			/another posting/,
		);
		expect(asked[0]).toBe(
			"https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/4001",
		);
	});

	it("a posting's 404 closes it only when its board answers and lists other postings", async () => {
		const gh = (board: Record<string, { status: number; body?: unknown }>) =>
			new GreenhouseSource(
				routes({ "/jobs/4002": { status: 404 }, ...board }).fetchImpl,
			);
		// The board itself is missing (renamed or moved): the 404 says nothing about the posting.
		await expect(
			gh({ "/boards/acmerobotics/jobs$": { status: 404 } }).checkPosting(
				"acmerobotics",
				"4002",
			),
		).rejects.toThrow(/board answers 404/);
		await expect(
			gh(ghBoard()).checkPosting("acmerobotics", "4002"),
		).rejects.toThrow(/lists no postings/);
		await expect(
			gh(ghBoard(4002, 4001)).checkPosting("acmerobotics", "4002"),
		).rejects.toThrow(/still lists it/);
		expect(await gh(ghBoard(4001)).checkPosting("acmerobotics", "4002")).toBe(
			"gone",
		);
		const lever = (board: { status: number; body?: unknown }) =>
			new LeverSource(
				routes({ "/acme/gone": { status: 404 }, "acme?mode=json$": board })
					.fetchImpl,
			);
		await expect(
			lever({ status: 404 }).checkPosting("acme", "gone"),
		).rejects.toThrow(/board answers 404/);
		expect(
			await lever({ status: 200, body: [{ id: "other" }] }).checkPosting(
				"acme",
				"gone",
			),
		).toBe("gone");
	});

	it("Lever: 404 is gone, the same posting is open, 429 throws", async () => {
		const id = "0b5ad1c2-1111-4222-8333-944455556666";
		const { fetchImpl, asked } = routes({
			[`/acme/${id}`]: { status: 200, body: { id } },
			"/acme/gone": { status: 404 },
			"/acme/busy": { status: 429 },
			"acme?mode=json$": { status: 200, body: [{ id }] },
		});
		const lever = new LeverSource(fetchImpl);
		expect(await lever.checkPosting("acme", id)).toBe("open");
		expect(await lever.checkPosting("acme", "gone")).toBe("gone");
		await expect(lever.checkPosting("acme", "busy")).rejects.toThrow(
			/HTTP 429/,
		);
		expect(asked[0]).toBe(`https://api.lever.co/v0/postings/acme/${id}`);
	});

	it("Ashby: gone only when a non-empty board lacks it or lists it unlisted; an empty board or 404 says nothing", async () => {
		const board = (jobs: unknown) =>
			new AshbySource(
				routes({ "job-board/acme": { status: 200, body: { jobs } } }).fetchImpl,
			);
		const listed = [
			{ id: "AAA", title: "A", jobUrl: "u" },
			{ id: "bbb", title: "B", jobUrl: "u", isListed: false },
		];
		expect(await board(listed).checkPosting("acme", "aaa")).toBe("open");
		expect(await board(listed).checkPosting("acme", "bbb")).toBe("gone");
		expect(await board(listed).checkPosting("acme", "ccc")).toBe("gone");
		await expect(board([]).checkPosting("acme", "aaa")).rejects.toThrow(
			/no postings/,
		);
		await expect(
			new AshbySource(routes({}).fetchImpl).checkPosting("acme", "aaa"),
		).rejects.toThrow(/HTTP 404/);
	});
});

describe("checkPostingOpen", () => {
	const sources = (fetchImpl: FetchLike) => ({
		greenhouse: new GreenhouseSource(fetchImpl),
		lever: new LeverSource(fetchImpl),
		ashby: new AshbySource(fetchImpl),
	});

	it("closes on the board's definite answer, by the stored board key and id (not the URL)", async () => {
		const { fetchImpl, asked } = routes({
			"/jobs/4001": { status: 404 },
			...ghBoard(4002),
		});
		expect(
			await checkPostingOpen(boardJob(), { sources: sources(fetchImpl) }),
		).toEqual({ status: "gone", reason: "Greenhouse no longer lists it" });
		expect(asked).toEqual([
			"https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/4001",
			"https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs",
		]);
	});

	it("never closes on an error: a 500, a timeout or a network failure is unknown", async () => {
		const answers = [
			routes({ "/jobs/4001": { status: 500 } }).fetchImpl,
			routes({ "/jobs/4001": hang }).fetchImpl,
			(async () => {
				throw new TypeError("fetch failed");
			}) as FetchLike,
		];
		for (const fetchImpl of answers) {
			const check = await checkPostingOpen(boardJob(), {
				sources: sources(fetchImpl),
				timeoutMs: 50,
			});
			expect(check.status).toBe("unknown");
		}
	});

	it("never re-reads LinkedIn, Indeed or Glassdoor, also when added by link", async () => {
		const { fetchImpl, asked } = routes({});
		let pages = 0;
		const deps = {
			sources: sources(fetchImpl),
			fetchPage: async () => {
				pages++;
				return { status: 404, html: "" };
			},
		};
		for (const job of [
			boardJob({
				source: "linkedin",
				url: "https://www.linkedin.com/jobs/view/1234567",
			}),
			boardJob({ source: "indeed" }),
			boardJob({
				source: "manual",
				url: "https://www.glassdoor.com/job-listing/x?jl=1234567",
			}),
		])
			expect((await checkPostingOpen(job, deps)).status).toBe("not_checked");
		expect(asked).toEqual([]);
		expect(pages).toBe(0);
	});

	it("checks a job added by a board link through that board", async () => {
		const { fetchImpl, asked } = routes({
			"/jobs/77": { status: 404 },
			...ghBoard(78),
		});
		const check = await checkPostingOpen(
			boardJob({
				source: "manual",
				externalId: "https://job-boards.greenhouse.io/acmerobotics/jobs/77",
				url: "https://job-boards.greenhouse.io/acmerobotics/jobs/77",
				companyKey: "manual:acme",
			}),
			{ sources: sources(fetchImpl) },
		);
		expect(check.status).toBe("gone");
		expect(asked[0]).toContain("/boards/acmerobotics/jobs/77");
	});

	it("checks an EU board link added by hand as a page: the US API's 404 says nothing about it", async () => {
		const { fetchImpl, asked } = routes({ "api.lever.co": { status: 404 } });
		const pages: string[] = [];
		const url =
			"https://jobs.eu.lever.co/acme/0b5ad1c2-1111-4222-8333-944455556666";
		const check = await checkPostingOpen(
			boardJob({ source: "manual", url, externalId: url }),
			{
				sources: sources(fetchImpl),
				fetchPage: async (page) => {
					pages.push(page);
					return { status: 503, html: "" };
				},
			},
		);
		expect(check.status).toBe("unknown");
		expect(asked).toEqual([]);
		expect(pages).toEqual([url]);
	});

	it("trusts a page's end date only from the one posting the job is about", async () => {
		const now = () => new Date("2026-11-03T12:00:00Z");
		const job = boardJob({
			source: "web",
			url: "https://careers.example/jobs/1",
		});
		const posting = (title: string, validThrough: string, url?: string) => ({
			"@type": "JobPosting",
			title,
			description:
				"Build things with TypeScript and React across our product, ship features weekly and own them end to end.",
			hiringOrganization: { name: "Acme" },
			validThrough,
			...(url ? { url } : {}),
		});
		const page = (...nodes: unknown[]) => ({
			sources: {},
			now,
			fetchPage: async () => ({
				status: 200,
				html: nodes
					.map(
						(n) =>
							`<script type="application/ld+json">${JSON.stringify(n)}</script>`,
					)
					.join(""),
			}),
		});
		// This posting runs to 2027; a related job on the same page ended in 2025.
		expect(
			(
				await checkPostingOpen(
					job,
					page(
						posting("Platform Engineer", "2027-01-31"),
						posting("Data Engineer", "2025-05-01"),
					),
				)
			).status,
		).toBe("unknown");
		// A redirect to a careers page whose one posting is another, expired job.
		expect(
			(
				await checkPostingOpen(
					job,
					page(posting("Data Engineer", "2025-05-01")),
				)
			).status,
		).toBe("unknown");
		// The same title is never enough: no URL to tell it is this posting.
		expect(
			(
				await checkPostingOpen(
					job,
					page(posting("Platform Engineer", "2025-05-01")),
				)
			).status,
		).toBe("unknown");
		// Same title, another posting's URL (a redirect to /jobs/2, which ended).
		expect(
			(
				await checkPostingOpen(
					job,
					page(
						posting(
							"Platform Engineer",
							"2025-05-01",
							"https://careers.example/jobs/2",
						),
					),
				)
			).status,
		).toBe("unknown");
		// A second JobPosting with a short description still counts: two postings, unknown.
		expect(
			(
				await checkPostingOpen(
					job,
					page(
						posting(
							"Platform Engineer",
							"2025-05-01",
							"https://careers.example/jobs/1",
						),
						{
							"@type": "JobPosting",
							title: "Platform Engineer",
							description: "Short.",
							url: "https://careers.example/jobs/9",
						},
					),
				)
			).status,
		).toBe("unknown");
		// The posting itself, by its own URL (titles may differ) or its identifier.
		expect(
			(
				await checkPostingOpen(
					job,
					page({
						"@type": "JobPosting",
						title: "Platform Engineer",
						identifier: {
							"@type": "PropertyValue",
							value: job.externalId,
						},
						validThrough: "2025-05-01",
					}),
				)
			).status,
		).toBe("gone");
		expect(
			(
				await checkPostingOpen(
					job,
					page(
						posting(
							"Platform Engineer (Remote)",
							"2025-05-01",
							"https://careers.example/jobs/1/",
						),
					),
				)
			).status,
		).toBe("gone");
	});

	it("compares URLs strictly for closure: another ref, port or path is another posting", async () => {
		const now = () => new Date("2026-11-03T12:00:00Z");
		const declaring = (url: string) => ({
			sources: {},
			now,
			fetchPage: async (requested: string) => ({
				status: 200,
				url: requested,
				redirects: [requested],
				html: `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Engineer", url, validThrough: "2025-05-01" })}</script>`,
			}),
		});
		const job = boardJob({
			source: "web",
			url: "https://careers.example/jobs?ref=123",
		});
		const status = async (url: string) =>
			(await checkPostingOpen(job, declaring(url))).status;
		expect(await status("https://careers.example/jobs?ref=456")).toBe(
			"unknown",
		);
		expect(await status("https://careers.example/jobs")).toBe("unknown");
		expect(await status("https://careers.example:8443/jobs?ref=123")).toBe(
			"unknown",
		);
		expect(await status("https://careers.example/jobs/x?ref=123")).toBe(
			"unknown",
		);
		expect(await status("https://jobs.careers.example/jobs?ref=123")).toBe(
			"unknown",
		);
		// The same posting: another scheme, case in the host, a tracking parameter, a slash.
		expect(
			await status("http://Careers.example/jobs/?utm_source=feed&ref=123"),
		).toBe("gone");
	});

	it("reads a relative posting URL against the final page, and a same-site redirect as the posting", async () => {
		const now = () => new Date("2026-11-03T12:00:00Z");
		const expired = (url: string) =>
			`<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Engineer", url, validThrough: "2025-05-01" })}</script>`;
		const page = (
			final: string,
			redirects: string[],
			html: string,
			status = 200,
		) => ({
			sources: {},
			now,
			fetchPage: async () => ({ status, url: final, redirects, html }),
		});
		const stored = "https://careers.example/jobs/1";
		const job = boardJob({ source: "web", url: stored });
		// The page names itself "/jobs/1".
		expect(
			(await checkPostingOpen(job, page(stored, [stored], expired("/jobs/1"))))
				.status,
		).toBe("gone");
		// The stored /old/1 moved to its canonical /jobs/1 on the same site.
		const moved = boardJob({
			source: "web",
			url: "https://careers.example/old/1",
		});
		expect(
			(
				await checkPostingOpen(
					moved,
					page(
						stored,
						["https://careers.example/old/1", stored],
						expired("/jobs/1"),
					),
				)
			).status,
		).toBe("gone");
		// A redirect to another site says nothing about this posting, its data or its 404.
		const away = "https://jobs.other.example/jobs/1";
		expect(
			(
				await checkPostingOpen(
					moved,
					page(
						away,
						["https://careers.example/old/1", away],
						expired("/jobs/1"),
					),
				)
			).status,
		).toBe("unknown");
		expect(
			(
				await checkPostingOpen(
					moved,
					page(away, ["https://careers.example/old/1", away], "", 404),
				)
			).status,
		).toBe("unknown");
	});

	it("judges a web posting by its stored end date, then by its page: 404 or 410, or a passed end date", async () => {
		const now = () => new Date("2026-11-03T12:00:00Z");
		const web = (overrides: Partial<CheckableJob> = {}) =>
			boardJob({
				source: "web",
				url: "https://careers.example/jobs/1",
				...overrides,
			});
		const page = (status: number, html = "") => ({
			sources: {},
			now,
			fetchPage: async () => ({ status, html }),
		});
		const ld = (validThrough: string) =>
			`<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Engineer", url: "https://careers.example/jobs/1", description: "Build things with TypeScript and React across our product, ship features weekly and own them end to end.", hiringOrganization: { name: "Acme" }, validThrough })}</script>`;

		expect(
			await checkPostingOpen(
				web({ validThrough: new Date("2026-10-01T00:00:00Z") }),
				{ sources: {}, now },
			),
		).toMatchObject({
			status: "gone",
			reason: expect.stringMatching(/end date \(Oct 1, 2026\)/),
		});
		expect((await checkPostingOpen(web(), page(404))).status).toBe("gone");
		expect((await checkPostingOpen(web(), page(410))).status).toBe("gone");
		expect((await checkPostingOpen(web(), page(503))).status).toBe("unknown");
		expect((await checkPostingOpen(web(), page(403))).status).toBe("unknown");
		expect(
			(await checkPostingOpen(web(), page(200, ld("2026-10-20")))).status,
		).toBe("gone");
		expect(
			(await checkPostingOpen(web(), page(200, ld("2026-12-20")))).status,
		).toBe("open");
		expect(
			(await checkPostingOpen(web(), page(200, "<p>Careers</p>"))).status,
		).toBe("unknown");
		expect(
			(
				await checkPostingOpen(web(), {
					sources: {},
					fetchPage: async () => {
						throw new Error("ECONNRESET");
					},
				})
			).status,
		).toBe("unknown");
	});
});

describe("postingAge", () => {
	const now = new Date("2026-11-03T12:00:00Z");
	const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
	it("notes 'may be closed' only for LinkedIn, Indeed and Glassdoor postings past 14 days", () => {
		const linkedin = boardJob({
			source: "linkedin",
			url: "https://www.linkedin.com/jobs/view/1234567",
		});
		expect(
			postingAge(
				{ ...linkedin, publishedAt: days(20), firstSeenAt: days(2) },
				now,
			),
		).toMatchObject({ days: 20, mayBeClosed: true });
		expect(
			postingAge(
				{ ...linkedin, publishedAt: null, firstSeenAt: days(10) },
				now,
			),
		).toMatchObject({ days: 10, mayBeClosed: false });
		expect(
			postingAge(
				{ ...boardJob(), publishedAt: days(40), firstSeenAt: days(40) },
				now,
			),
		).toMatchObject({ days: 40, mayBeClosed: false });
	});
});

/** A store over a list: records what it was asked and what it closed. */
function memoryStore(jobs: CheckableJob[]) {
	const asked: { limit: number; foundBefore: Date; checkedBefore: Date }[] = [];
	const checks: { jobId: string; gone?: string }[] = [];
	const store: ClosedPostingStore = {
		sweepCandidates: async (_userId, options) => {
			asked.push(options);
			return jobs.slice(0, options.limit);
		},
		recordCheck: async (_userId, jobId, check) => {
			checks.push({ jobId, gone: check.gone?.reason });
			return check.gone !== undefined;
		},
	};
	return { store, asked, checks };
}

describe("sweepClosedPostings", () => {
	const now = () => new Date("2026-11-03T12:00:00Z");
	const many = Array.from({ length: 6 }, (_, i) =>
		boardJob({ jobId: `j${i}`, externalId: String(5000 + i) }),
	);

	it("checks at most the per-scan cap, one at a time with a gap, and closes only what is gone", async () => {
		const { fetchImpl, asked } = routes({
			"/jobs/5000": { status: 404 },
			"/jobs/5001": { status: 500 },
			"/jobs/5002": { status: 200, body: { id: 5002 } },
			...ghBoard(5001, 5002),
		});
		const { store, asked: storeAsked, checks } = memoryStore(many);
		const slept: number[] = [];
		const result = await sweepClosedPostings(
			{
				store,
				sources: { greenhouse: new GreenhouseSource(fetchImpl) },
				now,
				sleep: async (ms) => {
					slept.push(ms);
				},
			},
			"u1",
		);
		expect(storeAsked[0]?.limit).toBe(3);
		expect(storeAsked[0]?.foundBefore.toISOString()).toBe(
			"2026-10-27T12:00:00.000Z",
		);
		// Every request counts and waits its turn: three postings and one board.
		expect(asked).toEqual([
			"https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/5000",
			"https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs",
			"https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/5001",
			"https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/5002",
		]);
		expect(slept).toEqual([2_000, 2_000, 2_000]);
		expect(result).toEqual({ checked: 3, closed: ["j0"], unknown: 1 });
		expect(checks).toEqual([
			{
				jobId: "j0",
				gone: "Greenhouse no longer lists it (found by the scan's check)",
			},
			{ jobId: "j1", gone: undefined },
			{ jobId: "j2", gone: undefined },
		]);
	});

	it("spaces every request, the board's too, and reads a board once per sweep", async () => {
		const { fetchImpl, asked } = routes({
			"/jobs/500": { status: 404 },
			...ghBoard(4999),
		});
		const { store } = memoryStore(many);
		const order: string[] = [];
		const paced: FetchLike = async (url, init) => {
			order.push(`request ${url.split("/").pop()}`);
			return fetchImpl(url, init);
		};
		const result = await sweepClosedPostings(
			{
				store,
				sources: { greenhouse: new GreenhouseSource(paced) },
				now,
				sleep: async () => {
					order.push("wait");
				},
			},
			"u1",
		);
		expect(result.closed).toEqual(["j0", "j1", "j2"]);
		// Three missing postings on one board: four requests, a wait before each but the first.
		expect(asked).toHaveLength(4);
		expect(order).toEqual([
			"request 5000",
			"wait",
			"request jobs",
			"wait",
			"request 5001",
			"wait",
			"request 5002",
		]);
	});

	it("runs last in the scan and never fails it, even when its store throws", async () => {
		const repo = new MemoryRepo(null);
		const workflows = new LocalWorkflowStarter();
		const logged: string[] = [];
		const deps: PipelineDeps = {
			repo,
			sources: {},
			llm: new FakeLlmProvider(),
			notifier: new NoopNotifier(),
			workflows,
			providers: async () => [],
			closedPostings: {
				sweepCandidates: async () => {
					throw new Error("database is locked");
				},
				recordCheck: async () => false,
			},
			log: (message) => logged.push(message),
		};
		workflows.bind(deps);
		const result = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		expect(result.closedPostings).toBeUndefined();
		expect(logged).toContain("closed posting check failed");
		expect(logged).toContain("scan finished");
	});
});

describe("politePageFetcher", () => {
	/** A site of pages: status, an optional redirect; records each URL fetched. */
	function site(pages: Record<string, { status: number; location?: string }>) {
		const fetched: string[] = [];
		const robotsAsked: string[] = [];
		return {
			fetched,
			robotsAsked,
			deps: (disallow: string[] = []) => ({
				fetchOnce: async (url: string) => {
					fetched.push(url);
					const page = pages[url] ?? { status: 404 };
					return { status: page.status, location: page.location, html: "" };
				},
				robotsAllow: async (url: string) => {
					robotsAsked.push(url);
					return !disallow.some((d) => url.startsWith(d));
				},
			}),
		};
	}
	const signal = () => new AbortController().signal;

	it("asks robots.txt before the first request and refuses a disallowed page (unknown, never closed)", async () => {
		const s = site({ "https://careers.example/jobs/1": { status: 404 } });
		const fetchPage = politePageFetcher(
			s.deps(["https://careers.example/jobs"]),
		);
		await expect(
			fetchPage("https://careers.example/jobs/1", signal()),
		).rejects.toThrow(/robots\.txt/);
		expect(s.fetched).toEqual([]);
		const check = await checkPostingOpen(
			boardJob({ source: "web", url: "https://careers.example/jobs/1" }),
			{ sources: {}, fetchPage },
		);
		expect(check.status).toBe("unknown");
	});

	it("checks every redirect: never follows one to LinkedIn, Indeed or Glassdoor, or past robots.txt", async () => {
		const s = site({
			"https://careers.example/jobs/1": {
				status: 302,
				location: "https://www.linkedin.com/jobs/view/1234567",
			},
			"https://careers.example/jobs/2": {
				status: 301,
				location: "https://other.example/old",
			},
			"https://careers.example/jobs/3": {
				status: 302,
				location: "/jobs/3b",
			},
			"https://careers.example/jobs/3b": { status: 410 },
		});
		const fetchPage = politePageFetcher(s.deps(["https://other.example/"]));
		await expect(
			fetchPage("https://careers.example/jobs/1", signal()),
		).rejects.toThrow(/LinkedIn, Indeed or Glassdoor/);
		await expect(
			fetchPage("https://careers.example/jobs/2", signal()),
		).rejects.toThrow(/robots\.txt/);
		expect(await fetchPage("https://careers.example/jobs/3", signal())).toEqual(
			{
				status: 410,
				html: "",
				url: "https://careers.example/jobs/3b",
				redirects: [
					"https://careers.example/jobs/3",
					"https://careers.example/jobs/3b",
				],
			},
		);
		expect(s.fetched).toEqual([
			"https://careers.example/jobs/1",
			"https://careers.example/jobs/2",
			"https://careers.example/jobs/3",
			"https://careers.example/jobs/3b",
		]);
		expect(s.robotsAsked).toContain("https://other.example/old");
		expect(s.robotsAsked).toContain("https://careers.example/jobs/3b");
	});
});

describe("the scan's re-check after a crash", () => {
	/**
	 * A durable step journal (as the runner keeps one): a completed step's result is replayed by
	 * its name and occurrence. `crashWhen` ends the process right after a step ran, before its
	 * result was saved, as a kill -9 would.
	 */
	function journal(crashWhen: () => boolean) {
		const saved = new Map<string, unknown>();
		let crashed = false;
		const make = (): FlowStep => {
			const seen = new Map<string, number>();
			return {
				async do<T>(name: string, fn: (signal?: AbortSignal) => Promise<T>) {
					const n = (seen.get(name) ?? 0) + 1;
					seen.set(name, n);
					const key = `${name}#${n}`;
					if (saved.has(key)) return saved.get(key) as T;
					const result = await fn();
					if (!crashed && crashWhen()) {
						crashed = true;
						throw new Error("worker killed");
					}
					saved.set(key, result);
					return result;
				},
				waitForEvent: async () => {
					throw new Error("no waits here");
				},
			};
		};
		return { make };
	}

	it("a replay re-uses the scan's picked postings: never more than the per-scan cap", async () => {
		const jobs = Array.from({ length: 6 }, (_, i) =>
			boardJob({ jobId: `j${i}`, externalId: String(6000 + i) }),
		);
		const checkedAt = new Map<string, Date>();
		const { fetchImpl, asked } = routes({
			"/jobs/": async () =>
				new Response(
					JSON.stringify({ id: Number(asked.at(-1)?.split("/").pop()) }),
					{
						status: 200,
					},
				),
		});
		const postingsChecked = () =>
			new Set(asked.map((u) => u.split("/").pop())).size;
		const { make } = journal(() => postingsChecked() === 3);
		const deps = (): PipelineDeps => {
			const workflows = new LocalWorkflowStarter();
			const d: PipelineDeps = {
				repo: new MemoryRepo(null),
				sources: { greenhouse: new GreenhouseSource(fetchImpl) },
				llm: new FakeLlmProvider(),
				notifier: new NoopNotifier(),
				workflows,
				providers: async () => [],
				sleep: async () => {},
				closedPostings: {
					// The longest-unchecked first: a job checked before moves to the back.
					sweepCandidates: async (_u, o) =>
						jobs.filter((j) => !checkedAt.has(j.jobId)).slice(0, o.limit),
					recordCheck: async (_u, jobId, check) => {
						checkedAt.set(jobId, check.at);
						return false;
					},
				},
			};
			workflows.bind(d);
			return d;
		};
		// The first run dies right after its third check; the runner then replays the scan.
		await runScanFlow(make(), deps(), { userId: "u1", trigger: "cli" }).catch(
			() => {},
		);
		await runScanFlow(make(), deps(), { userId: "u1", trigger: "cli" });
		expect(postingsChecked()).toBe(3);
	});
});
