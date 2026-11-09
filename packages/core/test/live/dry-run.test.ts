import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runApplication } from "@offerfinch/core/apply/applier";
import { planFormFields } from "@offerfinch/core/apply/field-answers";
import type { FormSchema } from "@offerfinch/core/apply/form-schema";
import {
	type ApplicantData,
	BOARDS,
	type Board,
} from "@offerfinch/core/apply/forms";
import { readFormOnPage } from "@offerfinch/core/apply/read-form";
import {
	type NetworkLogEntry,
	UNTRUSTED_CONTENT,
} from "@offerfinch/core/scrape/browser";
import { describe, expect, it } from "vitest";
import { localBrowser } from "../browser/browser";

/**
 * Live dry runs on real postings (docs/auto-apply-plan.md, step 4). A developer tool, never run in
 * CI: every test skips unless `LIVE_FORM_URLS` names the postings, for example
 *
 *   LIVE_FORM_URLS="https://jobs.lever.co/<site>/<id>/apply" pnpm --filter @offerfinch/core test:live
 *
 * Per posting: the form is read in a read-only session (`readFormOnPage`), its schema saved, every
 * field planned with `planFormFields` for a fabricated applicant (example.com email, a 555 phone,
 * a CV PDF printed here), then a second page loads the form read-only and fills it with the
 * network closed before the first keystroke (the mechanism `dryRunApplication` uses). Submit is
 * never clicked. The test fails loudly when any request that is not GET or HEAD left the browser,
 * or when anything at all left after the network closed.
 *
 * Output goes to `packages/core/tmp/live-forms/<board>-<date>/` (gitignored): schema, plan,
 * network summary and a full-page screenshot of the filled form.
 */

const OUT = join(import.meta.dirname, "..", "..", "tmp", "live-forms");

const urls = (process.env.LIVE_FORM_URLS ?? "").split(/[\s,]+/).filter(Boolean);

function boardOf(url: string): Board {
	const host = new URL(url).hostname;
	if (host.endsWith("ashbyhq.com")) return "ashby";
	if (host.endsWith("greenhouse.io")) return "greenhouse";
	if (host.endsWith("lever.co")) return "lever";
	throw new Error(`${url} is not on ${BOARDS.join(", ")}`);
}

/** Fabricated: nobody's data. */
const APPLICANT: ApplicantData = {
	contact: {
		name: "Dryrun Testperson",
		email: "dryrun.testperson@example.com",
		phone: "+1 555 010 0199",
		location: "Ankara",
		linkedin: "https://www.linkedin.com/in/dryrun-testperson-example",
		website: "https://example.com/dryrun",
		github: "https://github.com/dryrun-testperson-example",
	},
	answers: [],
	coverLetterText: "Fabricated cover letter text for a dry run. Not sent.",
	hasCoverLetterFile: true,
};

const CV_HTML = `<!doctype html><html><body style="font-family:sans-serif">
<h1>Dryrun Testperson</h1><p>dryrun.testperson@example.com · +1 555 010 0199</p>
<h2>Experience</h2><p>Fabricated CV for a dry run of an application form. Not a real person.</p>
</body></html>`;

async function fabricatedPdf(): Promise<Uint8Array> {
	const session = await localBrowser().openSession(UNTRUSTED_CONTENT);
	try {
		const page = await session.newPage();
		await page.setContent(CV_HTML);
		return await page.pdf();
	} finally {
		await session.close();
	}
}

/** A placeholder for each required question nothing answers, only so every control type is used. */
function placeholder(q: { kind: string; options: string[] }): string {
	if (q.options.length > 0) return q.options[0] ?? "";
	return "Dry run placeholder answer";
}

interface HostSummary {
	host: string;
	methods: Record<string, number>;
	allowed: number;
	refused: number;
	reasons: string[];
}

function byHost(log: NetworkLogEntry[]): HostSummary[] {
	const hosts = new Map<string, HostSummary>();
	for (const entry of log) {
		let host = entry.url;
		try {
			host = new URL(entry.url).hostname || entry.url.slice(0, 40);
		} catch {}
		const row = hosts.get(host) ?? {
			host,
			methods: {},
			allowed: 0,
			refused: 0,
			reasons: [],
		};
		row.methods[entry.method] = (row.methods[entry.method] ?? 0) + 1;
		if (entry.allowed) row.allowed++;
		else row.refused++;
		if (!row.reasons.includes(entry.reason)) row.reasons.push(entry.reason);
		hosts.set(host, row);
	}
	return [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host));
}

const isRead = (r: NetworkLogEntry) =>
	r.method === "GET" || r.method === "HEAD";

/**
 * Ashby renders its form only after two GraphQL `query` POSTs to its own API (a GET-only page
 * shows no form, checked 2026-11-09). The read-only guard parsed each as a query; they are the one
 * exception, counted on their own, and only on the form's host while the page loads.
 */
function graphqlQuery(r: NetworkLogEntry, formHost: string): boolean {
	const at = new URL(r.url);
	return (
		r.allowed &&
		r.method === "POST" &&
		r.reason === "GraphQL query" &&
		at.hostname === formHost &&
		at.pathname === "/api/non-user-graphql"
	);
}

