import { describe, expect, it } from "vitest";
import { BOARDS, type Board } from "../src/apply/forms";
import { submissionModeFor, submissionModeForSource } from "../src/apply/modes";
import { sourceMismatch } from "../src/domain/source";
import { JOB_SOURCES } from "../src/domain/types";
import { checkPostingOpen } from "../src/pipeline/closed";
import { companyNameFor } from "../src/pipeline/providers";
import { routeJobLink } from "../src/sources/link";
import { PersonioSource } from "../src/sources/personio";
import { RecruiteeSource } from "../src/sources/recruitee";
import { postingFromUrl, SEARCH_BOARDS } from "../src/sources/search";
import { SmartRecruitersSource } from "../src/sources/smartrecruiters";
import { TeamtailorSource } from "../src/sources/teamtailor";
import {
	BoardNotFoundError,
	companyOrigin,
	type FetchLike,
	type RequestPacing,
} from "../src/sources/types";
import { WorkableSource } from "../src/sources/workable";
import { coveredByOtherSource } from "../src/web/hosts";
import { fixture } from "./helpers";

const NEW_BOARDS = [
	"smartrecruiters",
	"workable",
	"recruitee",
	"teamtailor",
	"personio",
] as const;

type Route = { status?: number; body: string };

/** Answers exact URLs only (a query string included); anything else is a 404. Counts calls. */
function exact(routes: Record<string, Route>): FetchLike & { calls: string[] } {
	const calls: string[] = [];
	const impl = async (input: string) => {
		calls.push(input);
		const route = routes[input];
		if (!route) return new Response("Not Found", { status: 404 });
		return new Response(route.body, { status: route.status ?? 200 });
	};
	return Object.assign(impl, { calls });
}

const json = (value: unknown) => JSON.stringify(value);
const board = (name: string) => fixture(`boards/${name}`);

/** A sweep's pacing that counts its turns and shares board reads. */
function pacing(): RequestPacing & { turns: number } {
	const p = {
		turns: 0,
		boards: new Map(),
		before: async () => {
			p.turns += 1;
		},
	};
	return p;
}

