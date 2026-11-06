import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const JOBS_DIR = path.resolve(
	import.meta.dirname,
	"../../../packages/core/test/fixtures",
);

const posting = (file: string) =>
	fs
		.readFileSync(path.join(JOBS_DIR, file), "utf8")
		.split("\n")
		.map(
			(line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`,
		)
		.join("");

/** Greenhouse's public board API for one fabricated company, "acmerobotics". */
function greenhouseBoard(base: string) {
	return {
		jobs: [
			{
				id: 4001,
				title: "Senior Full-Stack Engineer",
				absolute_url: `${base}/postings/acme/4001`,
				location: { name: "Remote - Worldwide" },
				content: posting("acme-senior-fullstack.txt"),
				updated_at: "2026-10-30T10:00:00Z",
				company_name: "Acme Robotics",
			},
			{
				id: 4002,
				title: "Senior Frontend Engineer",
				absolute_url: `${base}/postings/acme/4002`,
				location: { name: "Remote - Worldwide" },
				content: posting("nimbus-senior-frontend.txt").replace(
					/Nimbus Labs/g,
					"Acme Robotics",
				),
				updated_at: "2026-10-30T10:00:00Z",
				company_name: "Acme Robotics",
			},
			{
				id: 4003,
				title: "Senior Full Stack Engineer",
				absolute_url: `${base}/postings/acme/4003`,
				location: { name: "Fully remote (Europe)" },
				content: posting("northbeam-senior-fullstack.txt"),
				updated_at: "2026-10-30T10:00:00Z",
				company_name: "Acme Robotics",
			},
		],
	};
}

/** A Greenhouse posting's own API page: the posting while listed, else 404; `status` overrides. */
function postingPage(
	res: http.ServerResponse,
	listed: { id: number }[],
	id: number,
	status: number | null,
) {
	const job = listed.find((j) => j.id === id);
	const code = status ?? (job ? 200 : 404);
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(code === 200 ? job : {}));
}

const SR_ID = "744000200000001";

/**
 * The five boards added on 2026-11-07, one fabricated Acme Robotics posting each: the site its
 * search names, the posting's URL a search would list, and the board's public data, by host and
 * path. Recruitee, Teamtailor and Personio key the company in the subdomain, so their stand-in
 * hosts name the company.
 */
const MORE_BOARDS: {
	site: string;
	url: string;
	host: string;
	path: string;
	type: string;
	body: () => string;
}[] = [
	{
		site: "site:jobs.smartrecruiters.com",
		url: `https://jobs.smartrecruiters.com/AcmeRobotics/${SR_ID}-senior-platform-engineer`,
		host: "api.smartrecruiters.com",
		path: `/v1/companies/AcmeRobotics/postings/${SR_ID}`,
		type: "application/json",
		body: () =>
			JSON.stringify({
				id: SR_ID,
				name: "Senior Platform Engineer",
				company: { identifier: "AcmeRobotics", name: "Acme Robotics" },
				releasedDate: "2026-10-30T10:00:00.000Z",
				location: {
					city: "Lisbon",
					fullLocation: "Lisbon, , Portugal",
					remote: true,
				},
				postingUrl: `https://jobs.smartrecruiters.com/AcmeRobotics/${SR_ID}-senior-platform-engineer`,
				active: true,
				jobAd: {
					sections: {
						jobDescription: {
							title: "Job Description",
							text: posting("acme-senior-fullstack.txt"),
						},
					},
				},
			}),
	},
	{
		site: "site:apply.workable.com",
		url: "https://apply.workable.com/acme-robotics/j/A1B2C3D4E5/",
		host: "apply.workable.com",
		path: "/api/v1/widget/accounts/acme-robotics",
		type: "application/json",
		body: () =>
			JSON.stringify({
				name: "Acme Robotics",
				jobs: [
					{
						title: "Senior Design Engineer",
						shortcode: "A1B2C3D4E5",
						telecommuting: true,
						published_on: "2026-10-30",
						locations: [{ city: "Utrecht", country: "Netherlands" }],
						description: posting("nimbus-senior-frontend.txt").replace(
							/Nimbus Labs/g,
							"Acme Robotics",
						),
					},
				],
			}),
	},
	{
		site: "site:recruitee.com",
		url: "https://acmerobotics.recruitee.com/o/senior-backend-engineer",
		host: "acmerobotics.recruitee.com",
		path: "/api/offers/",
		type: "application/json",
		body: () =>
			JSON.stringify({
				offers: [
					{
						id: 3000001,
						slug: "senior-backend-engineer",
						title: "Senior Backend Engineer",
						status: "published",
						description: posting("northbeam-senior-fullstack.txt"),
						requirements: "<ul><li>Five years of backend work</li></ul>",
						location: "Remote",
						remote: true,
						published_at: "2026-10-30 10:00:00 UTC",
						company_name: "Acme Robotics",
					},
				],
			}),
	},
	{
		site: "site:teamtailor.com",
		url: "https://acmerobotics.teamtailor.com/jobs/5550001-senior-mobile-engineer",
		host: "acmerobotics.teamtailor.com",
		path: "/jobs.rss",
		type: "application/rss+xml",
		body: () =>
			`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel><title>Acme Robotics</title><item><title>Senior Mobile Engineer</title><description>${posting("acme-senior-fullstack.txt").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</description><pubDate>Fri, 30 Oct 2026 10:00:00 +0000</pubDate><link>https://acmerobotics.teamtailor.com/jobs/5550001-senior-mobile-engineer</link><remoteStatus>fully</remoteStatus><tt:locations><tt:location><tt:city>Stockholm</tt:city><tt:country>Sweden</tt:country></tt:location></tt:locations></item></channel></rss>`,
	},
	{
		site: "site:jobs.personio.de",
		url: "https://acmerobotics.jobs.personio.de/job/2900001",
		host: "acmerobotics.jobs.personio.de",
		path: "/xml",
		type: "text/xml",
		body: () =>
			`<?xml version="1.0" encoding="UTF-8"?><workzag-jobs><position><id>2900001</id><subcompany>Acme Robotics GmbH</subcompany><office>Remote (Germany)</office><name>Senior Data Engineer</name><jobDescriptions><jobDescription><name>Your mission</name><value><![CDATA[${posting("acme-senior-fullstack.txt")}]]></value></jobDescription></jobDescriptions><createdAt>2026-10-30T10:00:00+00:00</createdAt></position></workzag-jobs>`,
	},
];