/** Allowed requests that are not GET or HEAD (nor Ashby's form queries): must be none. */
function sentData(log: NetworkLogEntry[], formHost: string): NetworkLogEntry[] {
	return log.filter(
		(r) => r.allowed && !isRead(r) && !graphqlQuery(r, formHost),
	);
}

describe.skipIf(urls.length === 0)("live dry run (no submit)", () => {
	for (const url of urls) {
		it(`${url}`, async () => {
			const board = boardOf(url);
			const dir = join(
				OUT,
				`${board}-${new Date().toISOString().slice(0, 10)}`,
			);
			mkdirSync(dir, { recursive: true });
			const allowedHosts = [new URL(url).hostname];
			const write = (name: string, value: unknown) =>
				writeFileSync(join(dir, name), JSON.stringify(value, null, 2));

			// 1. Read the form, read-only, the main frame held on the posting's host.
			const reader = await localBrowser().openSession({
				network: "read_only",
				allowedHosts,
			});
			let schema: FormSchema;
			let readLog: NetworkLogEntry[];
			try {
				const page = await reader.newPage();
				const read = await readFormOnPage(page, board, url);
				await page.goto("about:blank").catch(() => {});
				readLog = page.networkLog();
				if (!read.ok) throw new Error(`Form read failed: ${read.reason}`);
				schema = read.schema;
			} finally {
				await reader.close();
			}
			write("schema.json", schema);

			// 2. Plan every field; required questions nothing answers get a placeholder.
			const first = planFormFields(schema, APPLICANT, []);
			const data: ApplicantData = {
				...APPLICANT,
				answers: first.ask.map((q) => ({
					question: q.label,
					answer: placeholder(q),
				})),
			};
			const plan = planFormFields(schema, data, []);
			write("plan.json", { placeholders: data.answers, fields: plan.fields });

			// 3. Fill on a fresh page; the network closes before the first keystroke.
			const cv = await fabricatedPdf();
			const filler = await localBrowser().openSession({
				network: "read_only",
				allowedHosts,
			});
			let closedAt = -1;
			let fillLog: NetworkLogEntry[];
			let result: Awaited<ReturnType<typeof runApplication>>;
			try {
				const page = await filler.newPage();
				result = await runApplication(page, {
					board,
					url,
					mode: "dry_run",
					schema: schema.fields,
					data,
					files: {
						cv: { name: "CV.pdf", mimeType: "application/pdf", buffer: cv },
						coverLetter: {
							name: "Cover letter.pdf",
							mimeType: "application/pdf",
							buffer: cv,
						},
					},
					lookupsOffline: true,
					beforeFill: () => {
						closedAt = page.networkLog().length;
						page.restrictNetwork("none");
					},
				});
				await page.goto("about:blank").catch(() => {});
				fillLog = page.networkLog();
			} finally {
				await filler.close();
			}
			const shot =
				result.outcome === "dry_run" || result.outcome === "stopped"
					? result.screenshot
					: null;
			if (shot) writeFileSync(join(dir, "filled.png"), shot);
			const afterClose = closedAt >= 0 ? fillLog.slice(closedAt) : [];
			const formHost = allowedHosts[0] ?? "";
			const loading = [...readLog, ...fillLog.slice(0, Math.max(closedAt, 0))];
			const summary = {
				url,
				board,
				outcome: result.outcome,
				...(result.outcome === "stopped" ? { stop: result.stop } : {}),
				fieldsRead: schema.fields.length,
				filled: result.filled,
				blank:
					result.outcome === "dry_run"
						? result.blank
						: plan.fields.filter((f) => f.value === null).map((f) => f.label),
				read: {
					requests: readLog.length,
					byHost: byHost(readLog),
				},
				fill: {
					requests: fillLog.length,
					closedAt,
					attemptedAfterClose: afterClose.length,
					leftAfterClose: afterClose.filter((r) => r.allowed).length,
					byHost: byHost(fillLog),
					afterClose: byHost(afterClose),
					// Fabricated data only: what the form would have sent, and where.
					attemptsAfterClose: afterClose.map((r) => `${r.method} ${r.url}`),
				},
				graphqlQueriesWhileLoading: loading.filter((r) =>
					graphqlQuery(r, formHost),
				).length,
				nonReadsThatLeft: sentData([...readLog, ...fillLog], formHost),
			};
			write("network.json", summary);
			// Every request, for the host list (fabricated data; the folder is gitignored).
			write("requests.json", { read: readLog, fill: fillLog, closedAt });
			console.log(
				JSON.stringify(
					{
						board,
						outcome: summary.outcome,
						fieldsRead: summary.fieldsRead,
						filled: summary.filled.length,
						blank: summary.blank.length,
						leftAfterClose: summary.fill.leftAfterClose,
						nonReadsThatLeft: summary.nonReadsThatLeft.length,
						dir,
					},
					null,
					1,
				),
			);

			// Loud failures: nothing but GET and HEAD left, and nothing at all after the close.
			expect(closedAt, "the network never closed").toBeGreaterThanOrEqual(0);
			expect(summary.nonReadsThatLeft).toEqual([]);
			expect(afterClose.filter((r) => r.allowed)).toEqual([]);
			expect(result.outcome).toBe("dry_run");
		});
	}
});
