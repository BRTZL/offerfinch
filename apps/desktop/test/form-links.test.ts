import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DashboardRepository,
	ensureUser,
	openSqlite,
	seedCompanies,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import {
	applications,
	jobs,
	submissionAttempts,
} from "@offerfinch/db/schema/pipeline";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { applicationFormLink, postingLink } from "../src/worker/links";

/**
 * Review fix (2026-11-09): the page names an application and the attempt it showed, never a URL.
 * The worker resolves the form or posting from stored data, for the session's user only, and the
 * form opens only for the current attempt, and after a click that may have sent the application
 * only once "It didn't go through" is recorded.
 */

const FORM = "https://boards.greenhouse.io/acme/jobs/links-1";

let repo: DashboardRepository;
let db: ReturnType<typeof openSqlite>;
let n = 0;

beforeAll(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-links-"));
	db = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	await ensureUser(db, { id: "u1", name: "U", email: "u1@example.test" });
	await ensureUser(db, { id: "u2", name: "V", email: "u2@example.test" });
	await seedCompanies(db, "u1", [
		{
			name: "Acme",
			source: "greenhouse",
			sourceKey: "acme",
			discoveredFrom: "t",
		},
	]);
	repo = new DashboardRepository(db);
});

/** One of u1's Greenhouse applications, set straight to `state` with the given attempts. */
async function application(
	state: "approved" | "needs_human" | "applied",
	attempts: {
		status: string;
		url?: string | null;
		proof?: Record<string, unknown>;
	}[] = [],
) {
	n++;
	const [company] = await repo.listCompanies("u1");
	const { jobId } = await repo.upsertJob("u1", company?.id ?? "", {
		source: "greenhouse",
		externalId: `links-${n}`,
		url: `https://boards.greenhouse.io/acme/jobs/links-${n}`,
		title: "Engineer",
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "TypeScript",
	});
	const id = (await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
	await db.update(applications).set({ state }).where(eq(applications.id, id));
	const ids: string[] = [];
	for (const [i, a] of attempts.entries()) {
		const [row] = await db
			.insert(submissionAttempts)
			.values({
				userId: "u1",
				applicationId: id,
				attempt: i + 1,
				status: a.status as "not_sent",
				mode: "auto",
				board: "greenhouse",
				url: a.url === undefined ? FORM : a.url,
				proof: a.proof ?? null,
			})
			.returning({ id: submissionAttempts.id });
		ids.push(row?.id ?? "");
	}
	return { id, jobId, attempts: ids };
}

describe("the links the page asks the worker to open", () => {
	it("opens an approved hand-off's form with no attempt, and the posting", async () => {
		const app = await application("approved");
		expect(await applicationFormLink(repo, "u1", app.id, null)).toMatch(
			/^https:\/\/.*greenhouse/,
		);
		expect(await postingLink(repo, "u1", app.id)).toBe(
			`https://boards.greenhouse.io/acme/jobs/links-${n}`,
		);
	});

	it("refuses another user's application", async () => {
		const app = await application("needs_human", [{ status: "not_sent" }]);
		await expect(
			applicationFormLink(repo, "u2", app.id, app.attempts[0] ?? null),
		).rejects.toThrow(/not found/);
		await expect(postingLink(repo, "u2", app.id)).rejects.toThrow(/not found/);
	});

	it("refuses an attempt that is no longer the current one", async () => {
		const app = await application("needs_human", [
			{ status: "not_sent" },
			{ status: "not_sent" },
		]);
		await expect(
			applicationFormLink(repo, "u1", app.id, app.attempts[0] ?? null),
		).rejects.toThrow("This changed since you opened it; look again.");
		await expect(applicationFormLink(repo, "u1", app.id, null)).rejects.toThrow(
			"This changed since you opened it; look again.",
		);
		expect(
			await applicationFormLink(repo, "u1", app.id, app.attempts[1] ?? null),
		).toBe(FORM);
	});

	it("refuses a sent employer's form, or an unknown outcome, until It didn't go through is recorded", async () => {
		for (const proof of [{ outcome: "web_sent" }, {}]) {
			const app = await application("needs_human", [
				{ status: "needs_human", proof },
			]);
			const attemptId = app.attempts[0] ?? null;
			await expect(
				applicationFormLink(repo, "u1", app.id, attemptId),
			).rejects.toThrow(/attempt 1 may have gone through/);
			// A stale confirmation is refused too, and records nothing.
			await expect(
				repo.confirmNotSent({
					userId: "u1",
					applicationId: app.id,
					attemptId: crypto.randomUUID(),
				}),
			).rejects.toThrow("This changed since you opened it; look again.");
			expect(
				await repo.confirmNotSent({
					userId: "u1",
					applicationId: app.id,
					attemptId: attemptId ?? "",
				}),
			).toEqual({ attempt: 1 });
			// Recorded once; a repeat changes nothing.
			expect(
				await repo.confirmNotSent({
					userId: "u1",
					applicationId: app.id,
					attemptId: attemptId ?? "",
				}),
			).toEqual({ attempt: null });
			expect(await applicationFormLink(repo, "u1", app.id, attemptId)).toBe(
				FORM,
			);
			const [row] = await db
				.select({
					status: submissionAttempts.status,
					resolution: submissionAttempts.resolution,
				})
				.from(submissionAttempts)
				.where(eq(submissionAttempts.id, attemptId ?? ""));
			expect(row).toEqual({
				status: "not_sent",
				resolution: "The user confirmed it did not go through",
			});
		}
	});

	it("refuses once the application was submitted", async () => {
		const app = await application("applied", [{ status: "submitted" }]);
		await expect(
			applicationFormLink(repo, "u1", app.id, app.attempts[0] ?? null),
		).rejects.toThrow(/only before it is submitted/);
	});

	it("never hands main a link that is not http(s)", async () => {
		const stored = await application("needs_human", [
			{ status: "not_sent", url: "file:///etc/passwd" },
		]);
		await expect(
			applicationFormLink(repo, "u1", stored.id, stored.attempts[0] ?? null),
		).rejects.toThrow(/not a web link/);
		const posting = await application("approved");
		await db
			.update(jobs)
			.set({ url: "javascript:alert(1)" })
			.where(eq(jobs.id, posting.jobId));
		await expect(postingLink(repo, "u1", posting.id)).rejects.toThrow(
			/not a web link/,
		);
	});
});