describe("posting URLs on the new boards", () => {
	it("reads the board, company and posting id from each board's posting URLs", () => {
		expect(
			postingFromUrl(
				"https://jobs.smartrecruiters.com/HarborMills/744000100000001-senior-platform-engineer?trid=x",
			),
		).toMatchObject({
			board: "smartrecruiters",
			companyKey: "HarborMills",
			jobId: "744000100000001",
		});
		expect(
			postingFromUrl("https://apply.workable.com/lumen-labs/j/a1b2c3d4e5/"),
		).toMatchObject({
			board: "workable",
			companyKey: "lumen-labs",
			jobId: "A1B2C3D4E5",
		});
		expect(
			postingFromUrl(
				"https://Quarry.recruitee.com/o/backend-engineer-payments/c/new",
			),
		).toMatchObject({
			board: "recruitee",
			companyKey: "quarry",
			jobId: "backend-engineer-payments",
		});
		expect(
			postingFromUrl(
				"https://nimbusfreight.teamtailor.com/jobs/5550001-senior-mobile-engineer",
			),
		).toMatchObject({
			board: "teamtailor",
			companyKey: "nimbusfreight",
			jobId: "5550001",
		});
		expect(
			postingFromUrl("https://nimbusfreight.teamtailor.com/en-GB/jobs/5550002"),
		).toMatchObject({ board: "teamtailor", jobId: "5550002" });
		expect(
			postingFromUrl(
				"https://kestrel.jobs.personio.de/job/2900001?language=en",
			),
		).toMatchObject({
			board: "personio",
			companyKey: "kestrel",
			jobId: "2900001",
		});
		expect(
			postingFromUrl("https://kestrel.jobs.personio.com/job/2900001"),
		).toMatchObject({ board: "personio", companyKey: "kestrel" });
	});

	it("never reads another host, a nested subdomain, a user name or a board's own pages", () => {
		for (const url of [
			// Another host after the board's name, or a user name before it.
			"https://acme.recruitee.com.evil.net/o/x",
			"https://acme.recruitee.com@evil.net/o/x",
			"https://acme.teamtailor.com.evil.net/jobs/1-x",
			"https://acme.jobs.personio.de.evil.net/job/1",
			"https://jobs.smartrecruiters.com.evil.net/Acme/744000100000001",
			"https://apply.workable.com.evil.net/acme/j/A1B2C3D4E5",
			// Not exactly one label as the company.
			"https://a.b.recruitee.com/o/x",
			"https://a.b.teamtailor.com/jobs/1-x",
			"https://a.b.jobs.personio.de/job/1",
			// Look-alike names.
			"https://evilrecruitee.com/o/x",
			"https://acme.evilteamtailor.com/jobs/1",
			"https://example.com/acme.recruitee.com/o/x",
			// A port.
			"https://acme.recruitee.com:8443/o/x",
			// The boards' own sites and pages that are not one posting.
			"https://www.recruitee.com/o/pricing",
			"https://app.teamtailor.com/jobs/123",
			"https://acme.recruitee.com/",
			"https://acme.teamtailor.com/jobs",
			"https://acme.jobs.personio.de/",
			"https://jobs.smartrecruiters.com/HarborMills",
			"https://apply.workable.com/lumen-labs/",
			// Workable's short link names no account.
			"https://apply.workable.com/j/A1B2C3D4E5",
		])
			expect(postingFromUrl(url), url).toBeNull();
	});

	it("adds a pasted posting link through the board's reader", () => {
		const route = routeJobLink(
			new URL("https://quarry.recruitee.com/o/support-lead"),
		);
		expect(route).toMatchObject({
			kind: "board",
			posting: { board: "recruitee", companyKey: "quarry" },
		});
		expect(
			routeJobLink(new URL("https://acme.recruitee.com.evil.net/o/x")),
		).toEqual({
			kind: "page",
		});
	});

	it("checks a board label against the posting's host", () => {
		expect(
			sourceMismatch(
				"recruitee",
				"https://quarry.recruitee.com/o/backend-engineer-payments",
			),
		).toBeNull();
		expect(
			sourceMismatch("personio", "https://kestrel.jobs.personio.de/job/1"),
		).toBeNull();
		expect(sourceMismatch("workable", "https://example.com/job/1")).toMatch(
			/not on Workable/,
		);
	});

	it("leaves the boards' pages to job-board search, never to web search", () => {
		for (const url of [
			"https://jobs.smartrecruiters.com/HarborMills/744000100000001",
			"https://apply.workable.com/lumen-labs/j/A1B2C3D4E5/",
			"https://quarry.recruitee.com/o/support-lead",
			"https://nimbusfreight.teamtailor.com/jobs/5550001",
			"https://kestrel.jobs.personio.de/job/2900001",
		])
			expect(coveredByOtherSource(url), url).toBe(true);
	});
});

describe("company subdomains", () => {
	it("builds only the board's own subdomain from a key", () => {
		expect(companyOrigin("recruitee", "Quarry", "recruitee.com")).toBe(
			"https://quarry.recruitee.com",
		);
		for (const key of [
			"evil.net/",
			"a.b",
			"x@evil.net",
			"evil.net#",
			"-acme",
			"",
			"acme:8080",
			"a".repeat(64),
		])
			expect(
				() => companyOrigin("recruitee", key, "recruitee.com"),
				key,
			).toThrow(BoardNotFoundError);
	});

	it("never fetches with a key that is not one label", async () => {
		const fetchImpl = exact({});
		for (const source of [
			new RecruiteeSource(fetchImpl),
			new TeamtailorSource(fetchImpl),
			new PersonioSource(fetchImpl),
		]) {
			await expect(
				source.listJobs({ sourceKey: "evil.example/x" }),
			).rejects.toBeInstanceOf(BoardNotFoundError);
			await expect(
				source.checkPosting("evil.example/x", "1"),
			).rejects.toBeInstanceOf(BoardNotFoundError);
		}
		expect(fetchImpl.calls).toEqual([]);
	});
});

