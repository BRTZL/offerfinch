import {
	countUserRows,
	DashboardRepository,
	DrizzleLinkedInStore,
	importProfile,
	SqliteSearchPlanStore,
	seedCompanies,
} from "@offerfinch/db";
import {
	companies,
	documents,
	profileFacts,
	questions,
	submissionAttempts,
} from "@offerfinch/db/schema/pipeline";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pipelineRouter } from "../../../apps/desktop/src/worker/routers/pipeline";

import { startTestApp, type TestApp, type TestUser } from "./support/api";

/**
 * Phase 5 isolation: user B cannot read or change any of user A's data through any oRPC
 * procedure or download. Every procedure in the router must have a case here; a new procedure
 * without one fails the first test.
 */

let t: TestApp;
let a: TestUser;
let b: TestUser;
const ids = {
	app: "",
	company: "",
	question: "",
	fact: "",
	exportDoc: "",
	attempt: "",
	cvVersion: 0,
};

async function seedUserA() {
	const repo = new DashboardRepository(t.db);
	await importProfile(
		t.db,
		a.id,
		{
			files: [
				{
					path: "personal.md",
					content:
						"# Personal\n\n- **Name:** Alex A\n- **Email:** alex@example.test\n",
				},
				{ path: "skills.md", content: "# Skills\n\n- TypeScript\n" },
			],
		},
		"test",
	);
	await seedCompanies(t.db, a.id, [
		{
			name: "Acme A",
			source: "greenhouse",
			sourceKey: "acme-a",
			discoveredFrom: "t",
		},
	]);
	const [company] = await t.db
		.select({ id: companies.id })
		.from(companies)
		.where(eq(companies.userId, a.id));
	ids.company = company?.id ?? "";
	const { jobId } = await repo.upsertJob(a.id, ids.company, {
		source: "greenhouse",
		externalId: "a-1",
		url: "https://job-boards.greenhouse.io/acme-a/jobs/1",
		title: "Secret Role of A",
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "Requirements\n- TypeScript",
	});
	ids.app = (await repo.getApplicationByJob(a.id, jobId))?.applicationId ?? "";
	for (const [from, to] of [
		["found", "scored"],
		["scored", "preparing"],
	] as const)
		await repo.transition(a.id, ids.app, {
			from: [from],
			to,
			reason: "t",
			actor: "workflow",
		});
	await repo.saveDraft(
		a.id,
		ids.app,
		{
			notes: "notes of A",
			cv: "# Alex A\n\nCV of A",
			coverLetter: "Letter of A",
			formAnswers: [{ question: "Notice?", answer: "Four weeks" }],
		},
		"workflow",
	);
	await repo.askQuestions(a.id, ids.app, [
		{ question: "What is A's salary?", why: "form" },
	]);
	const [question] = await t.db
		.select({ id: questions.id })
		.from(questions)
		.where(eq(questions.userId, a.id));
	ids.question = question?.id ?? "";
	const key = `users/${a.id}/applications/${ids.app}/cv-v1.pdf`;
	await t.blobs.put(key, new TextEncoder().encode("%PDF A"), "application/pdf");
	await repo.saveExport(a.id, ids.app, {
		kind: "cv",
		format: "pdf",
		sourceVersion: 1,
		storageKey: key,
		meta: {},
	});
	const [doc] = await t.db
		.select({ id: documents.id })
		.from(documents)
		.where(and(eq(documents.userId, a.id), eq(documents.format, "pdf")));
	ids.exportDoc = doc?.id ?? "";
	const shot = `users/${a.id}/applications/${ids.app}/submissions/1-before.png`;
	await t.blobs.put(shot, new Uint8Array([137, 80]), "image/png");
	const [attempt] = await t.db
		.insert(submissionAttempts)
		.values({
			userId: a.id,
			applicationId: ids.app,
			attempt: 1,
			status: "dry_run",
			mode: "dry_run",
			screenshotBeforeKey: shot,
		})
		.returning({ id: submissionAttempts.id });
	ids.attempt = attempt?.id ?? "";
	const fact = await repo.addFact(a.id, {
		question: "A's notice period",
		answer: "Four weeks",
	});
	ids.fact = fact?.id ?? "";
	await a.rpc.settings.update({ relocation: true });
	await a.rpc.spending.set({ enabled: true, monthlyUsd: 5 });
	await a.rpc.models.confirmExtraUsageOff({ confirmed: true });
	await a.rpc.submission.setPaused({ paused: false });
	await new DrizzleLinkedInStore(t.db).block(a.id, {
		kind: "captcha",
		reason: "a-secret check",
	});
	await new SqliteSearchPlanStore(t.db).addUserSearch(a.id, {
		keywords: "a-secret engineer",
		where: "remote-worldwide",
	});
	ids.cvVersion =
		(await repo.latestDocuments(a.id, ids.app)).find((d) => d.kind === "cv")
			?.version ?? 0;
}

