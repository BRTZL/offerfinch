import type { NormalizedJob } from "@offerfinch/core/domain/types";
import type { ExperienceData } from "@offerfinch/core/profile/records";
import type { ReviewFlag } from "@offerfinch/core/tailor/flags";
import {
	CONFIRMATION_SOURCE,
	confirmationQuestion,
} from "@offerfinch/core/tailor/profile-rules";
import { citedUnits } from "@offerfinch/core/tailor/stale";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	addRecord,
	convertProfileFiles,
	DashboardRepository,
	type Database,
	ensureUser,
	importProfile,
	listRecords,
	moveRecord,
	removeRecord,
	replaceRecords,
	seedCompanies,
	updateRecord,
} from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;

const role: ExperienceData = {
	company: "Harbor Mills",
	title: "Frontend Engineer",
	location: "Remote",
	start: "Jan 2021",
	end: "Mar 2024",
	bullets: ["Built the billing page in React and cut checkout errors by 30%."],
	more: "",
};

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
});

afterAll(() => db.$close());

describe("profile records", () => {
	it("renders as the profile, keeps answers, and edits in place", async () => {
		await replaceRecords(db, "u1", [
			{
				kind: "about",
				source: "a pasted resume",
				data: {
					name: "Avery Quinn",
					email: "avery@example.com",
					phone: "",
					location: "Lisbon, Portugal",
					linkedin: "",
					website: "",
					github: "",
					summary: "",
					more: "",
				},
			},
			{ kind: "skill", source: "a pasted resume", data: { name: "React" } },
			{ kind: "skill", source: "a pasted resume", data: { name: "Vitest" } },
			{ kind: "experience", source: "a pasted resume", data: role },
		]);
		await repo.addFact("u1", {
			question: "Notice period?",
			answer: "One month.",
		});
		const records = await listRecords(db, "u1");
		const exp = records.find((r) => r.kind === "experience");
		const profile = await repo.getProfile("u1");
		expect(profile?.files.map((f) => f.path)).toEqual([
			"personal.md",
			"skills.md",
			`experience/${exp?.id}.md`,
			"answers.md",
		]);
		await expect(
			addRecord(
				db,
				"u1",
				{ kind: "about", data: { name: "Second" } as never },
				"you",
			),
		).rejects.toThrow(/one About/);

		const skill = records.find(
			(r) => r.kind === "skill" && r.data.name === "Vitest",
		);
		expect(await moveRecord(db, "u1", skill?.id ?? "", "up")).toBe(true);
		expect(
			(await listRecords(db, "u1"))
				.filter((r) => r.kind === "skill")
				.map((r) => r.position),
		).toEqual([0, 1]);
		expect(
			(await listRecords(db, "u1")).flatMap((r) =>
				r.kind === "skill" ? [r.data.name] : [],
			),
		).toEqual(["Vitest", "React"]);

		const other = await updateRecord(
			db,
			"u2",
			exp?.id ?? "",
			{ kind: "experience", data: role },
			{ source: "you" },
		);
		expect(other).toBeNull();
		expect(await removeRecord(db, "u2", exp?.id ?? "")).toBe(false);
	});

	it("converts a profile kept as files once, and only when asked", async () => {
		await ensureUser(db, { id: "u3", name: "Robin", email: "u3@example.test" });
		await importProfile(
			db,
			"u3",
			{
				files: [
					{
						path: "personal.md",
						content: "# Personal\n\n- **Name:** Robin Vale\n",
					},
					{
						path: "experience/2022-lumen.md",
						content:
							"# Lumen — Engineer\n\n- **Dates:** 2022 – Present\n- **Location:** Porto\n\n## What I did\n\n- Shipped the search page.\n",
					},
				],
			},
			"test",
		);
		// Before conversion the files are read as they are.
		expect((await repo.getProfile("u3"))?.files.map((f) => f.path)).toContain(
			"experience/2022-lumen.md",
		);
		expect(await convertProfileFiles(db, "u3")).toBe(2);
		expect(await convertProfileFiles(db, "u3")).toBe(0);
		const content = (await repo.getProfile("u3"))?.files
			.map((f) => f.content)
			.join("\n");
		expect(content).toContain("- Shipped the search page.");
		expect(content).toContain("- **Name:** Robin Vale");
	});
});

