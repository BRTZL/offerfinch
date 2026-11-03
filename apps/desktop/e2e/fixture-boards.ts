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

/**
 * Stand-ins for the job boards' public APIs and DuckDuckGo's HTML results pages on 127.0.0.1. The
 * app is started with the board hosts rewritten here and its DuckDuckGo tab pointed here
 * (`siteOrigins`), so a scan never leaves this Mac. Counts requests.
 */
export async function startFixtureBoards() {
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
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(
				`<!doctype html><html><head><title>${url.searchParams.get("q")} at DuckDuckGo</title></head><body><div id="links" class="results">${[
					...ids.map((id) =>
						result(
							`https://boards.greenhouse.io/acmerobotics/jobs/${id}`,
							`Job ${id}`,
						),
					),
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
		rewrite: {
			"boards-api.greenhouse.io": base,
			"api.lever.co": base,
			"api.ashbyhq.com": base,
		},
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