/** Everything of A's that B's calls must not have changed. */
async function snapshotA() {
	const repo = new DashboardRepository(t.db);
	const app = await repo.getApplication(a.id, ids.app);
	const [question] = await t.db
		.select()
		.from(questions)
		.where(eq(questions.id, ids.question));
	const [fact] = await t.db
		.select()
		.from(profileFacts)
		.where(eq(profileFacts.id, ids.fact));
	const [company] = await t.db
		.select({ status: companies.status })
		.from(companies)
		.where(eq(companies.id, ids.company));
	return {
		state: app?.state,
		documents: app?.documents.map((d) => [d.kind, d.version, d.content]),
		question: [question?.status, question?.answer],
		fact: [fact?.question, fact?.answer],
		company: company?.status,
		settings: await repo.getFilterSettings(a.id),
		spending: (await repo.spending(a.id)).capMicros,
		paused: await repo.submissionsPaused(a.id),
		linkedin: await new DrizzleLinkedInStore(t.db).blocked(a.id),
		plan: await new SqliteSearchPlanStore(t.db).plan(a.id),
		profile: (await repo.profileFiles(a.id))?.files,
		rows: await countUserRows(t.db, a.id),
	};
}

/** A's identifying strings, none of which may appear in anything B receives. */
const secretsOfA = () => [
	a.id,
	a.email,
	ids.app,
	ids.company,
	ids.question,
	ids.fact,
	ids.exportDoc,
	ids.attempt,
	"Secret Role of A",
	"Acme A",
	"a-secret",
	"A's notice period",
];

/** A's strings in what B got back, except an id B itself sent (echoed in a refusal). */
const leaks = (value: unknown) => {
	const supplied =
		(value as { supplied?: string[] } | null)?.supplied ?? ([] as string[]);
	const text = JSON.stringify(value ?? null);
	return secretsOfA().filter(
		(s) => s && !supplied.includes(s) && text.includes(s),
	);
};

/** Calls as B; returns the result or the error, never throws. */
const asB = async <T>(fn: () => Promise<T>) => {
	try {
		return { ok: true as const, value: await fn() };
	} catch (error) {
		return { ok: false as const, error };
	}
};

const describeError = (error: unknown) => {
	const e = error as { code?: string; status?: number; message?: string };
	return { code: e.code, status: e.status, message: e.message };
};

/**
 * B calls with one of A's ids, then with an id nobody has: both must be refused the same way,
 * message included (the id itself aside), so B cannot even learn that A's id exists.
 */
async function refused(
	id: string,
	call: (id: string) => Promise<unknown>,
): Promise<{ supplied: string[]; error: unknown }> {
	const theirs = await asB(() => call(id));
	const nobodys = await asB(() => call(UUID));
	expect(theirs.ok).toBe(false);
	expect(nobodys.ok).toBe(false);
	const shape = (r: typeof theirs, own: string) =>
		JSON.stringify(describeError(r.ok ? null : r.error))
			.split(own)
			.join("<id>");
	expect(shape(theirs, id)).toBe(shape(nobodys, UUID));
	return {
		supplied: [id],
		error: describeError(theirs.ok ? null : theirs.error),
	};
}

const UUID = "00000000-0000-4000-8000-000000000000";

/**
 * One case per procedure: what B does with A's ids, and what must hold. Every case also checks
 * that the result names nothing of A's and that A's data is unchanged afterwards.
 */
