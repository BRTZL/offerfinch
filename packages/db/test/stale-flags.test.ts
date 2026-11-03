import type { NormalizedJob } from "@offerfinch/core/domain/types";
import {
	type CheckedClaim,
	type ClaimsInput,
	segmentDocuments,
	verifyClaims,
} from "@offerfinch/core/tailor/claims";
import { buildFlags } from "@offerfinch/core/tailor/flags";
import type { RuleIssue } from "@offerfinch/core/tailor/profile-rules";
import { formAnswersText } from "@offerfinch/core/tailor/tailor";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	importProfile,
	seedCompanies,
} from "../src/index";
import { profileFacts } from "../src/schema/pipeline";
import { execute, testDb } from "./setup";

/**
 * A review an older claims check flagged on lines the current check accepts: the flags are
 * cleared at startup from the stored claims, with no model call, and the review passes its
 * claims part once none is open.
 */

let db: Database;
let repo: DashboardRepository;

const CLOSER = "Please let me know a convenient time to talk about the role.";
const FACT =
	"talabat needs Go experts, and I have built Go services for 5 years.";
const SKIPPED =
	"The claims check skipped this as about company or role, but it states a fact about the candidate.";

const job = (
	id: string,
	descriptionText = "Build and run backend services in Go.",
): NormalizedJob => ({
	source: "greenhouse",
	externalId: id,
	url: `https://boards.greenhouse.io/talabat/jobs/${id}`,
	title: "Software Engineer II - Backend",
	locations: ["Dubai"],
	workplaceType: "onsite",
	descriptionText,
});

/**
 * An application in review whose latest check flagged `lines` of the letter as skipped, and the
 * CV lines of `cvFlags` with their messages, on the `claims` the check kept.
 */
async function flaggedApp(
	id: string,
	lines: string[],
	options: {
		cv?: string;
		posting?: string;
		cvFlags?: { text: string; message: string }[];
		claims?: (input: ClaimsInput) => CheckedClaim[];
		/** Issues stored with the review but with no flag of their own. */
		unflagged?: RuleIssue[];
	} = {},
) {
	const cv = options.cv ?? "# Ada Example";
	const [company] = await execute<{ id: string }>(
		db,
		sql`select id from companies where user_id = 'u1'`,
	);
	const posted = job(id, options.posting);
	const { jobId } = await repo.upsertJob("u1", company?.id ?? "", posted);
	const app = await repo.getApplicationByJob("u1", jobId);
	const appId = app?.applicationId ?? "";
	for (const [from, to] of [
		["found", "scored"],
		["scored", "preparing"],
	] as const)
		await repo.transition("u1", appId, {
			from: [from],
			to,
			reason: "t",
			actor: "workflow",
		});
	const coverLetter = `Dear Hiring Team,\n\n${lines.join("\n\n")}\n\nBest regards,\\\nAda Example`;
	await repo.saveDraft(
		"u1",
		appId,
		{ notes: "# Notes", cv, coverLetter, formAnswers: [] },
		"workflow",
	);
	await repo.transition("u1", appId, {
		from: ["preparing"],
		to: "ready_for_review",
		reason: "prepared",
		actor: "workflow",
	});
	const input: ClaimsInput = {
		documents: {
			cv,
			cover_letter: coverLetter,
			form_answers: formAnswersText([]),
		},
		formAnswers: [],
		profile: (await repo.getProfile("u1")) ?? { files: [] },
		context: { companyName: "talabat", jobTitle: posted.title },
		postingText: posted.descriptionText,
	};
	const segments = segmentDocuments(input);
	// What the older check raised: each line skipped as about the company, refused.
	const issues: RuleIssue[] = segments
		.filter((s) => lines.includes(s.text))
		.map((s) => ({
			rule: "unchecked_line",
			document: s.document,
			message: SKIPPED,
			excerpt: s.text,
			lines: [s.text],
			at: [{ context: s.context, occurrence: s.occurrence }],
		}));
	for (const flag of options.cvFlags ?? []) {
		const s = segments.find((x) => x.document === "cv" && x.text === flag.text);
		if (!s) throw new Error(`no CV segment "${flag.text}"`);
		issues.push({
			rule: "unchecked_line",
			document: "cv",
			message: flag.message,
			excerpt: s.text,
			lines: [s.text],
			at: [{ context: s.context, occurrence: s.occurrence }],
		});
	}
	const detail = await repo.getApplication("u1", appId);
	const reviewId = await repo.recordReview("u1", appId, {
		documentHashes: detail?.currentHashes ?? {},
		provider: "test",
		passed: false,
		issues: [...issues, ...(options.unflagged ?? [])],
		claims: options.claims?.(input) ?? [],
		status: "claims_flagged",
		flags: buildFlags(issues, [], segments),
		segments,
	});
	return { appId, reviewId };
}