/**
 * Stand-ins for the job boards' public APIs and DuckDuckGo's HTML results pages on 127.0.0.1. The
 * app is started with the board hosts rewritten here and its DuckDuckGo tab pointed here
 * (`siteOrigins`), so a scan never leaves this Mac. Counts requests. With `moreBoards`, a search
 * naming one of the five boards added on 2026-11-07 lists that board's posting; without it every
 * search lists the Greenhouse postings, as before.
 */
export async function startFixtureBoards(
	options: { moreBoards?: boolean } = {},
) {
	const requests: string[] = [];
	/** Queries the search stand-in answered. */
	const searches: string[] = [];
	/** Jobs added after the first scan (a later scan finds them as new). */
	const extra: ReturnType<typeof greenhouseBoard>["jobs"] = [];
	/** Postings taken down since: gone from the board and from their own API page. */
	const removed = new Set<number>();
	/** When set, every posting's own API page answers this status (a board having trouble). */
	let postingStatus: number | null = null;
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://fixture");
		requests.push(url.pathname);
		const [host, ...rest] = url.pathname.slice(1).split("/");
		const tail = `/${rest.join("/")}`;
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		if (
			host === "boards-api.greenhouse.io" &&
			tail === "/v1/boards/acmerobotics/jobs"
		) {
			res.writeHead(200, { "content-type": "application/json" });
			const board = greenhouseBoard(base);
			res.end(
				JSON.stringify({
					jobs: [...board.jobs, ...extra].filter((j) => !removed.has(j.id)),
				}),
			);
			return;
		}
		// One posting's own page in the board API (the closed-posting check): 404 once removed.
		const one = tail.match(/^\/v1\/boards\/acmerobotics\/jobs\/(\d+)$/);
		if (host === "boards-api.greenhouse.io" && one) {
			const listed = [...greenhouseBoard(base).jobs, ...extra].filter(
				(j) => !removed.has(j.id),
			);
			postingPage(res, listed, Number(one[1]), postingStatus);
			return;
		}
		const more = MORE_BOARDS.find((b) => b.host === host && b.path === tail);
		if (more) {
			res.writeHead(200, { "content-type": more.type });
			res.end(more.body());
			return;
		}
		// DuckDuckGo's HTML results page (the live page's markup): every Acme posting, as a web
		// search would list them, through DuckDuckGo's /l/?uddg= redirect, plus one other page.
		if (host === "html") {
			const q = url.searchParams.get("q") ?? "";
			searches.push(q);
			// Web search's queries name no site: results on careers pages and job sites.
			if (!/\bsite:/.test(q)) {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(webResults(base));
				return;
			}
			const ids = [...greenhouseBoard(base).jobs, ...extra].map((j) => j.id);
			const result = (target: string, title: string) =>
				`<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=x">${title}</a></h2></div></div>`;
			const board = options.moreBoards
				? MORE_BOARDS.find((b) => q.includes(b.site))
				: undefined;
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(
				`<!doctype html><html><head><title>${url.searchParams.get("q")} at DuckDuckGo</title></head><body><div id="links" class="results">${[
					...(board
						? [result(board.url, "A posting")]
						: ids.map((id) =>
								result(
									`https://boards.greenhouse.io/acmerobotics/jobs/${id}`,
									`Job ${id}`,
								),
							)),
					result("https://www.example.com/careers", "Not a posting"),
				].join("")}</div></body></html>`,
			);
			return;
		}
		// Web search's stand-in pages (robots.txt: none, so every page may be read).
		if (host === "web") {
			const html = WEB_PAGES(base)[tail];
			res.writeHead(html ? 200 : 404, {
				"content-type": "text/html; charset=utf-8",
			});
			res.end(html ?? "");
			return;
		}
		if (host === "api.ashbyhq.com") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ jobs: [] }));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		base,
		requests,
		searches,
		/**
		 * Every board host a scan may read, the five added boards' always (a search that lists one
		 * of their postings must never reach the real site): one entry per exact host.
		 */
		rewrite: {
			"boards-api.greenhouse.io": base,
			"api.lever.co": base,
			"api.ashbyhq.com": base,
			...Object.fromEntries(MORE_BOARDS.map((b) => [b.host, base])),
		} as Record<string, string>,
		/** The site tabs' stand-ins: DuckDuckGo's pages, and web search's result pages. */
		siteOrigins: { duckduckgo: base, web: base } as Record<string, string>,
		addJob: (id: number, title: string) =>
			extra.push({
				id,
				title,
				absolute_url: `${base}/postings/acme/${id}`,
				location: { name: "Remote - Worldwide" },
				content: posting("acme-senior-fullstack.txt").replace(
					"Senior Full-Stack Engineer",
					title,
				),
				updated_at: "2026-10-31T10:00:00Z",
				company_name: "Acme Robotics",
			}),
		/** Takes a posting down: the board stops listing it and its API page answers 404. */
		removeJob: (id: number) => removed.add(id),
		/** Every posting's API page answers `status` (500: trouble), or as usual with null. */
		failPostings: (status: number | null) => {
			postingStatus = status;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const LONG_POSTING =
	"<p>You will build the design system our product teams share, in React and TypeScript.</p><ul><li>Requirements: five years of frontend work and a design system you shipped</li><li>Responsibilities: own components end to end, review code, write the docs</li></ul>";
const jsonLd = (value: unknown) =>
	`<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const jobPosting = (title: string, extra: Record<string, unknown> = {}) => ({
	"@context": "https://schema.org",
	"@type": "JobPosting",
	title,
	hiringOrganization: { "@type": "Organization", name: "Tessera Labs" },
	jobLocationType: "TELECOMMUTE",
	description: LONG_POSTING,
	datePosted: "2026-10-30",
	...extra,
});

