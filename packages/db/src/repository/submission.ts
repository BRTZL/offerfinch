import type { FilledField } from "@offerfinch/core/apply/applier";
import { formTargetFor } from "@offerfinch/core/apply/form-target";
import type {
	AttemptInput,
	BeginOutcome,
	ClaimOutcome,
	SubmissionContext,
} from "@offerfinch/core/apply/submit";
import { parseFormAnswers } from "@offerfinch/core/tailor/tailor";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
	applications,
	companies,
	documents,
	jobs,
	submissionAttempts,
	submissionSettings,
} from "../schema/pipeline";
import type { DrizzlePipelineRepositoryContext } from "./context";
import { BLOCKING_ATTEMPTS, type Tx } from "./shared";
export const submissionMethods = {
	/* ------------------------------------------------------------ submission */

	async submissionsPaused(
		this: DrizzlePipelineRepositoryContext,
		userId: string,
		t: Tx | Database = this.db,
	): Promise<boolean> {
		const [row] = await t
			.select({ paused: submissionSettings.paused })
			.from(submissionSettings)
			.where(eq(submissionSettings.userId, userId));
		return row?.paused ?? true;
	},

	async submissionContext(
		userId: string,
		applicationId: string,
	): Promise<SubmissionContext | null> {
		const [row] = await this.db
			.select({ job: jobs, companyKey: companies.sourceKey })
			.from(applications)
			.innerJoin(
				jobs,
				and(eq(jobs.id, applications.jobId), eq(jobs.userId, userId)),
			)
			.innerJoin(
				companies,
				and(eq(companies.id, jobs.companyId), eq(companies.userId, userId)),
			)
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
		if (!row) return null;
		const docs = await this.latestDocuments(userId, applicationId);
		const byKind = Object.fromEntries(docs.map((d) => [d.kind, d]));
		const pdfFor = async (kind: "cv" | "cover_letter") => {
			const version = byKind[kind]?.version;
			if (version === undefined) return null;
			const [pdf] = await this.db
				.select({ key: documents.storageKey })
				.from(documents)
				.where(
					and(
						eq(documents.applicationId, applicationId),
						eq(documents.userId, userId),
						eq(documents.kind, kind),
						eq(documents.format, "pdf"),
						eq(documents.sourceVersion, version),
					),
				)
				.orderBy(desc(documents.version))
				.limit(1);
			return pdf?.key ?? null;
		};
		// The board from the source, else from the job's apply link (core apply/form-target.ts).
		const target = formTargetFor({
			source: row.job.source,
			url: row.job.url,
			applyUrl: row.job.applyUrl,
			externalId: row.job.externalId,
			companyKey: row.companyKey,
		});
		return {
			applicationId,
			source: row.job.source,
			board: target.board,
			boardFrom: target.from,
			...(target.reason ? { handoffNote: target.reason } : {}),
			companyKey: target.companyKey,
			externalId: target.externalId,
			jobUrl: target.url,
			formAnswers: parseFormAnswers(byKind.form_answers?.content ?? "[]"),
			coverLetterMarkdown: byKind.cover_letter?.content ?? null,
			cvPdfKey: await pdfFor("cv"),
			coverLetterPdfKey: await pdfFor("cover_letter"),
		};
	},

	async beginSubmission(
		userId: string,
		applicationId: string,
	): Promise<BeginOutcome> {
		return this.db.transaction(async (tx) => {
			const row = await this.lockOwned(tx, userId, applicationId);
			if (row.state !== "approved")
				return { outcome: "skipped", reason: row.state };
			if (await this.submissionsPaused(userId, tx))
				return {
					outcome: "paused",
					reason: "Submissions are paused; turn them on in Settings.",
				};
			const verdict = await this.approvalVerdict(tx, userId, applicationId);
			if (!verdict.ok)
				return { outcome: "not_approved", reason: verdict.reason };
			await this.move(
				userId,
				applicationId,
				["approved"],
				"applying",
				"Approved and submissions are on: submitting",
				"workflow",
				{},
				tx,
			);
			return { outcome: "started" };
		});
	},

	async nextAttempt(t: Tx, applicationId: string): Promise<number> {
		const [row] = await t
			.select({
				n: sql<number>`coalesce(max(${submissionAttempts.attempt}), 0)`,
			})
			.from(submissionAttempts)
			.where(eq(submissionAttempts.applicationId, applicationId));
		return (row?.n ?? 0) + 1;
	},

	async blockingAttempt(t: Tx, applicationId: string) {
		const [row] = await t
			.select({
				id: submissionAttempts.id,
				attempt: submissionAttempts.attempt,
				status: submissionAttempts.status,
			})
			.from(submissionAttempts)
			.where(
				and(
					eq(submissionAttempts.applicationId, applicationId),
					inArray(submissionAttempts.status, [...BLOCKING_ATTEMPTS]),
				),
			)
			.orderBy(desc(submissionAttempts.attempt))
			.limit(1);
		return row ?? null;
	},

	async resolveInterrupted(
		userId: string,
		applicationId: string,
	): Promise<boolean> {
		return this.db.transaction(async (tx) => {
			const row = await this.lockOwned(tx, userId, applicationId);
			const stale = await tx
				.update(submissionAttempts)
				.set({
					status: "needs_human",
					error:
						"Interrupted after it was cleared to submit: the click may have happened. Check the employer's portal or your email.",
					finishedAt: new Date(),
				})
				.where(
					and(
						eq(submissionAttempts.applicationId, applicationId),
						eq(submissionAttempts.userId, userId),
						eq(submissionAttempts.status, "started"),
					),
				)
				.returning({ attempt: submissionAttempts.attempt });
			if (stale.length === 0) return false;
			if (row.state === "applying")
				await this.move(
					userId,
					applicationId,
					["applying"],
					"needs_human",
					`Attempt ${stale.map((s) => s.attempt).join(", ")} was interrupted after it was cleared to submit; outcome unknown`,
					"workflow",
					{},
					tx,
				);
			return true;
		});
	},

	async claimSubmission(
		userId: string,
		applicationId: string,
		input: {
			board: string;
			url: string;
			beforeKey: string | null;
			filled: FilledField[];
		},
	): Promise<ClaimOutcome> {
		return this.db.transaction(async (tx) => {
			const row = await this.lockOwned(tx, userId, applicationId);
			if (row.state !== "applying")
				return {
					go: false,
					paused: false,
					reason: `The application is ${row.state}, not applying.`,
				};
			if (await this.submissionsPaused(userId, tx))
				return {
					go: false,
					paused: true,
					reason: "Submissions were paused before the click.",
				};
			const verdict = await this.approvalVerdict(tx, userId, applicationId);
			if (!verdict.ok)
				return {
					go: false,
					paused: false,
					reason: `No approval matches the documents (${verdict.reason}).`,
				};
			const earlier = await this.blockingAttempt(tx, applicationId);
			if (earlier)
				return {
					go: false,
					paused: false,
					reason: `Attempt ${earlier.attempt} is ${earlier.status.replace("_", " ")}; never submitting twice.`,
				};
			const [inserted] = await tx
				.insert(submissionAttempts)
				.values({
					userId,
					applicationId,
					attempt: await this.nextAttempt(tx, applicationId),
					status: "started",
					mode: "auto",
					board: input.board,
					url: input.url,
					screenshotBeforeKey: input.beforeKey,
					proof: { filled: input.filled },
				})
				.returning({ id: submissionAttempts.id });
			if (!inserted)
				throw new Error("submission attempt insert returned nothing");
			return { go: true, attemptId: inserted.id };
		});
	},

	async finishSubmission(
		userId: string,
		applicationId: string,
		attemptId: string,
		input: {
			submitted: boolean;
			afterKey: string | null;
			proof: Record<string, unknown>;
			reason: string;
		},
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			await this.lockOwned(tx, userId, applicationId);
			await tx
				.update(submissionAttempts)
				.set({
					status: input.submitted ? "submitted" : "needs_human",
					screenshotAfterKey: input.afterKey,
					proof: sql`json_patch(coalesce(${submissionAttempts.proof}, '{}'), ${JSON.stringify(input.proof)})`,
					error: input.submitted ? null : input.reason.slice(0, 2000),
					finishedAt: new Date(),
				})
				.where(
					and(
						eq(submissionAttempts.id, attemptId),
						eq(submissionAttempts.userId, userId),
						eq(submissionAttempts.status, "started"),
					),
				);
			await this.move(
				userId,
				applicationId,
				["applying"],
				input.submitted ? "applied" : "needs_human",
				input.reason,
				"workflow",
				input.submitted ? { appliedAt: new Date(), appliedVia: "auto" } : {},
				tx,
			);
		});
	},

	async insertStop(
		t: Tx,
		userId: string,
		applicationId: string,
		input: AttemptInput,
		status: "not_sent" | "dry_run",
	): Promise<string> {
		const [row] = await t
			.insert(submissionAttempts)
			.values({
				userId,
				applicationId,
				attempt: await this.nextAttempt(t, applicationId),
				status,
				mode: status === "dry_run" ? "dry_run" : "auto",
				board: input.board || null,
				url: input.url || null,
				screenshotBeforeKey: input.screenshotKey,
				proof: input.proof,
				error: input.reason.slice(0, 2000),
				finishedAt: new Date(),
			})
			.returning({ id: submissionAttempts.id });
		if (!row) throw new Error("submission attempt insert returned nothing");
		return row.id;
	},

	async stopSubmission(
		userId: string,
		applicationId: string,
		input: AttemptInput,
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			await this.lockOwned(tx, userId, applicationId);
			await this.insertStop(tx, userId, applicationId, input, "not_sent");
			await this.move(
				userId,
				applicationId,
				["applying"],
				"needs_human",
				input.reason,
				"workflow",
				{},
				tx,
			);
		});
	},

	async recordDryRun(
		userId: string,
		applicationId: string,
		input: AttemptInput,
	): Promise<string> {
		return this.db.transaction(async (tx) => {
			await this.lockOwned(tx, userId, applicationId);
			return this.insertStop(tx, userId, applicationId, input, "dry_run");
		});
	},

	async handOverStuck(userId: string, before: Date): Promise<string[]> {
		const stuck = await this.db
			.select({ id: applications.id })
			.from(applications)
			.where(
				and(
					eq(applications.userId, userId),
					eq(applications.state, "applying"),
					sql`${applications.stateChangedAt} < ${before}`,
				),
			);
		const handed: string[] = [];
		for (const { id } of stuck) {
			if (await this.resolveInterrupted(userId, id)) {
				handed.push(id);
				continue;
			}
			const moved = await this.db.transaction(async (tx) => {
				const row = await this.lockOwned(tx, userId, id);
				if (row.state !== "applying") return false;
				const reason =
					"The submission run ended before it was cleared to submit (the worker stopped). Nothing was submitted.";
				await this.insertStop(
					tx,
					userId,
					id,
					{ board: "", url: "", screenshotKey: null, reason, proof: {} },
					"not_sent",
				);
				return this.move(
					userId,
					id,
					["applying"],
					"needs_human",
					reason,
					"workflow",
					{},
					tx,
				);
			});
			if (moved) handed.push(id);
		}
		return handed;
	},
} satisfies Record<string, unknown> &
	ThisType<DrizzlePipelineRepositoryContext>;
