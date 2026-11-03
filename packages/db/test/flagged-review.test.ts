import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExportInput } from "@offerfinch/core/export/export";
import { NoopNotifier } from "@offerfinch/core/notify/ntfy";
import { LocalWorkflowStarter } from "@offerfinch/core/pipeline/local";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { loadProfileFromDir } from "@offerfinch/core/profile/load-node";
import {
	FakeLlmProvider,
	heuristicFitResponder,
} from "@offerfinch/core/scoring/fake";
import type { GenerateObjectRequest } from "@offerfinch/core/scoring/llm";
import { segmentDocuments, verifyClaims } from "@offerfinch/core/tailor/claims";
import { fakeTailorResponder } from "@offerfinch/core/tailor/fake";
import { checkQuote } from "@offerfinch/core/tailor/profile-rules";
import type { TailorOutput } from "@offerfinch/core/tailor/tailor";
import {
	DrizzlePipelineRepository,
	importProfile,
	seedCompanies,
} from "@offerfinch/db";
import {
	applications,
	approvals,
	companies,
	profileFacts,
	reviewChecks,
} from "@offerfinch/db/schema/pipeline";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestApp, type TestApp, type TestUser } from "./support/api";

/**
 * Flagged review (2026-10-31): a draft still flagged after the automatic redraft goes to review,
 * not `failed`. Approval is refused (409) while a flag is open; the user edits, deletes or
 * confirms each line. A confirmation lands in that user's profile only; a fixed rule (degree
 * wording) cannot be confirmed.
 */

const FIXTURES = join(import.meta.dirname, "../../core/test/fixtures");
const K8S = "Ran Kubernetes clusters for 300 services at Google.";
const KERNEL = "Wrote the Linux kernel's scheduler in a weekend.";
const DEGREE = "I hold a Bachelor's degree in Software Engineering.";

let t: TestApp;
let a: TestUser;
let b: TestUser;
let repo: DrizzlePipelineRepository;
let workflows: LocalWorkflowStarter;
let claimsLlm: FakeLlmProvider;
let jobId = "";
let appId = "";

/** Delivers the dashboard's event the way `cli serve` does: the flow runs again inline. */
const deliver = () => workflows.restart({ userId: a.id, jobId });

beforeAll(async () => {
	t = await startTestApp("flagged");
	a = await t.user("flag-a");
	b = await t.user("flag-b");
	repo = new DrizzlePipelineRepository(t.db);
	workflows = new LocalWorkflowStarter();
	claimsLlm = new FakeLlmProvider();
	const deps: PipelineDeps = {
		repo,
		sources: {},
		llm: new FakeLlmProvider({
			"fit-score": heuristicFitResponder,
			tailor: (request: GenerateObjectRequest<unknown>) => {
				const draft = fakeTailorResponder(request) as TailorOutput;
				const letter = draft.coverLetter.split("\n\n");
				// The paragraph after the opening gains the degree claim.
				letter[4] = `${letter[4]} ${DEGREE}`;
				return {
					...draft,
					missingFacts: [],
					cv: draft.cv.replace(
						"## Skills",
						`- ${K8S}\n- ${KERNEL}\n\n## Skills`,
					),
					coverLetter: letter.join("\n\n"),
				};
			},
		}),
		claimsLlm,
		notifier: new NoopNotifier(),
		workflows,
		exporter: async (input: ExportInput) => ({
			records: input.documents.map((d) => ({
				kind: d.kind,
				format: "pdf" as const,
				sourceVersion: d.version,
				storageKey: `users/${input.userId}/applications/${input.applicationId}/${d.kind}-v${d.version}.pdf`,
				meta: {},
			})),
			atsIssues: [],
		}),
	};
	workflows.bind(deps);
	for (const user of [a, b])
		await importProfile(
			t.db,
			user.id,
			await loadProfileFromDir(join(FIXTURES, "desktop-profile")),
			"fixtures/profile",
		);
	await seedCompanies(t.db, a.id, [
		{
			name: "Acme Robotics",
			source: "greenhouse",
			sourceKey: "acme-flagged",
			discoveredFrom: "test",
		},
	]);
	const [company] = await t.db
		.select({ id: companies.id })
		.from(companies)
		.where(eq(companies.userId, a.id));
	({ jobId } = await repo.upsertJob(a.id, company?.id ?? "", {
		source: "greenhouse",
		externalId: "acme-flagged",
		url: "https://example.invalid/acme/flagged",
		title: "Senior Full-Stack Engineer",
		locations: ["Remote - Worldwide"],
		workplaceType: "remote",
		descriptionText: readFileSync(
			join(FIXTURES, "acme-senior-fullstack.txt"),
			"utf8",
		),
	}));
	await workflows.startBatch([{ userId: a.id, jobId }]);
	const listed = await repo.getApplicationByJob(a.id, jobId);
	if (!listed) throw new Error("no application");
	await t.db
		.update(applications)
		.set({ prepareRequestedAt: new Date() })
		.where(eq(applications.id, listed.applicationId));
	await workflows.restart({ userId: a.id, jobId });
	appId = (await repo.getApplicationByJob(a.id, jobId))?.applicationId ?? "";
});

