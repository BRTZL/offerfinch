import { createServer, type Server } from "node:http";

/**
 * A local stand-in for LinkedIn's signed-in jobs pages, built to the selectors in
 * packages/core/src/linkedin/selectors.ts, for the runner's tests and e2e run. Nothing here talks
 * to LinkedIn. Every request is recorded so tests can count pages and prove nothing was posted.
 *
 * Top picks (/jobs/collections/recommended/): a new remote job and the Easy Apply job below.
 *
 * Searches (the `keywords` parameter picks the page):
 *   engineer   three results: an external-apply job whose employer link is a posting the user
 *              already has from Greenhouse, an Easy Apply job, and a new external-apply job.
 *              Any other keywords naming an engineer (a plan's title) give the same page
 *   security   redirects to a security check (/checkpoint/challenge/…)
 *   captcha    a results page with a CAPTCHA frame on top
 *   signedout  redirects to the sign-in wall (/authwall)
 *   warning    a results page with an account restriction notice
 *   layout     a page without the results list (the layout changed)
 *   empty      no results
 */

export interface LinkedInFixture {
	origin: string;
	server: Server;
	requests: { method: string; path: string }[];
	close(): Promise<void>;
}

const JOBS: Record<
	string,
	{
		title: string;
		company: string;
		location: string;
		prefs: string;
		apply: "easy" | { href: string };
		description: string;
	}
> = {
	"4100000001": {
		title: "Senior Full-Stack Engineer",
		company: "Acme Robotics",
		location: "Remote - Worldwide",
		prefs: "Remote Full-time",
		apply: {
			href: "/jobs/view/externalApply/4100000001?url=https%3A%2F%2Fjob-boards.greenhouse.io%2Facme-robotics%2Fjobs%2F7001&urlHash=x",
		},
		description:
			"<p>Build fleet software for warehouse robots.</p><ul><li>TypeScript and React</li><li>PostgreSQL</li></ul>",
	},
	"4100000002": {
		title: "Frontend Engineer",
		company: "Nimbus Labs",
		location: "Ankara, Türkiye",
		prefs: "Hybrid Full-time",
		apply: "easy",
		description:
			"<p>Work on our design system.</p><ul><li>React and TypeScript</li></ul>",
	},
	"4100000003": {
		title: "Senior Backend Engineer",
		company: "Orbit Freight",
		location: "Remote - Europe",
		prefs: "Remote Contract",
		apply: {
			href: "/jobs/view/externalApply/4100000003?url=https%3A%2F%2Fjobs.lever.co%2Forbit-freight%2Fabc-123%2Fapply",
		},
		description:
			"<p>Own the routing services. Our fraud team watches for unusual activity on shipments.</p><ul><li>Node.js and PostgreSQL</li></ul>",
	},
	"4100000004": {
		title: "Staff Platform Engineer",
		company: "Harbor Mills",
		location: "Remote - Worldwide",
		prefs: "Remote Full-time",
		apply: {
			href: "/jobs/view/externalApply/4100000004?url=https%3A%2F%2Fcareers.harbormills.example%2Fjobs%2F9&urlHash=x",
		},
		description:
			"<p>Run the platform our teams ship on.</p><ul><li>TypeScript and Kubernetes</li></ul>",
	},
};

const TOP_PICKS = ["4100000004", "4100000002"];

