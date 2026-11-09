import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * Employers' forms on named hosts of one site (`jobs.acme.test`, `careers.acme.test`,
 * `sink.acme.test`, all answered here through `siteBrowser`), for the rule that an employer's
 * form sends only to the exact host of its page (Codex re-review, 2026-11-09). Every request is
 * recorded with the host it was meant for; nothing leaves the machine.
 *
 *   action-away     on jobs: the form's `action` is on sink
 *   formaction-away on jobs: the form posts to itself, its submit button's `formaction` to sink
 *   script-away     on jobs: a script in the head moves the page to sink, whose form posts to sink
 *   meta-away       on jobs: a meta refresh moves the page to sink, whose form posts to sink
 *   redirect        on jobs: HTTP 302 to careers, whose form posts to careers (and 303s to thanks)
 *   redirect-back   on jobs: HTTP 302 to careers, whose form posts back to jobs
 *   action-changes  on jobs: posts to itself on the first load, to sink from the second on
 */

export interface SiteRequest {
	host: string;
	method: string;
	path: string;
	body: string;
}

export interface FixtureWebSites {
	port: number;
	/** `http://<host>.acme.test:<port>/<variant>/apply` */
	url(host: string, variant: string): string;
	requests: SiteRequest[];
	/** The non-GET requests that reached `host`. */
	posts(host: string): SiteRequest[];
	close(): Promise<void>;
}

const FIELDS = `<div><label for="email">Email address</label><input id="email" name="email" type="email"></div>
<div><label for="full_name">Full name *</label><input id="full_name" name="full_name" required></div>`;

function page(head: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme Robotics careers</title>${head}</head><body><h1>Robotics Engineer at Acme Robotics</h1>${body}</body></html>`;
}

function form(action: string, button = ""): string {
	return `<form id="apply" method="post" action="${action}">${FIELDS}<p><button type="submit"${button}>Submit application</button></p></form>`;
}

/** A variant's apply page on `host` (its `load`-th load): HTML, an HTTP redirect, or none. */
function formOf(
	variant: string,
	host: string,
	load: number,
	at: (host: string, path: string) => string,
): { html: string } | { redirect: string } | null {
	const own = `/${variant}/collect`;
	const sink = at("sink", own);
	switch (variant) {
		case "action-away":
			return { html: page("", form(sink)) };
		case "formaction-away":
			return { html: page("", form(own, ` formaction="${sink}"`)) };
		case "script-away":
		case "meta-away": {
			if (host === "sink") return { html: page("", form(own)) };
			const to = at("sink", `/${variant}/apply`);
			const head =
				variant === "script-away"
					? `<script>location.replace(${JSON.stringify(to)})</script>`
					: `<meta http-equiv="refresh" content="0; url=${to}">`;
			return { html: page(head, form(own)) };
		}
		case "redirect":
		case "redirect-back":
			if (host === "jobs")
				return { redirect: at("careers", `/${variant}/apply`) };
			return {
				html: page("", form(variant === "redirect" ? own : at("jobs", own))),
			};
		case "action-changes":
			return { html: page("", form(load > 1 ? sink : own)) };
		default:
			return null;
	}
}

async function bodyOf(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

export async function startFixtureWebSites(): Promise<FixtureWebSites> {
	const requests: SiteRequest[] = [];
	const loads = new Map<string, number>();
	let port = 0;
	const at = (host: string, path: string) =>
		`http://${host}.acme.test:${port}${path}`;
	const server: Server = createServer(async (req, res) => {
		const named = req.headers["x-fixture-host"];
		const host = (
			(typeof named === "string" ? named : undefined) ??
			(req.headers.host ?? "").split(":")[0] ??
			""
		).replace(/\.acme\.test$/, "");
		const url = new URL(req.url ?? "/", "http://fixture");
		const body = await bodyOf(req);
		requests.push({ host, method: req.method ?? "", path: url.pathname, body });
		const [, variant = "", action = ""] = url.pathname.split("/");
		const html = (content: string) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(content);
		};
		if (req.method !== "GET") {
			res.writeHead(303, { location: at(host, `/${variant}/thanks`) });
			res.end();
			return;
		}
		if (action === "thanks")
			return html(
				page(
					"",
					"<h2>Thank you for applying to Acme Robotics</h2><p>We have received your application.</p>",
				),
			);
		if (action !== "apply") {
			res.writeHead(404);
			res.end();
			return;
		}
		const load = (loads.get(`${host}/${variant}`) ?? 0) + 1;
		loads.set(`${host}/${variant}`, load);
		const answer = formOf(variant, host, load, at);
		if (answer === null) {
			res.writeHead(404);
			res.end();
		} else if ("redirect" in answer) {
			res.writeHead(302, { location: answer.redirect });
			res.end();
		} else html(answer.html);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	port = (server.address() as { port: number }).port;
	return {
		port,
		url: (host, variant) => at(host, `/${variant}/apply`),
		requests,
		posts: (host) =>
			requests.filter((r) => r.host === host && r.method !== "GET"),
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections?.();
				server.close(() => done());
			}),
	};
}