/** Web search's result pages: two postings, and four pages that are not a job to keep. */
function WEB_PAGES(base: string): Record<string, string> {
	return {
		// schema.org JobPosting: read without a model.
		"/careers/design-systems-engineer": `<!doctype html><html><head><title>Design Systems Engineer · Tessera Labs</title>${jsonLd({ "@graph": [{ "@type": "WebPage" }, jobPosting("Design Systems Engineer", { url: `${base}/web/careers/design-systems-engineer` })] })}</head><body><main><h1>Design Systems Engineer</h1>${LONG_POSTING}</main></body></html>`,
		// No job data: the (fake) model reads it.
		"/careers/platform-engineer": `<!doctype html><html><head><title>Platform Engineer</title><meta property="og:site_name" content="Nimbus Cloud"></head><body><main><h1>Platform Engineer</h1><p>About the role: you will run the platform at Nimbus Cloud, remote in Europe.</p><p>Requirements: Go, Kubernetes and five years of platform work.</p><p>Responsibilities: own the deploy pipeline, keep the clusters healthy, mentor the team.</p></main></body></html>`,
		"/blog/hiring-tips": `<!doctype html><html><head><title>Hiring tips</title></head><body><article><h1>Five hiring tips</h1><p>${"Notes from our recruiting team about interviews and offers. ".repeat(5)}</p></article></body></html>`,
		"/jobs/search": `<!doctype html><html><head><title>Jobs</title>${jsonLd([jobPosting("Frontend Engineer"), jobPosting("Backend Engineer")])}</head><body><main><h1>Jobs</h1></main></body></html>`,
		"/careers/old-role": `<!doctype html><html><head><title>Old role</title>${jsonLd(jobPosting("Staff Engineer", { validThrough: "2026-01-31" }))}</head><body><main><h1>Staff Engineer</h1></main></body></html>`,
	};
}

/** DuckDuckGo's HTML results for a web search: the stand-in's pages, and a LinkedIn posting. */
function webResults(base: string): string {
	const result = (target: string, title: string) =>
		`<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=x">${title}</a></h2></div></div>`;
	const links = [
		[`${base}/web/careers/design-systems-engineer`, "Design Systems Engineer"],
		["https://www.linkedin.com/jobs/view/4000000001/", "On LinkedIn"],
		[`${base}/web/careers/platform-engineer`, "Platform Engineer"],
		[`${base}/web/blog/hiring-tips`, "Hiring tips"],
		[`${base}/web/jobs/search`, "Jobs"],
		[`${base}/web/careers/old-role`, "Old role"],
	];
	return `<!doctype html><html><head><title>web search at DuckDuckGo</title></head><body><div id="links" class="results">${links.map(([u, t]) => result(u as string, t as string)).join("")}</div></body></html>`;
}