const CASES: Record<string, (b: TestUser) => Promise<unknown>> = {
	"inbox.counts": async (u) => {
		expect(await u.rpc.inbox.counts()).toEqual({});
	},
	"inbox.list": async (u) => {
		expect(await u.rpc.inbox.list({ companyId: ids.company })).toEqual([]);
		expect(await u.rpc.inbox.list({})).toEqual([]);
	},
	"application.get": (u) =>
		refused(ids.app, (id) => u.rpc.application.get({ id })),
	"application.editDocument": (u) =>
		refused(ids.app, (id) =>
			u.rpc.application.editDocument({
				id,
				kind: "cv",
				content: "overwritten by B",
				baseVersion: ids.cvVersion,
			}),
		),
	"application.approve": (u) =>
		refused(ids.app, (id) =>
			u.rpc.application.approve({
				id,
				hashes: {},
				idempotencyKey: `b-approve-${id}`,
			}),
		),
	"application.resolveFlag": async (u) => {
		await refused(ids.app, (id) =>
			u.rpc.application.resolveFlag({
				id,
				flagId: "cv-00000000",
				action: "edit",
				text: "written by B",
			}),
		);
		return refused(ids.app, (id) =>
			u.rpc.application.resolveFlag({
				id,
				flagId: "cv-00000000",
				action: "delete",
			}),
		);
	},
	"application.confirmFlag": (u) =>
		refused(ids.app, (id) =>
			u.rpc.application.confirmFlag({ id, flagId: "cv-00000000" }),
		),
	"application.retryCheck": (u) =>
		refused(ids.app, (id) => u.rpc.application.retryCheck({ id })),
	"application.redraft": (u) =>
		refused(ids.app, (id) =>
			u.rpc.application.redraft({
				id,
				scope: "all",
				instruction: "written by B",
			}),
		),
	"application.retryRedraft": (u) =>
		refused(ids.app, (id) => u.rpc.application.retryRedraft({ id })),
	"application.cancelRedraft": (u) =>
		refused(ids.app, (id) => u.rpc.application.cancelRedraft({ id })),
	"application.documentVersion": (u) =>
		refused(ids.app, (id) =>
			u.rpc.application.documentVersion({
				id,
				kind: "cv",
				version: ids.cvVersion,
			}),
		),
	"application.reject": (u) =>
		refused(ids.app, (id) =>
			u.rpc.application.reject({
				id,
				reason: "B rejects A",
				idempotencyKey: `b-reject-${id}`,
			}),
		),
	"submission.retry": (u) =>
		refused(ids.app, (id) =>
			u.rpc.submission.retry({
				id,
				attemptId: null,
				confirmedNotSent: true,
				idempotencyKey: `b-retry-${id}`,
			}),
		),
	"submission.markSubmitted": (u) =>
		refused(ids.app, (id) =>
			u.rpc.submission.markSubmitted({
				id,
				attemptId: null,
				idempotencyKey: `b-mark-${id}`,
			}),
		),
	"submission.dryRun": (u) =>
		refused(ids.app, (id) => u.rpc.submission.dryRun({ id })),
	"submission.readFormAgain": (u) =>
		refused(ids.app, (id) =>
			u.rpc.submission.readFormAgain({ id, idempotencyKey: `b-again-${id}` }),
		),
	"submission.settings": async (u) => {
		expect((await u.rpc.submission.settings()).paused).toBe(true);
	},
	"submission.setPaused": (u) => u.rpc.submission.setPaused({ paused: false }),
	"submission.applied": async (u) => {
		expect(await u.rpc.submission.applied()).toEqual([]);
	},
	"questions.list": async (u) => {
		expect(await u.rpc.questions.list({})).toEqual([]);
	},
	"questions.answer": (u) =>
		refused(ids.question, (id) =>
			u.rpc.questions.answer({ id, answer: "B's answer" }),
		),
	"questions.facts": async (u) => {
		expect(await u.rpc.questions.facts()).toEqual([]);
	},
	"rejected.list": async (u) => {
		expect(await u.rpc.rejected.list()).toEqual([]);
	},
	"settings.get": async (u) => {
		expect((await u.rpc.settings.get()).relocation).toBe(false);
	},
	"settings.update": (u) => u.rpc.settings.update({ minScore: 10 }),
	"models.status": async (u) => {
		// The subscription is A's: B sees the roles, never A's login, paths or account id.
		const status = await u.rpc.models.status();
		expect(status).toMatchObject({
			owner: false,
			ownerConfigured: true,
			subscriptionUserId: null,
			claudeConfigDir: null,
			removedEnv: [],
		});
		expect(status?.roles[0]?.login?.state).toBe("refused");
		expect(JSON.stringify(status)).not.toContain("plan max");
		const own = await a.rpc.models.status();
		expect(own?.roles[0]?.login?.state).toBe("logged_in");
		return status;
	},
	"models.confirmExtraUsageOff": async (u) => {
		// B's own confirmation; A's stays as it was, and B never sees A's.
		const r = await u.rpc.models.confirmExtraUsageOff({ confirmed: false });
		expect(r.extraUsageOffConfirmedAt).toBeNull();
		expect((await u.rpc.models.status())?.extraUsageOffConfirmedAt).toBeNull();
		expect(
			(await a.rpc.models.status())?.extraUsageOffConfirmedAt,
		).not.toBeNull();
		return r;
	},
	"models.setCallBudget": async (u) => {
		// B's own budget; A's stays at the default.
		const r = await u.rpc.models.setCallBudget({ dailyCalls: 3 });
		expect(r.budget).toBe(3);
		expect((await a.rpc.models.status())?.callBudget.budget).toBe(500);
		return r;
	},
	"spending.get": async (u) => {
		expect((await u.rpc.spending.get()).capMicros).toBe(20_000_000);
	},
	"spending.set": (u) => u.rpc.spending.set({ enabled: false, monthlyUsd: 1 }),
	"profile.get": async (u) => {
		expect(await u.rpc.profile.get()).toBe(null);
	},
	"profile.pdfText": async (u) => {
		const r = await asB(() =>
			u.rpc.profile.pdfText({ base64: "bm90IGEgcGRm" }),
		);
		expect(r.ok).toBe(false);
		return r;
	},
	"profile.structure": async (u) => {
		const draft = await u.rpc.profile.structure({
			text: "Bea B\nbea@example.test\nSkills: Go, SQL\nEngineer at Beacon, 2020 - Present",
		});
		expect(draft.records.find((r) => r.kind === "about")?.data).toMatchObject({
			name: "Bea B",
		});
		const [usage] = await t.db.all<{
			user_id: string;
			application_id: string | null;
		}>(
			sql`select user_id, application_id from llm_usage where task = 'structure-profile' order by created_at desc limit 1`,
		);
		expect(usage).toEqual({ user_id: u.id, application_id: null });
		return draft;
	},
	"profile.facts.add": (u) =>
		u.rpc.profile.facts.add({ question: "B's notice", answer: "Two weeks" }),
	"profile.facts.update": (u) =>
		refused(ids.fact, (id) =>
			u.rpc.profile.facts.update({
				id,
				question: "changed by B",
				answer: "changed by B",
			}),
		),
	"profile.facts.remove": (u) =>
		refused(ids.fact, (id) => u.rpc.profile.facts.remove({ id })),
	"linkedin.status": async (u) => {
		const status = await u.rpc.linkedin.status();
		expect(status.blocked).toBeNull();
		expect(status.dailyPageCap).toBe(30);
		return status;
	},
};