describe("SmartRecruitersSource", () => {
	const API = "https://api.smartrecruiters.com/v1/companies/HarborMills";
	const ID = "744000100000001";

	it("reads only the postings asked for, one page each, and maps the job ad", async () => {
		const fetchImpl = exact({
			[`${API}/postings/${ID}`]: {
				body: board("smartrecruiters-posting.json"),
			},
			[`${API}/postings/744000100000009`]: {
				status: 404,
				body: json({ code: "RESOURCE_NOT_FOUND" }),
			},
		});
		const jobs = await new SmartRecruitersSource(fetchImpl, 0).listJobs({
			sourceKey: "HarborMills",
			postingIds: [ID, "744000100000009"],
		});
		// No list read: the list has no descriptions.
		expect(fetchImpl.calls).toEqual([
			`${API}/postings/${ID}`,
			`${API}/postings/744000100000009`,
		]);
		expect(jobs).toHaveLength(1);
		const job = jobs[0];
		expect(job).toMatchObject({
			source: "smartrecruiters",
			externalId: ID,
			url: "https://jobs.smartrecruiters.com/HarborMills/744000100000001-senior-platform-engineer",
			title: "Senior Platform Engineer",
			locations: ["Lisbon, Portugal"],
			workplaceType: "hybrid",
			department: "Engineering",
			employmentType: "Full-time",
			companyName: "Harbor Mills",
		});
		expect(job?.publishedAt?.toISOString()).toBe("2026-10-30T09:15:00.000Z");
		expect(job?.descriptionText).toContain("## Job Description");
		expect(job?.descriptionText).toContain("- Own the deploy pipeline");
		expect(job?.descriptionText).toContain("## Qualifications");
		// An empty section leaves no heading behind.
		expect(job?.descriptionText).not.toContain("Additional Information");
	});

	it("reads the newest postings' pages when no ids are given", async () => {
		const fetchImpl = exact({
			[`${API}/postings?limit=20`]: {
				body: board("smartrecruiters-list.json"),
			},
			[`${API}/postings/${ID}`]: {
				body: board("smartrecruiters-posting.json"),
			},
		});
		const jobs = await new SmartRecruitersSource(fetchImpl, 0).listJobs({
			sourceKey: "HarborMills",
		});
		expect(jobs.map((j) => j.externalId)).toEqual([ID]);
		expect(fetchImpl.calls).toHaveLength(3);
	});

	it("leaves out inactive, mismatched and malformed postings, and throws on trouble", async () => {
		const posting = JSON.parse(board("smartrecruiters-posting.json"));
		const fetchImpl = exact({
			[`${API}/postings/1000001`]: {
				body: json({ ...posting, id: "1000001", active: false }),
			},
			[`${API}/postings/1000002`]: { body: json(posting) },
			[`${API}/postings/1000003`]: { body: json({ unexpected: true }) },
			[`${API}/postings/1000004`]: { status: 400, body: "{}" },
		});
		expect(
			await new SmartRecruitersSource(fetchImpl, 0).listJobs({
				sourceKey: "HarborMills",
				postingIds: ["1000001", "1000002", "1000003", "1000004"],
			}),
		).toEqual([]);
		await expect(
			new SmartRecruitersSource(
				exact({ [`${API}/postings/1000005`]: { status: 503, body: "" } }),
				0,
			).listJobs({ sourceKey: "HarborMills", postingIds: ["1000005"] }),
		).rejects.toThrow(/HTTP 503/);
	});

	it("checks a posting: open, inactive, taken down, or unknown", async () => {
		const posting = board("smartrecruiters-posting.json");
		const list = board("smartrecruiters-list.json");
		const listUrl = `${API}/postings?limit=100`;
		const check = (routes: Record<string, Route>, id = ID) =>
			new SmartRecruitersSource(exact(routes), 0).checkPosting(
				"HarborMills",
				id,
			);
		expect(await check({ [`${API}/postings/${ID}`]: { body: posting } })).toBe(
			"open",
		);
		expect(
			await check({
				[`${API}/postings/${ID}`]: {
					body: json({ ...JSON.parse(posting), active: false }),
				},
			}),
		).toBe("gone");
		// 404, and the company's list answers with other postings.
		expect(await check({ [listUrl]: { body: list } }, "744000100000003")).toBe(
			"gone",
		);
		// 404, and the list is empty: the company may not exist. Unknown.
		await expect(
			check(
				{ [listUrl]: { body: json({ totalFound: 0, content: [] }) } },
				"744000100000003",
			),
		).rejects.toThrow(/lists no postings/);
		// 404 while the list still has it, a 400 (another company's), a 5xx: unknown.
		await expect(check({ [listUrl]: { body: list } })).rejects.toThrow(
			/still lists it/,
		);
		await expect(
			check({ [`${API}/postings/${ID}`]: { status: 400, body: "{}" } }),
		).rejects.toThrow(/HTTP 400/);
		await expect(
			check({
				[`${API}/postings/${ID}`]: {
					body: json({ ...JSON.parse(posting), id: "744000100000002" }),
				},
			}),
		).rejects.toThrow(/another posting/);
	});
});