/** The check's kept claim for one CV line, citing one quote of answers.md. */
const claimCiting =
	(line: string, quote: string) =>
	(input: ClaimsInput): CheckedClaim[] => {
		const id = segmentDocuments(input).find((s) => s.text === line)?.id;
		return verifyClaims(
			{
				claims: [
					{
						segments: [id ?? ""],
						document: "cv",
						text: line,
						supported: true,
						evidence: [{ file: "answers.md", quote }],
						note: "The user said yes.",
					},
				],
				skipped: [],
			},
			input,
			"test",
		).claims;
	};

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	await importProfile(
		db,
		"u1",
		{ files: [{ path: "skills.md", content: "- Go" }] },
		"test",
	);
	// The user's qualified yes: it names Docker only.
	await db.insert(profileFacts).values({
		userId: "u1",
		question: "Have you worked with Docker and Kubernetes?",
		answer: "yes, with Docker",
		source: "user",
		questionSource: "pipeline",
	});
	await seedCompanies(db, "u1", [
		{
			name: "talabat",
			source: "greenhouse",
			sourceKey: "talabat",
			discoveredFrom: "t",
		},
	]);
});

afterAll(() => {
	db.$close();
});

describe("stale flags cleared at startup", () => {
	it("clears a closer an older check refused, and passes the review when none is open", async () => {
		const { appId, reviewId } = await flaggedApp("1", [CLOSER]);
		const { cleared, events } = await repo.clearStaleFlags("u1");
		expect(cleared).toBe(1);
		expect(events).toHaveLength(1);
		const review = await repo.latestReview("u1", appId);
		expect(review?.id).toBe(reviewId);
		expect(review?.flags).toEqual([]);
		expect(review?.issues).toEqual([]);
		expect(review?.passed).toBe(true);
		expect(review?.status).toBe("passed");
		// Run again: nothing left to clear.
		expect((await repo.clearStaleFlags("u1")).cleared).toBe(0);
	});

	it("clears the closer but never passes a review a fixed-rule issue still blocks", async () => {
		const length: RuleIssue = {
			rule: "length",
			document: "cover_letter",
			message: "The letter is 120 words; it must be 250 to 400.",
		};
		const { appId } = await flaggedApp("1b", [CLOSER], { unflagged: [length] });
		const { cleared, events } = await repo.clearStaleFlags("u1");
		expect(cleared).toBe(1);
		expect(events).toEqual([]);
		const review = await repo.latestReview("u1", appId);
		expect(review?.flags).toEqual([]);
		expect(review?.issues).toEqual([length]);
		expect(review?.passed).toBe(false);
		expect(review?.status).toBe("claims_flagged");
	});

	it("keeps a skipped line that states a fact, and the review stays flagged", async () => {
		const { appId } = await flaggedApp("2", [CLOSER, FACT]);
		const { cleared, events } = await repo.clearStaleFlags("u1");
		expect(cleared).toBe(1);
		expect(events).toEqual([]);
		const review = await repo.latestReview("u1", appId);
		expect(review?.flags?.map((f) => f.text)).toEqual([FACT]);
		expect(review?.issues.map((i) => i.excerpt)).toEqual([FACT]);
		expect(review?.passed).toBe(false);
		expect(review?.status).toBe("claims_flagged");
	});

	it("never clears a flag on the candidate in the third person, a trailing claim, or a qualified yes", async () => {
		const AUTHOR = "The author uses Go for backend services in this role.";
		const AS_AUTHOR =
			"The role asks engineers to understand customer problems, as the author does.";
		const K8S = "Infrastructure: Kubernetes";
		const before = await repo.clearStaleFlags("u1");
		const { appId } = await flaggedApp("3", [AUTHOR, AS_AUTHOR], {
			cv: `# Ada Example\n\n## Skills\n\n- ${K8S}`,
			cvFlags: [
				{
					text: K8S,
					message: "Not in the profile files its claims cite: kubernete.",
				},
			],
			claims: (input) => {
				const id = segmentDocuments(input).find((s) => s.text === K8S)?.id;
				return verifyClaims(
					{
						claims: [
							{
								segments: [id ?? ""],
								document: "cv",
								text: K8S,
								supported: true,
								evidence: [{ file: "answers.md", quote: "yes, with Docker" }],
								note: "The user said yes.",
							},
						],
						skipped: [],
					},
					input,
					"test",
				).claims;
			},
		});
		const stored = await repo.latestReview("u1", appId);
		// The stored claim cites the real answer line: only the reading of it is refused.
		expect(
			((stored?.claims ?? []) as CheckedClaim[])[0]?.evidence.map(
				(e) => e.quote,
			),
		).toEqual(["yes, with Docker"]);
		expect(before.cleared).toBe(0);
		const { cleared, events } = await repo.clearStaleFlags("u1");
		expect(cleared).toBe(0);
		expect(events).toEqual([]);
		const review = await repo.latestReview("u1", appId);
		expect(review?.flags?.map((f) => f.text).sort()).toEqual(
			[AS_AUTHOR, AUTHOR, K8S].sort(),
		);
		expect(review?.passed).toBe(false);
		expect(review?.status).toBe("claims_flagged");
	});

	it("clears a duty sentence, never one naming the candidate or a yes that does not state its item", async () => {
		const DUTY = "The role asks engineers to understand customer problems.";
		const JOBSEEKER =
			"The role asks engineers to understand customer problems, something the jobseeker practises.";
		const INTERVIEWEE =
			"The role asks engineers to understand customer problems, a habit of the interviewee.";
		const K8S = "Infrastructure: Kubernetes";
		const cv = `# Ada Example\n\n## Skills\n\n- ${K8S}`;
		const cvFlags = [
			{
				text: K8S,
				message: "Not in the profile files its claims cite: kubernete.",
			},
		];
		for (const [question, answer] of [
			[
				"Have you worked with Docker instead of Kubernetes?",
				"yes, at every company",
			],
			["Do you have experience with Docker and Kubernetes?", "yes, both"],
			[
				"Have you worked with Docker Over Kubernetes?",
				"yes, at all my companies",
			],
			["Have you worked with Docker and Kubernetes?", "yes. No Kubernetes."],
		])
			await db.insert(profileFacts).values({
				userId: "u1",
				question: question ?? "",
				answer: answer ?? "",
				source: "user",
				questionSource: "pipeline",
			});
		expect((await repo.clearStaleFlags("u1")).cleared).toBe(0);
		const kept = await flaggedApp("4", [DUTY, JOBSEEKER, INTERVIEWEE], {
			// The posting has every word of the trailing clause: still flagged.
			posting:
				"Understand customer problems. Our jobseeker platform practises careful work.",
			cv,
			cvFlags,
			claims: claimCiting(K8S, "yes, at every company"),
		});
		const both = await flaggedApp("5", [], {
			cv,
			cvFlags,
			claims: claimCiting(K8S, "yes, both"),
		});
		const over = await flaggedApp("6", [], {
			cv,
			cvFlags,
			claims: claimCiting(K8S, "yes, at all my companies"),
		});
		const denied = await flaggedApp("7", [], {
			cv,
			cvFlags,
			claims: claimCiting(K8S, "yes. No Kubernetes."),
		});
		const { cleared, events } = await repo.clearStaleFlags("u1");
		// The duty sentence (about the role only: no evidence needed since 2026-11-03) and the line
		// a "yes, both" backs. Sentences naming the candidate ("the jobseeker") stay flagged.
		expect(cleared).toBe(2);
		// An event only for a review that passes: the "yes, both" one.
		expect(events).toHaveLength(1);
		const review = await repo.latestReview("u1", kept.appId);
		expect(review?.flags?.map((f) => f.text).sort()).toEqual(
			[INTERVIEWEE, JOBSEEKER, K8S].sort(),
		);
		for (const app of [over, denied]) {
			const r = await repo.latestReview("u1", app.appId);
			expect(r?.flags?.map((f) => f.text)).toEqual([K8S]);
			expect(r?.status).toBe("claims_flagged");
		}
		expect(review?.status).toBe("claims_flagged");
		const passed = await repo.latestReview("u1", both.appId);
		expect(passed?.flags).toEqual([]);
		expect(passed?.status).toBe("passed");
	});
});
