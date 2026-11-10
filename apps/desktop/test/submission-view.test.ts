import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { submissionModeAfterRead } from "@offerfinch/core/apply/modes";
import { formUrlOf, modeOf } from "@offerfinch/core/apply/submit";
import type { NormalizedJob } from "@offerfinch/core/domain/types";
import {
	DashboardRepository,
	ensureUser,
	openSqlite,
	seedCompanies,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { describe, expect, it } from "vitest";
import { submissionView } from "../src/worker/routers/pipeline";

/**
 * Plan step 6: review shows the mode and the form the submission uses. Both read the job through
 * core's `formTargetFor`; this checks the review's view against the submission context.
 */

async function repoWithJobs(
	jobs: Pick<NormalizedJob, "source" | "url" | "applyUrl">[],
): Promise<{ repo: DashboardRepository; ids: string[] }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-view-"));
	const db = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	await ensureUser(db, { id: "u1", name: "U", email: "u1@example.test" });
	await seedCompanies(db, "u1", [
		{
			name: "Acme",
			source: "greenhouse",
			sourceKey: "acme",
			discoveredFrom: "t",
		},
	]);
	const repo = new DashboardRepository(db);
	const [company] = await repo.listCompanies("u1");
	const ids: string[] = [];
	for (const [i, job] of jobs.entries()) {
		const { jobId } = await repo.upsertJob("u1", company?.id ?? "", {
			...job,
			externalId: `view-${i}`,
			title: "Engineer",
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: "TypeScript",
		});
		ids.push(
			(await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "",
		);
	}
	return { repo, ids };
}

describe("review and submission decide the form the same way", () => {
	it("matches mode and form URL for board, linked-board, web and hand-off jobs", async () => {
		const jobs = [
			{
				source: "greenhouse",
				url: "https://boards.greenhouse.io/acme/jobs/view-0",
			},
			{
				source: "linkedin",
				url: "https://www.linkedin.com/jobs/view/1",
				applyUrl: "https://job-boards.greenhouse.io/acmerobotics/jobs/4012345",
			},
			{
				source: "web",
				url: "https://careers.acme-robotics.example/jobs/42/apply",
			},
			{ source: "linkedin", url: "https://www.linkedin.com/jobs/view/2" },
			{ source: "manual", url: "https://careers.acme-robotics.example/jobs/9" },
		] as const;
		const { repo, ids } = await repoWithJobs([...jobs]);
		const modes: string[] = [];
		for (const id of ids) {
			const view = await submissionView(repo, "u1", id, await jobOf(repo, id));
			const context = await repo.submissionContext("u1", id);
			if (!context) throw new Error("no context");
			const submitMode = submissionModeAfterRead(
				modeOf(context),
				context.board,
				await repo.formRead("u1", id),
			);
			expect(view.mode).toEqual(submitMode);
			if (context.board)
				expect(view.postingForm).toBe(formUrlOf(context, context.board));
			modes.push(`${context.board}:${view.mode.mode}`);
		}
		// The web form was never read here, so it is a hand-off until it is.
		expect(modes).toEqual([
			"greenhouse:auto",
			"greenhouse:auto",
			"web:handoff",
			"null:handoff",
			"null:handoff",
		]);
	});
});

async function jobOf(repo: DashboardRepository, applicationId: string) {
	const detail = await repo.getApplication("u1", applicationId);
	if (!detail) throw new Error("no detail");
	return { job: detail.job, companyKey: detail.company.key };
}