afterAll(async () => {
	await t.close();
});

const view = () => a.rpc.application.get({ id: appId });
const flagFor = async (text: string) => {
	const flag = (await view()).flags.find((f) => f.text === text);
	if (!flag) throw new Error(`no flag for ${text}`);
	return flag;
};

describe("flagged review", () => {
	it("hands the twice-flagged draft to review instead of failing it", async () => {
		const app = await view();
		expect(app.state).toBe("ready_for_review");
		expect(app.draftStatus).toBe("claims_flagged");
		expect(app.approvable).toBe(false);
		expect(
			app.flags.filter((f) => f.state === "open").map((f) => f.text),
		).toEqual(expect.arrayContaining([K8S, KERNEL, DEGREE]));
		expect((await flagFor(DEGREE)).confirmable).toBe(false);
		expect((await flagFor(KERNEL)).confirmable).toBe(true);
		// The rendered preview marks the same lines, numbered as the flags are.
		const kernel = app.flags.findIndex((f) => f.text === KERNEL) + 1;
		expect(app.preview.cv).toMatch(
			new RegExp(
				`data-flag-state="open" title="[^"]+"><sup>${kernel}</sup>Wrote the Linux kernel&#39;s scheduler in a weekend\\.</a>`,
			),
		);
		expect(app.preview.cv).toContain("<h2>Experience</h2>");
		expect(app.preview.cover_letter).toContain('data-testid="flag-mark"');
		// Each CV and letter flag says whether the rendered view shows its mark.
		expect((await flagFor(KERNEL)).marked).toBe(true);
		for (const f of app.flags)
			expect(f.marked, f.text ?? "").toBe(
				f.document === "cv" || f.document === "cover_letter"
					? (app.preview[f.document] ?? "").includes(`href="#flag-${f.id}"`)
					: null,
			);
	});

	it("refuses approval with HTTP 409 while a flag is open", async () => {
		const response = await a.request("/rpc/application/approve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				json: {
					id: appId,
					hashes: (await view()).currentHashes,
					idempotencyKey: "approve-while-flagged",
				},
			}),
		});
		expect(response.status).toBe(409);
		expect(await response.text()).toMatch(
			/3 flagged line\(s\) still open; edit, delete or confirm each first/,
		);
		expect(await t.db.select().from(approvals)).toEqual([]);
	});

	it("re-checks only the edited line, with no new draft", async () => {
		const checks = () =>
			claimsLlm.calls.filter((c) => c.task === "claims-check").length;
		const before = checks();
		await a.rpc.application.resolveFlag({
			id: appId,
			flagId: (await flagFor(K8S)).id,
			action: "edit",
			text: "Ran Nomad clusters at Google.",
		});
		await deliver();
		expect(checks()).toBe(before + 1);
		// Only the edited line is listed to check; the documents go whole, as its context.
		const prompt = claimsLlm.calls.at(-1)?.prompt ?? "";
		expect(prompt.slice(prompt.indexOf("<segments>"))).toMatch(
			/^<segments>\n\[cv-\d+\] Ran Nomad clusters at Google\.\n<\/segments>/,
		);
		const open = (await view()).flags
			.filter((f) => f.state === "open")
			.map((f) => f.text);
		expect(open).toContain("Ran Nomad clusters at Google.");
		expect(open).not.toContain(K8S);
	});

	it("deletes a line", async () => {
		await a.rpc.application.resolveFlag({
			id: appId,
			flagId: (await flagFor("Ran Nomad clusters at Google.")).id,
			action: "delete",
		});
		await deliver();
		const app = await view();
		expect(app.documents.find((d) => d.kind === "cv")?.content).not.toContain(
			"Nomad",
		);
		expect(app.flags.map((f) => f.text)).not.toContain(
			"Ran Nomad clusters at Google.",
		);
	});

	it("cannot confirm a degree claim: a fixed rule, edit or delete only", async () => {
		await expect(
			a.rpc.application.confirmFlag({
				id: appId,
				flagId: (await flagFor(DEGREE)).id,
			}),
		).rejects.toMatchObject({
			status: 409,
			message: expect.stringMatching(
				/^Refusing to confirm: this line breaks a fixed rule \("Bachelor's" must not be claimed \(education\.md: did not graduate.*\)\. Edit or delete it instead\.$/,
			),
		});
		const facts = await t.db
			.select()
			.from(profileFacts)
			.where(eq(profileFacts.userId, a.id));
		expect(facts).toEqual([]);
		await a.rpc.application.resolveFlag({
			id: appId,
			flagId: (await flagFor(DEGREE)).id,
			action: "delete",
		});
		await deliver();
		expect(
			(await view()).documents.find((d) => d.kind === "cover_letter")?.content,
		).not.toContain("Bachelor");
	});

	it("re-runs the fixed rules on the line itself before a confirmation", async () => {
		const [review] = await t.db
			.select({ id: reviewChecks.id, flags: reviewChecks.flags })
			.from(reviewChecks)
			.where(eq(reviewChecks.applicationId, appId))
			.orderBy(desc(reviewChecks.createdAt))
			.limit(1);
		if (!review) throw new Error("no review");
		// A flag that claims to be confirmable, on a line naming a Don't-claim term.
		const forged = {
			id: "cv-forged",
			document: "cv" as const,
			text: "Built **Rust** services for billing.",
			reasons: [
				{ rule: "unsupported_claim" as const, message: "Unsupported claim." },
			],
			confirmable: true,
			state: "open" as const,
		};
		await t.db
			.update(reviewChecks)
			.set({ flags: [...review.flags, forged] })
			.where(eq(reviewChecks.id, review.id));
		await expect(
			a.rpc.application.confirmFlag({ id: appId, flagId: "cv-forged" }),
		).rejects.toMatchObject({
			status: 409,
			message: expect.stringMatching(/breaks a fixed rule \("Rust"/),
		});
		await t.db
			.update(reviewChecks)
			.set({ flags: review.flags })
			.where(eq(reviewChecks.id, review.id));
		expect(
			await t.db
				.select()
				.from(profileFacts)
				.where(eq(profileFacts.userId, a.id)),
		).toEqual([]);
	});

	it("confirms a line into that user's profile only, then approves the exact documents", async () => {
		const result = await a.rpc.application.confirmFlag({
			id: appId,
			flagId: (await flagFor(KERNEL)).id,
		});
		expect(result.open).toBe(0);
		const [fact] = await t.db
			.select()
			.from(profileFacts)
			.where(eq(profileFacts.userId, a.id));
		expect(fact).toMatchObject({
			answer: KERNEL,
			source: "user confirmation",
			questionSource: "confirmation",
			applicationId: appId,
		});
		const answers = (await repo.getProfile(a.id))?.files.find(
			(f) => f.path === "answers.md",
		)?.content;
		// Confirmed under a CV role: the line names it, so it vouches for that employer only.
		const role = answers?.match(
			/- Confirmed as true by the user, in the CV under the role (.+ — (.+)): /,
		);
		expect(role).not.toBeNull();
		expect(answers).toContain(
			`${role?.[0]}${KERNEL}\n- Source: user confirmation, ${new Date().toISOString().slice(0, 10)}`,
		);
		expect(fact?.question).toContain(`under "${role?.[1]}"`);
		// The confirmed text is evidence; the checker's notes about it are not in the file.
		const profile = await repo.getProfile(a.id);
		if (!profile || !answers) throw new Error("no profile");
		expect(answers).not.toContain("Unsupported claim");
		expect(answers).not.toContain("No profile line states this");
		expect(checkQuote(profile, "answers.md", KERNEL).ok).toBe(true);
		const letterFree = {
			documents: {
				cv: `# Sam Rivera\n\n## Experience\n\n- ${KERNEL}`,
				cover_letter: "",
				form_answers: "",
			},
			formAnswers: [],
			profile,
			context: {
				companyName: "Acme Robotics",
				jobTitle: "Senior Full-Stack Engineer",
			},
			postingText: "",
		};
		const [segment] = segmentDocuments(letterFree).filter(
			(x) => x.text === KERNEL,
		);
		const report = verifyClaims(
			{
				claims: [
					{
						segments: [segment?.id ?? ""],
						document: "cv",
						text: KERNEL,
						supported: true,
						evidence: [{ file: "answers.md", quote: KERNEL }],
						note: "Confirmed by the candidate.",
					},
				],
				skipped: [],
			},
			letterFree,
			"test",
		);
		expect(
			report.issues.filter(
				(x) => x.rule !== "length" && x.rule !== "name_spelling",
			),
		).toEqual([]);
		// The same words moved under another employer are not supported by that confirmation.
		const other = (profile.files ?? [])
			.map((f) => f.content.match(/^# (.+?) — (.+)$/m))
			.find((m) => m?.[1] && m[1] !== role?.[2]);
		if (!other) throw new Error("no second employer in the fixture profile");
		const moved = {
			...letterFree,
			documents: {
				...letterFree.documents,
				cv: `# Sam Rivera\n\n## Experience\n\n### ${other[2]} — ${other[1]}\n\n- ${KERNEL}`,
			},
		};
		const [movedSegment] = segmentDocuments(moved).filter(
			(x) => x.text === KERNEL,
		);
		const movedReport = verifyClaims(
			{
				claims: [
					{
						segments: [movedSegment?.id ?? ""],
						document: "cv",
						text: KERNEL,
						supported: true,
						evidence: [{ file: "answers.md", quote: KERNEL }],
						note: "Confirmed by the candidate.",
					},
				],
				skipped: [],
			},
			moved,
			"test",
		);
		expect(movedReport.issues).toContainEqual(
			expect.objectContaining({
				rule: "unchecked_line",
				excerpt: KERNEL,
				message: expect.stringContaining(`not about ${other[1]}`),
			}),
		);
		const theirs = (await repo.getProfile(b.id))?.files ?? [];
		expect(JSON.stringify(theirs)).not.toContain("Linux kernel");
		expect(await b.rpc.questions.facts()).toEqual([]);

		// The last flag closed: the workflow exports and runs the ATS check, then Approve opens.
		await deliver();
		const app = await view();
		expect(app.approvable).toBe(true);
		expect(app.flags.find((f) => f.text === KERNEL)?.state).toBe("confirmed");
		await a.rpc.application.approve({
			id: appId,
			hashes: app.currentHashes,
			idempotencyKey: "approve-after-flags",
		});
		const [approval] = await t.db.select().from(approvals);
		expect(approval?.documentHashes).toEqual(app.currentHashes);
		expect((await view()).state).toBe("approved");
	});
});