function procedurePaths(router: object, prefix = ""): string[] {
	return Object.entries(router).flatMap(([key, value]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value && typeof value === "object" && "~orpc" in value) return [path];
		return value && typeof value === "object"
			? procedurePaths(value, path)
			: [];
	});
}

beforeAll(async () => {
	t = await startTestApp("isolation");
	a = await t.user("alice");
	b = await t.user("bob");
	t.setSubscriptionOwner(a.id);
	await seedUserA();
}, 120_000);
afterAll(async () => {
	await t?.close();
});

describe("user isolation", () => {
	it("has a case for every oRPC procedure", () => {
		expect(Object.keys(CASES).sort()).toEqual(
			procedurePaths(pipelineRouter).sort(),
		);
	});

	for (const path of Object.keys(CASES))
		it(`${path}: B cannot read or change A's data`, async () => {
			const before = await snapshotA();
			const result = await CASES[path]?.(b);
			expect(leaks(result)).toEqual([]);
			expect(await snapshotA()).toEqual(before);
		});

	it("downloads: B gets 404 for A's export file and screenshot; A gets them", async () => {
		expect((await b.request(`/files/${ids.exportDoc}`)).status).toBe(404);
		expect((await b.request(`/proof/${ids.attempt}/before`)).status).toBe(404);
		expect((await a.request(`/files/${ids.exportDoc}`)).status).toBe(200);
		expect((await a.request(`/proof/${ids.attempt}/before`)).status).toBe(200);
		const anonymous = await t.fetch(
			new Request(`http://localhost:3999/files/${ids.exportDoc}`),
		);
		expect(anonymous.status).toBe(401);
		expect((await b.request(`/files/${UUID}`)).status).toBe(404);
	});

	it("data export: B's export holds nothing of A's", async () => {
		const response = await b.request("/account/export");
		expect(response.status).toBe(200);
		const data = (await response.json()) as { account: { id: string } };
		expect(leaks(data)).toEqual([]);
		expect(data.account.id).toBe(b.id);
	});

	it("an unauthenticated call is refused", async () => {
		const response = await t.fetch(
			new Request("http://localhost:3999/rpc/inbox/counts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(response.status).toBe(401);
	});
});