describe("WorkableSource", () => {
	const ACCOUNT =
		"https://apply.workable.com/api/v1/widget/accounts/lumen-labs";

	it("maps the account's jobs with their descriptions", async () => {
		const jobs = await new WorkableSource(
			exact({
				[`${ACCOUNT}?details=true`]: { body: board("workable-account.json") },
			}),
		).listJobs({ sourceKey: "lumen-labs" });
		expect(jobs).toHaveLength(2);
		expect(jobs[0]).toMatchObject({
			source: "workable",
			externalId: "A1B2C3D4E5",
			url: "https://apply.workable.com/lumen-labs/j/A1B2C3D4E5/",
			title: "Frontend Engineer - EMEA Remote",
			// Hidden places are left out.
			locations: [
				"Utrecht, Netherlands",
				"Valencia, Valencian Community, Spain",
			],
			workplaceType: "remote",
			department: "Product",
			employmentType: "Full-time",
			companyName: "Lumen Labs",
		});
		expect(jobs[0]?.publishedAt?.toISOString()).toBe(
			"2026-10-29T00:00:00.000Z",
		);
		expect(jobs[0]?.descriptionText).toContain("React and TypeScript");
		expect(jobs[0]?.descriptionText).toContain("- Four years of frontend work");
		// No locations list: the job's own city; not remote, but its title says hybrid.
		expect(jobs[1]).toMatchObject({
			locations: ["Utrecht, Netherlands"],
			workplaceType: "hybrid",
		});
		// The URL reads back as the same posting.
		expect(postingFromUrl(jobs[0]?.url ?? "")).toMatchObject({
			board: "workable",
			companyKey: "lumen-labs",
			jobId: "A1B2C3D4E5",
		});
	});

	it("reports a missing account and a malformed answer", async () => {
		await expect(
			new WorkableSource(exact({})).listJobs({ sourceKey: "nope" }),
		).rejects.toBeInstanceOf(BoardNotFoundError);
		await expect(
			new WorkableSource(
				exact({ [`${ACCOUNT}?details=true`]: { body: json({ name: "x" }) } }),
			).listJobs({ sourceKey: "lumen-labs" }),
		).rejects.toBeInstanceOf(BoardNotFoundError);
	});

	it("checks a job: open, closed, taken down, or unknown", async () => {
		const job =
			"https://apply.workable.com/api/v2/accounts/lumen-labs/jobs/A1B2C3D4E5";
		const check = (routes: Record<string, Route>, p?: RequestPacing) =>
			new WorkableSource(exact(routes)).checkPosting(
				"lumen-labs",
				"a1b2c3d4e5",
				undefined,
				p,
			);
		expect(
			await check({
				[job]: { body: json({ shortcode: "A1B2C3D4E5", state: "published" }) },
			}),
		).toBe("open");
		expect(
			await check({
				[job]: { body: json({ shortcode: "A1B2C3D4E5", state: "closed" }) },
			}),
		).toBe("gone");
		const paced = pacing();
		expect(
			await check(
				{
					[ACCOUNT]: {
						body: json({ jobs: [{ shortcode: "F6E5D4C3B2", title: "x" }] }),
					},
				},
				paced,
			),
		).toBe("gone");
		// The job's page and the account's list each waited their turn.
		expect(paced.turns).toBe(2);
		await expect(check({})).rejects.toThrow(/board answers 404/);
		await expect(check({ [job]: { status: 429, body: "" } })).rejects.toThrow(
			/HTTP 429/,
		);
	});
});