describe("approval and the profile a review cited", () => {
	const job: NormalizedJob = {
		source: "greenhouse",
		externalId: "91",
		url: "https://boards.greenhouse.io/acme/jobs/91",
		title: "Frontend Engineer",
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "React",
	};

	async function reviewedApplication(
		externalId = "91",
		flags: ReviewFlag[] = [],
	): Promise<{
		appId: string;
		hashes: Record<string, string>;
	}> {
		await seedCompanies(db, "u1", [
			{
				name: "Acme",
				source: "greenhouse",
				sourceKey: "acme",
				discoveredFrom: "t",
			},
		]);
		const [company] = await execute<{ id: string }>(
			db,
			sql`select id from companies where user_id = 'u1'`,
		);
		const { jobId } = await repo.upsertJob("u1", company?.id ?? "", {
			...job,
			externalId,
			url: `https://boards.greenhouse.io/acme/jobs/${externalId}`,
		});
		const appId =
			(await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
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
		await repo.saveDraft(
			"u1",
			appId,
			{
				notes: "# Notes",
				cv: "# CV\n\n- Cut checkout errors by 30% with a React billing page.",
				coverLetter: "Letter",
				formAnswers: [],
			},
			"workflow",
		);
		await repo.transition("u1", appId, {
			from: ["preparing"],
			to: "ready_for_review",
			reason: "prepared",
			actor: "workflow",
		});
		const hashes =
			(await repo.getApplication("u1", appId))?.currentHashes ?? {};
		const exp = (await listRecords(db, "u1")).find(
			(r) => r.kind === "experience",
		);
		const claims = [
			{
				document: "cv",
				text: "Cut checkout errors by 30% with a React billing page.",
				supported: true,
				evidence: [
					{
						file: `experience/${exp?.id}.md`,
						quote:
							"Built the billing page in React and cut checkout errors by 30%.",
					},
				],
				note: "",
				rejected: [],
			},
		];
		const review = await repo.recordReview("u1", appId, {
			documentHashes: hashes,
			provider: "test",
			passed: true,
			issues: [],
			claims,
			flags,
			// As the review step records it: bound to the cited records' text at check time.
			cited: citedUnits(claims, (await repo.getProfile("u1")) ?? { files: [] }),
		});
		await repo.completeReview("u1", review, []);
		return { appId, hashes: hashes as Record<string, string> };
	}

	it("refuses approval once a cited record is edited, and lets the check run again", async () => {
		const { appId, hashes } = await reviewedApplication();
		const exp = (await listRecords(db, "u1")).find(
			(r) => r.kind === "experience",
		);
		await updateRecord(
			db,
			"u1",
			exp?.id ?? "",
			{
				kind: "experience",
				data: {
					...role,
					bullets: [
						"Built the billing page in React and cut checkout errors by 20%.",
					],
				},
			},
			{ source: "you" },
		);
		await expect(
			repo.approve({
				userId: "u1",
				applicationId: appId,
				approvedHashes: hashes,
				idempotencyKey: "p1",
			}),
		).rejects.toThrow(/profile changed since the check/);
		const event = await repo.retryCheck({ userId: "u1", applicationId: appId });
		expect(event.eventId).toBeTruthy();
		// The same review, retried twice, is one event.
		expect(
			await repo.retryCheck({ userId: "u1", applicationId: appId }),
		).toEqual(event);

		// Put back as it was, the citation holds again.
		await updateRecord(
			db,
			"u1",
			exp?.id ?? "",
			{ kind: "experience", data: role },
			{ source: "you" },
		);
		await expect(
			repo.retryCheck({ userId: "u1", applicationId: appId }),
		).rejects.toThrow(/no check error/);
	});

	it("refuses approval once the cited role's company changes and its bullet stays (Codex, b74f1bc)", async () => {
		await replaceRecords(db, "u1", [
			{ kind: "about", source: "t", data: { name: "Avery Quinn" } as never },
			{ kind: "experience", source: "t", data: role },
		]);
		const { appId, hashes } = await reviewedApplication("93");
		const exp = (await listRecords(db, "u1")).find(
			(r) => r.kind === "experience",
		);
		await updateRecord(
			db,
			"u1",
			exp?.id ?? "",
			{ kind: "experience", data: { ...role, company: "Beta Works" } },
			{ source: "you" },
		);
		await expect(
			repo.approve({
				userId: "u1",
				applicationId: appId,
				approvedHashes: hashes,
				idempotencyKey: "r1",
			}),
		).rejects.toThrow(/profile changed since the check/);
	});

	it("refuses approval once a cited record is removed", async () => {
		const appId =
			(
				await execute<{ id: string }>(
					db,
					sql`select id from applications where user_id = 'u1'`,
				)
			)[0]?.id ?? "";
		const hashes =
			(await repo.getApplication("u1", appId))?.currentHashes ?? {};
		const exp = (await listRecords(db, "u1")).find(
			(r) => r.kind === "experience",
		);
		expect(await removeRecord(db, "u1", exp?.id ?? "")).toBe(true);
		await expect(
			repo.approve({
				userId: "u1",
				applicationId: appId,
				approvedHashes: hashes,
				idempotencyKey: "p2",
			}),
		).rejects.toThrow(/profile changed since the check/);
	});

	it("refuses approval once the answer that confirmed a flagged line is removed", async () => {
		const line = "Mentored two junior engineers through their first releases.";
		// The cited role is back, so only the confirmation decides.
		await replaceRecords(db, "u1", [
			{ kind: "about", source: "t", data: { name: "Avery Quinn" } as never },
			{ kind: "experience", source: "t", data: role },
		]);
		const { appId, hashes } = await reviewedApplication("92", [
			{
				id: "flag-1",
				document: "cv",
				text: line,
				reasons: [],
				confirmable: true,
				state: "confirmed",
				confirmedAt: new Date().toISOString(),
			},
		]);
		const fact = await repo.addFact("u1", { question: "q", answer: line });
		await execute(
			db,
			sql`update profile_facts set question_source = 'confirmation', source = ${CONFIRMATION_SOURCE}, question = ${confirmationQuestion({ document: "cv", role: null, company: "Acme", title: "Frontend Engineer" })} where id = ${fact?.id ?? ""}`,
		);
		await repo.removeFact("u1", fact?.id ?? "");
		await expect(
			repo.approve({
				userId: "u1",
				applicationId: appId,
				approvedHashes: hashes,
				idempotencyKey: "c1",
			}),
		).rejects.toThrow(/profile changed since the check/);

		// Confirmed again, word for word, the line stands and approval goes through.
		const again = await repo.addFact("u1", { question: "q", answer: line });
		await execute(
			db,
			sql`update profile_facts set question_source = 'confirmation', source = ${CONFIRMATION_SOURCE} where id = ${again?.id ?? ""}`,
		);
		await repo.approve({
			userId: "u1",
			applicationId: appId,
			approvedHashes: hashes,
			idempotencyKey: "c2",
		});
		expect(await repo.getState("u1", appId)).toBe("approved");
	});
});