const SEARCHES: Record<string, string[]> = {
	engineer: ["4100000001", "4100000002", "4100000003"],
	captcha: ["4100000001"],
	warning: ["4100000001"],
};

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const shell = (title: string, body: string) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | LinkedIn (local fixture)</title></head><body><header class="global-nav">Local LinkedIn fixture. Nothing here is LinkedIn.</header>${body}</body></html>`;

function card(id: string): string {
	const job = JOBS[id];
	if (!job) return "";
	return `<li data-occludable-job-id="${id}" class="jobs-search-results__list-item"><div class="job-card-container"><a class="job-card-container__link" href="/jobs/view/${id}/"><strong>${esc(job.title)}</strong></a><div class="artdeco-entity-lockup__subtitle"><span>${esc(job.company)}</span></div><div class="artdeco-entity-lockup__caption"><span>${esc(job.location)}</span></div></div></li>`;
}

function results(ids: string[], extra = ""): string {
	return shell(
		"Jobs",
		`${extra}<main><div class="scaffold-layout__list"><ul>${ids.map(card).join("")}</ul>${
			ids.length === 0
				? '<div class="jobs-search-no-results-banner">No matching jobs found.</div>'
				: ""
		}</div></main>`,
	);
}

function jobView(id: string): string | null {
	const job = JOBS[id];
	if (!job) return null;
	const apply =
		job.apply === "easy"
			? '<button class="jobs-apply-button" type="button"><span>Easy Apply</span></button>'
			: `<a class="jobs-apply-button" href="${esc(job.apply.href)}" target="_blank"><span>Apply</span></a>`;
	return shell(
		job.title,
		`<main><div class="job-details-jobs-unified-top-card__container"><h1 class="job-details-jobs-unified-top-card__job-title">${esc(job.title)}</h1><div class="job-details-jobs-unified-top-card__company-name"><a href="/company/x/">${esc(job.company)}</a></div><div class="job-details-jobs-unified-top-card__tertiary-description-container"><span>${esc(job.location)} · 3 days ago · 40 applicants</span></div><div class="job-details-fit-level-preferences"><span>${esc(job.prefs)}</span></div>${apply}</div><article><div id="job-details">${job.description}</div></article></main>`,
	);
}

/** A search page by its keywords: a redirect (a check, the sign-in wall) or the page. */
function searchPage(keywords: string): { redirect: string } | { html: string } {
	if (keywords === "security")
		return { redirect: "/checkpoint/challenge/AgF?ut=fixture" };
	if (keywords === "signedout") return { redirect: "/authwall?trk=fixture" };
	if (keywords === "layout")
		return { html: shell("Jobs", "<main><p>A new layout.</p></main>") };
	if (keywords === "captcha")
		return {
			html: results(
				SEARCHES.captcha ?? [],
				'<iframe title="captcha" src="/captcha-frame" width="300" height="300"></iframe>',
			),
		};
	if (keywords === "warning")
		return {
			html: results(
				SEARCHES.warning ?? [],
				'<div role="alert">Your account has been temporarily restricted.</div>',
			),
		};
	return {
		html: results(
			SEARCHES[keywords] ??
				(/engineer/i.test(keywords) ? (SEARCHES.engineer ?? []) : []),
		),
	};
}

export async function startLinkedInFixture(port = 0): Promise<LinkedInFixture> {
	const requests: LinkedInFixture["requests"] = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		requests.push({
			method: req.method ?? "GET",
			path: url.pathname + url.search,
		});
		const html = (status: number, body: string) => {
			res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
			res.end(body);
		};
		if (req.method !== "GET")
			return html(405, shell("Refused", "<p>GET only</p>"));
		if (url.pathname.startsWith("/jobs/search")) {
			const answer = searchPage(url.searchParams.get("keywords") ?? "");
			if ("redirect" in answer) {
				res.writeHead(302, { location: answer.redirect });
				return res.end();
			}
			return html(200, answer.html);
		}
		if (url.pathname.startsWith("/jobs/collections/recommended"))
			return html(200, results(TOP_PICKS));
		const view = url.pathname.match(/^\/jobs\/view\/(\d+)\/?$/);
		if (view) {
			const page = jobView(view[1] ?? "");
			return page ? html(200, page) : html(404, shell("Not found", ""));
		}
		if (url.pathname.startsWith("/checkpoint/"))
			return html(
				200,
				shell(
					"Security Verification",
					"<h1>Let's do a quick security check</h1>",
				),
			);
		if (url.pathname.startsWith("/authwall"))
			return html(
				200,
				shell(
					"Sign in",
					'<form class="authwall"><input name="session_key"></form>',
				),
			);
		if (url.pathname === "/captcha-frame")
			return html(200, shell("captcha", "<p>Select all buses.</p>"));
		return html(404, shell("Not found", ""));
	});
	await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
	const address = server.address() as { port: number };
	return {
		origin: `http://127.0.0.1:${address.port}`,
		server,
		requests,
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections?.();
				server.close(() => done());
			}),
	};
}