describe("RecruiteeSource", () => {
	const ORIGIN = "https://quarry.recruitee.com";

	it("maps published offers, requirements included, at the company's Recruitee address", async () => {
		const jobs = await new RecruiteeSource(
			exact({
				[`${ORIGIN}/api/offers/`]: { body: board("recruitee-offers.json") },
			}),
		).listJobs({ sourceKey: "Quarry" });
		// The closed offer is left out.
		expect(jobs.map((j) => j.externalId)).toEqual([
			"backend-engineer-payments",
			"support-lead",
		]);
		expect(jobs[0]).toMatchObject({
			source: "recruitee",
			// Not the careers address on the company's own domain: matched by slug.
			url: `${ORIGIN}/o/backend-engineer-payments`,
			title: "Backend Engineer, Payments",
			locations: ["Amsterdam, Noord-Holland, Netherlands"],
			workplaceType: "hybrid",
			department: "Engineering",
			employmentType: "Full-time, permanent",
			companyName: "Quarry Systems",
		});
		expect(jobs[0]?.publishedAt?.toISOString()).toBe(
			"2026-10-30T16:32:58.000Z",
		);
		expect(jobs[0]?.descriptionText).toContain("build the payments API");
		expect(jobs[0]?.descriptionText).toContain("## Requirements");
		expect(jobs[0]?.descriptionText).toContain("Four years with Elixir or Go");
		expect(jobs[1]).toMatchObject({
			locations: ["Remote"],
			workplaceType: "remote",
			employmentType: "Part-time",
		});
		expect(jobs[1]?.descriptionText).not.toContain("Requirements");
	});

	it("reports a missing company and a malformed answer", async () => {
		await expect(
			new RecruiteeSource(exact({})).listJobs({ sourceKey: "quarry" }),
		).rejects.toBeInstanceOf(BoardNotFoundError);
		await expect(
			new RecruiteeSource(
				exact({ [`${ORIGIN}/api/offers/`]: { body: json({ error: "x" }) } }),
			).listJobs({ sourceKey: "quarry" }),
		).rejects.toBeInstanceOf(BoardNotFoundError);
		await expect(
			new RecruiteeSource(
				exact({ [`${ORIGIN}/api/offers/`]: { body: "<html>" } }),
			).listJobs({ sourceKey: "quarry" }),
		).rejects.toThrow();
	});

	it("checks an offer: open, closed, taken down, or unknown", async () => {
		const one = `${ORIGIN}/api/offers/support-lead`;
		const offers = board("recruitee-offers.json");
		const check = (routes: Record<string, Route>, slug = "support-lead") =>
			new RecruiteeSource(exact(routes)).checkPosting("quarry", slug);
		expect(
			await check({
				[one]: {
					body: json({
						offer: { slug: "support-lead", title: "x", status: "published" },
					}),
				},
			}),
		).toBe("open");
		expect(
			await check({
				[one]: {
					body: json({
						offer: { slug: "support-lead", title: "x", status: "closed" },
					}),
				},
			}),
		).toBe("gone");
		expect(
			await check({ [`${ORIGIN}/api/offers/`]: { body: offers } }, "gone-role"),
		).toBe("gone");
		await expect(
			check({ [`${ORIGIN}/api/offers/`]: { body: offers } }),
		).rejects.toThrow(/still lists it/);
		await expect(
			check({ [`${ORIGIN}/api/offers/`]: { body: json({ offers: [] }) } }),
		).rejects.toThrow(/lists no postings/);
	});
});

