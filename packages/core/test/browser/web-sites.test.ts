import type { FormSchema } from "@offerfinch/core/apply/form-schema";
import { readFormOnPage } from "@offerfinch/core/apply/read-form";
import {
	type SubmissionStore,
	submitStep,
} from "@offerfinch/core/apply/submit";
import { webReadHosts } from "@offerfinch/core/apply/web-hosts";
import {
	llmWebFormModel,
	type WebFormModel,
} from "@offerfinch/core/apply/web-model";
import { MemoryBlobStore } from "@offerfinch/core/export/export";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { siteBrowser } from "./browser";
import {
	type FixtureWebSites,
	startFixtureWebSites,
} from "./fixture-web-sites";

/**
 * Codex re-review (2026-11-09), finding 1: what the page says (its `action`, a `formaction`, where
 * a script moved it) authorized a sibling host of the same site (`sink.acme.test`) to receive the
 * application. An employer's form sends only to the exact host of its page: the job's link after
 * the HTTP redirects the read followed. Anything else is the user's to finish.
 */

let sites: FixtureWebSites;
beforeAll(async () => {
	sites = await startFixtureWebSites();
});
afterAll(async () => {
	await sites?.close();
});

const PROFILE = {
	files: [
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Location:** Izmir, Turkey\n",
		},
	],
};

const model = (): WebFormModel => llmWebFormModel(new FakeLlmProvider());

async function read(url: string) {
	const session = await siteBrowser(sites.port).openSession({
		network: "read_only",
		allowedHosts: webReadHosts(url),
	});
	try {
		return await readFormOnPage(await session.newPage(), "web", url, model());
	} finally {
		await session.close();
	}
}

function harness(url: string, schema: FormSchema, allowedHosts: string[]) {
	const blobs = new MemoryBlobStore();
	void blobs.put("cv.pdf", new TextEncoder().encode("%PDF-1.4 cv"), "x");
	const calls: { method: string; reason?: string; submitted?: boolean }[] = [];
	const store = {
		submissionsPaused: async () => false,
		resolveInterrupted: async () => false,
		submissionContext: async () => ({
			applicationId: "app-1",
			source: "web",
			board: "web" as const,
			boardFrom: "url" as const,
			companyKey: "acme-robotics",
			externalId: "x",
			jobUrl: url,
			formAnswers: [],
			coverLetterMarkdown: null,
			cvPdfKey: "cv.pdf",
			coverLetterPdfKey: null,
		}),
		formRead: async () => ({
			status: "read" as const,
			schema,
			readAt: "2026-11-09T00:00:00Z",
		}),
		claimSubmission: vi.fn(async () => {
			calls.push({ method: "claim" });
			return { go: true as const, attemptId: "attempt-1" };
		}),
		finishSubmission: vi.fn(async (_u, _a, _id, input) => {
			calls.push({
				method: "finish",
				reason: input.reason,
				submitted: input.submitted,
			});
		}),
		stopSubmission: vi.fn(async (_u, _a, input) => {
			calls.push({ method: "stop", reason: input.reason });
		}),
		stopForQuestions: vi.fn(async () => ({ asked: 0, reused: 0 })),
		recordDryRun: vi.fn(async () => "dry"),
		savedAnswers: async () => [],
		handOverStuck: async () => [],
		beginSubmission: async () => ({ outcome: "started" as const }),
	} satisfies SubmissionStore;
	const deps = {
		repo: {
			getState: async () => "applying",
			getProfile: async () => PROFILE,
		},
		llm: new FakeLlmProvider(),
		apply: { store, browser: siteBrowser(sites.port), blobs, allowedHosts },
	} as unknown as PipelineDeps;
	return { deps, calls };
}

describe("an employer's form sends only to the exact host of its page (Codex re-review, 2026-11-09)", () => {
	it.each([
		// The form's action names a sibling host.
		["action-away", "sink.acme.test"],
		// The submit button's formaction does.
		["formaction-away", "sink.acme.test"],
		// A script moved the page to a sibling host, whose form posts there.
		["script-away", "sink.acme.test"],
		// So did a meta refresh.
		["meta-away", "sink.acme.test"],
	])(
		"%s: a hand-off at read time, shown in review",
		async (variant, host) => {
			const result = await read(sites.url("jobs", variant));
			expect(result).toMatchObject({
				ok: false,
				reason: `This form sends to ${host}; finish it yourself.`,
				handoff: true,
			});
			expect(sites.posts("sink")).toEqual([]);
		},
		60_000,
	);

	it.each([
		// HTTP 302 to careers, whose form posts to careers (Codex review, 2026-11-09).
		"redirect",
		// The same, its form posting back to the link's host.
		"redirect-back",
	])(
		"%s: an HTTP redirect to another host of the site is a hand-off at read time",
		async (variant) => {
			const result = await read(sites.url("jobs", variant));
			expect(result).toMatchObject({
				ok: false,
				reason: "The job link moves to careers.acme.test; finish it yourself.",
				handoff: true,
			});
			const posted = (host: string) =>
				sites.posts(host).filter((r) => r.path.startsWith(`/${variant}/`));
			expect(posted("careers")).toEqual([]);
			expect(posted("jobs")).toEqual([]);
		},
		60_000,
	);

	it("a read saved with its form page on another host is never opened at submit", async () => {
		const link = sites.url("jobs", "redirect");
		const schema: FormSchema = {
			board: "web",
			url: link,
			submit: "Submit application",
			formUrl: sites.url("careers", "redirect"),
			fields: [],
		};
		const { deps, calls } = harness(link, schema, ["careers.acme.test"]);
		const before = sites.requests.length;
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(
				/^The job link moves to careers\.acme\.test; finish it yourself\./,
			),
		});
		expect(calls.map((c) => c.method)).toEqual(["stop"]);
		expect(sites.requests.slice(before)).toEqual([]);
	}, 60_000);

	it("an HTTP redirect within the link's host decides the form's page: it receives the application", async () => {
		const link = sites.url("jobs", "redirect-path");
		const result = await read(link);
		if (!result.ok) throw new Error(result.reason);
		const formUrl = link.replace("/apply", "/form");
		expect(result.schema.formUrl).toBe(formUrl);
		const { deps, calls } = harness(link, result.schema, ["jobs.acme.test"]);
		const before = sites.requests.length;
		const outcome = await submitStep(deps, "u1", "app-1");
		// Sent, check your email (decision 2026-11-09); never applied from the page.
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(/^Sent; check your email\./),
		});
		expect(calls.map((c) => c.method)).toEqual(["claim", "finish"]);
		expect(calls[1]?.submitted).toBe(false);
		const sent = sites.requests.slice(before);
		expect(sent.filter((r) => r.method === "POST")).toEqual([
			expect.objectContaining({
				host: "jobs",
				path: "/redirect-path/collect",
				body: expect.stringContaining("ada%40example.test"),
			}),
		]);
		expect(sent.filter((r) => r.host !== "jobs")).toEqual([]);
	}, 60_000);

	it("a form that points elsewhere after review stops before the claim", async () => {
		const link = sites.url("jobs", "action-changes");
		const result = await read(link);
		if (!result.ok) throw new Error(result.reason);
		const { deps, calls } = harness(link, result.schema, ["jobs.acme.test"]);
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(
				/^This form sends to sink\.acme\.test; finish it yourself\./,
			),
		});
		expect(calls.map((c) => c.method)).toEqual(["stop"]);
		expect(sites.posts("sink")).toEqual([]);
		expect(
			sites.posts("jobs").filter((r) => r.path.startsWith("/action-changes/")),
		).toEqual([]);
	}, 60_000);
});