describe("TeamtailorSource", () => {
	const ORIGIN = "https://nimbusfreight.teamtailor.com";
	const rss = board("teamtailor-jobs.rss");

	it("maps the feed's jobs, places and remote status, named after the feed", async () => {
		const jobs = await new TeamtailorSource(
			exact({ [`${ORIGIN}/jobs.rss`]: { body: rss } }),
		).listJobs({ sourceKey: "nimbusfreight" });
		expect(jobs).toHaveLength(2);
		expect(jobs[0]).toMatchObject({
			source: "teamtailor",
			externalId: "5550001",
			// The company's own domain in the feed; stored at its Teamtailor address.
			url: `${ORIGIN}/jobs/5550001-senior-mobile-engineer`,
			title: "Senior Mobile Engineer",
			locations: ["Gothenburg, Sweden", "Oslo, Norway"],
			workplaceType: "remote",
			department: "Engineering",
			companyName: "Nimbus Freight",
		});
		expect(jobs[0]?.publishedAt?.toISOString()).toBe(
			"2026-11-03T18:37:57.000Z",
		);
		expect(jobs[0]?.descriptionText).toContain("### About Nimbus Freight");
		// Escaped twice in the feed: an ampersand in the text, not markup.
		expect(jobs[0]?.descriptionText).toContain("Europe & beyond");
		expect(jobs[0]?.descriptionText).toContain(
			"- Ship the Android and iOS apps",
		);
		expect(jobs[1]).toMatchObject({
			locations: ["Malmö, Sweden"],
			workplaceType: "onsite",
		});
	});

	it("reports a missing company and a page that is no feed", async () => {
		await expect(
			new TeamtailorSource(exact({})).listJobs({ sourceKey: "nimbusfreight" }),
		).rejects.toBeInstanceOf(BoardNotFoundError);
		await expect(
			new TeamtailorSource(
				exact({
					[`${ORIGIN}/jobs.rss`]: { body: "<html><body>Sign in</body></html>" },
				}),
			).listJobs({ sourceKey: "nimbusfreight" }),
		).rejects.toThrow(/not an RSS feed/);
	});

	it("checks a job against the feed, read once per sweep", async () => {
		const fetchImpl = exact({ [`${ORIGIN}/jobs.rss`]: { body: rss } });
		const source = new TeamtailorSource(fetchImpl);
		const paced = pacing();
		expect(
			await source.checkPosting("nimbusfreight", "5550001", undefined, paced),
		).toBe("open");
		expect(
			await source.checkPosting("nimbusfreight", "5559999", undefined, paced),
		).toBe("gone");
		expect(fetchImpl.calls).toHaveLength(1);
		expect(paced.turns).toBe(1);
		const empty = rss.replace(/<item>[\s\S]*<\/item>/, "");
		await expect(
			new TeamtailorSource(
				exact({ [`${ORIGIN}/jobs.rss`]: { body: empty } }),
			).checkPosting("nimbusfreight", "5550001"),
		).rejects.toThrow(/lists no jobs/);
		await expect(
			new TeamtailorSource(exact({})).checkPosting("nimbusfreight", "5550001"),
		).rejects.toThrow(/HTTP 404/);
	});
});

describe("PersonioSource", () => {
	const ORIGIN = "https://kestrel.jobs.personio.de";
	const xml = board("personio-feed.xml");

	it("maps the feed's positions, description sections and offices", async () => {
		const jobs = await new PersonioSource(
			exact({ [`${ORIGIN}/xml`]: { body: xml } }),
		).listJobs({ sourceKey: "kestrel" });
		expect(jobs).toHaveLength(2);
		expect(jobs[0]).toMatchObject({
			source: "personio",
			externalId: "2900001",
			url: `${ORIGIN}/job/2900001`,
			title: "Senior Backend Engineer (m/f/d)",
			locations: ["Berlin", "Remote (Germany)"],
			workplaceType: "remote",
			department: "Engineering",
			employmentType: "permanent, full-time",
			companyName: "Kestrel Works GmbH",
		});
		expect(jobs[0]?.publishedAt?.toISOString()).toBe(
			"2026-10-22T09:48:25.000Z",
		);
		expect(jobs[0]?.descriptionText).toContain("## Your mission");
		expect(jobs[0]?.descriptionText).toContain(
			"Build the billing service in Kotlin.",
		);
		expect(jobs[0]?.descriptionText).toContain("backend work & a service");
		expect(jobs[1]).toMatchObject({
			title: "Werkstudent:in Accounting (m/w/d)",
			locations: ["Munich"],
			workplaceType: "unknown",
			descriptionText: "",
		});
	});

	it("reports a missing company and a page that is no feed", async () => {
		await expect(
			new PersonioSource(exact({})).listJobs({ sourceKey: "kestrel" }),
		).rejects.toBeInstanceOf(BoardNotFoundError);
		await expect(
			new PersonioSource(
				exact({ [`${ORIGIN}/xml`]: { body: "<html>Maintenance</html>" } }),
			).listJobs({ sourceKey: "kestrel" }),
		).rejects.toThrow(/not a Personio feed/);
	});

	it("checks a position against the feed", async () => {
		const source = new PersonioSource(
			exact({ [`${ORIGIN}/xml`]: { body: xml } }),
		);
		expect(await source.checkPosting("kestrel", "2900002")).toBe("open");
		expect(await source.checkPosting("kestrel", "2900099")).toBe("gone");
		await expect(
			new PersonioSource(
				exact({
					[`${ORIGIN}/xml`]: {
						body: '<?xml version="1.0"?><workzag-jobs></workzag-jobs>',
					},
				}),
			).checkPosting("kestrel", "2900001"),
		).rejects.toThrow(/lists no positions/);
	});
});

describe("the new boards in the app", () => {
	it("are job sources and job-board search boards", () => {
		for (const kind of NEW_BOARDS) {
			expect(JOB_SOURCES).toContain(kind);
			expect(SEARCH_BOARDS).toContain(kind);
		}
	});

	it("are always handed off: nothing is filled or sent automatically", () => {
		expect([...BOARDS]).toEqual(["ashby", "greenhouse", "lever"]);
		for (const kind of NEW_BOARDS) {
			const url = "https://example.com/apply";
			expect(submissionModeForSource(kind, null, url).mode).toBe("handoff");
			expect(
				submissionModeForSource(kind, null, url, { autoSubmitFixtures: true })
					.mode,
			).toBe("handoff");
			expect(submissionModeFor(kind as unknown as Board, url).mode).toBe(
				"handoff",
			);
		}
	});

	it("take the company's name from the board, never from a page", async () => {
		let fetched = 0;
		const fetchImpl = (async () => {
			fetched += 1;
			return new Response("<title>x</title>");
		}) as typeof fetch;
		const job = {
			source: "recruitee" as const,
			externalId: "x",
			url: "https://quarry.recruitee.com/o/x",
			title: "X",
			locations: [],
			workplaceType: "unknown" as const,
			descriptionText: "",
		};
		expect(
			await companyNameFor(
				{ board: "recruitee", companyKey: "quarry" },
				[{ ...job, companyName: "Quarry Systems" }],
				fetchImpl,
			),
		).toBe("Quarry Systems");
		// None given: the key stands in, and no page is read.
		expect(
			await companyNameFor(
				{ board: "teamtailor", companyKey: "nimbus-freight" },
				[job],
				fetchImpl,
			),
		).toBe("Nimbus Freight");
		expect(fetched).toBe(0);
	});
});

describe("closed postings on the new boards", () => {
	const offers = board("recruitee-offers.json");
	const sources = (fetchImpl: FetchLike) => ({
		recruitee: new RecruiteeSource(fetchImpl),
		teamtailor: new TeamtailorSource(fetchImpl),
	});

	it("checks a scanned job by its board key and id, and names the board", async () => {
		const fetchImpl = exact({
			"https://quarry.recruitee.com/api/offers/": { body: offers },
		});
		const check = await checkPostingOpen(
			{
				jobId: "j1",
				source: "recruitee",
				url: "https://quarry.recruitee.com/o/gone-role",
				externalId: "gone-role",
				companyKey: "quarry",
				validThrough: null,
			},
			{ sources: sources(fetchImpl) },
		);
		expect(check).toEqual({
			status: "gone",
			reason: "Recruitee no longer lists it",
		});
	});

	it("checks a pasted link on a board through that board, and a lookalike host never", async () => {
		const fetchImpl = exact({
			"https://nimbusfreight.teamtailor.com/jobs.rss": {
				body: board("teamtailor-jobs.rss"),
			},
		});
		const pasted = (url: string) =>
			checkPostingOpen(
				{
					jobId: "j2",
					source: "manual",
					url,
					externalId: url,
					companyKey: "",
					validThrough: null,
				},
				{ sources: sources(fetchImpl) },
			);
		expect(
			await pasted("https://nimbusfreight.teamtailor.com/jobs/5550001-x"),
		).toEqual({ status: "open" });
		expect(fetchImpl.calls).toEqual([
			"https://nimbusfreight.teamtailor.com/jobs.rss",
		]);
		// Not a board posting: read as a page, which this check has no fetcher for.
		expect(
			(await pasted("https://nimbusfreight.teamtailor.com.evil.net/jobs/1"))
				.status,
		).not.toBe("gone");
		expect(fetchImpl.calls).toHaveLength(1);
	});
});
